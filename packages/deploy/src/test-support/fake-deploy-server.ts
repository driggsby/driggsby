// A loopback fake of the Driggsby deploy API for protocol tests: stateful
// enough to run a whole deploy (manifest -> blobs -> finalize -> versions ->
// set live), with one-shot response injection for error paths. Never used
// outside tests.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

interface InjectedResponse {
  method: string;
  pathIncludes: string;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface FakeVersion {
  id: string;
  slug: string;
  number: number;
  files: { path: string; sha256: string; byte_size: number }[];
  status: "uploading" | "ready";
  createdAt: string;
}

export interface FakeDeployServer {
  baseUrl: string;
  requests: RecordedRequest[];
  // Pre-store a blob so a redeploy sees it as already uploaded.
  seedBlob(bytes: Buffer): void;
  // Queue a one-shot response for the next matching request.
  injectResponse(
    method: string,
    pathIncludes: string,
    status: number,
    body: unknown,
    headers?: Record<string, string>,
  ): void;
  liveVersionNumber(slug: string): number | null;
  close(): Promise<void>;
}

export async function startFakeDeployServer(): Promise<FakeDeployServer> {
  const requests: RecordedRequest[] = [];
  const injected: InjectedResponse[] = [];
  let createdAppCount = 0;
  const blobs = new Map<string, Buffer>();
  const versions = new Map<string, FakeVersion>();
  const liveBySlug = new Map<string, number>();
  const nextVersionNumberBySlug = new Map<string, number>();

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const method = request.method ?? "";
      const path = request.url ?? "";
      requests.push({ method, path, headers: request.headers, body });

      const injectedIndex = injected.findIndex(
        (entry) => entry.method === method && path.includes(entry.pathIncludes),
      );
      if (injectedIndex !== -1) {
        const entry = injected[injectedIndex];
        injected.splice(injectedIndex, 1);
        if (entry !== undefined) {
          for (const [name, value] of Object.entries(entry.headers ?? {})) {
            response.setHeader(name, value);
          }
          respondJson(response, entry.status, entry.body);
          return;
        }
      }
      handle(method, path, body, response);
    });
  });

  function handle(method: string, path: string, body: Buffer, response: ServerResponse): void {
    // App creation with a server-assigned slug: the readable base name plus
    // a unique 6-char ending, mirroring the real API. (Unlike the real API,
    // version posts below auto-create unknown apps — that keeps the many
    // protocol tests terse; tests exercising the creation flow inject an
    // app_not_found response for the first version post instead.)
    if (path === "/deploy/apps" && method === "POST") {
      const parsed = JSON.parse(body.toString("utf8")) as { base_name?: unknown };
      const base = typeof parsed.base_name === "string" ? parsed.base_name : "";
      createdAppCount += 1;
      // The real API caps long bases at 56 characters (trimming trailing
      // dashes) before adding the ending, so every assigned slug fits the
      // 63-character DNS label limit; model that here so tests see the
      // slugs clients actually receive.
      const cappedBase = base.slice(0, 56).replace(/-+$/, "");
      const assigned = `${cappedBase}-${String(createdAppCount).padStart(6, "0")}`;
      respondJson(response, 201, {
        app_slug: assigned,
        url: `https://${assigned}.driggsby.dev`,
        next_step: `Save the app_slug — every deploy targets it. Then POST /deploy/apps/${assigned}/versions with this app's file manifest.`,
      });
      return;
    }

    const manifestMatch = /^\/deploy\/apps\/([^/]+)\/versions$/.exec(path);
    if (manifestMatch !== null && method === "POST") {
      const slug = manifestMatch[1] ?? "";
      const parsed = JSON.parse(body.toString("utf8")) as {
        files: { path: string; sha256: string; byte_size: number }[];
      };
      const number = nextVersionNumberBySlug.get(slug) ?? 1;
      nextVersionNumberBySlug.set(slug, number + 1);
      const id = `version-${slug}-${number}`;
      versions.set(id, {
        id,
        slug,
        number,
        files: parsed.files,
        status: "uploading",
        createdAt: "2026-08-21T17:04:00.000Z",
      });
      const missing = [...new Set(parsed.files.map((file) => file.sha256))].filter(
        (sha) => !blobs.has(sha),
      );
      respondJson(response, 201, {
        version_id: id,
        version_number: number,
        app_slug: slug,
        missing_blob_sha256s: missing,
        next_step: "PUT each missing file's raw bytes, then finalize.",
      });
      return;
    }

    const blobMatch = /^\/deploy\/blobs\/([0-9a-fA-F]{64})$/.exec(path);
    if (blobMatch !== null && method === "PUT") {
      const sha = (blobMatch[1] ?? "").toLowerCase();
      const actual = createHash("sha256").update(body).digest("hex");
      if (actual !== sha) {
        respondJson(response, 422, {
          error: "content_mismatch",
          error_description: "The uploaded bytes don't match the expected hash.",
        });
        return;
      }
      blobs.set(sha, body);
      respondJson(response, 200, { sha256: sha, byte_size: body.byteLength });
      return;
    }

    const finalizeMatch = /^\/deploy\/versions\/([^/]+)\/finalize$/.exec(path);
    if (finalizeMatch !== null && method === "POST") {
      const version = versions.get(finalizeMatch[1] ?? "");
      if (version === undefined) {
        respondJson(response, 404, {
          error: "not_found",
          error_description: "That version doesn't exist.",
        });
        return;
      }
      const missing = [...new Set(version.files.map((file) => file.sha256))].filter(
        (sha) => !blobs.has(sha),
      );
      if (missing.length > 0) {
        respondJson(response, 409, {
          error: "blobs_missing",
          error_description: `${missing.length} file(s) haven't been uploaded yet.`,
          missing_blob_sha256s: missing,
        });
        return;
      }
      const parsed = body.byteLength === 0 ? {} : (JSON.parse(body.toString("utf8")) as { live?: unknown });
      const live = parsed.live !== false;
      version.status = "ready";
      if (live) {
        liveBySlug.set(version.slug, version.number);
      }
      const nowLive = liveBySlug.get(version.slug) === version.number;
      respondJson(response, 200, {
        app_slug: version.slug,
        version_number: version.number,
        live: nowLive,
        url: nowLive ? `https://${version.slug}.driggsby.dev` : null,
        console_url: consoleUrlFor(version.slug),
      });
      return;
    }

    const listMatch = /^\/deploy\/apps\/([^/]+)\/versions$/.exec(path);
    if (listMatch !== null && method === "GET") {
      const slug = listMatch[1] ?? "";
      const forSlug = [...versions.values()]
        .filter((version) => version.slug === slug)
        .sort((a, b) => b.number - a.number);
      respondJson(response, 200, {
        app_slug: slug,
        url: `https://${slug}.driggsby.dev`,
        live_version_number: liveBySlug.get(slug) ?? null,
        versions: forSlug.map((version) => ({
          version_id: version.id,
          number: version.number,
          status: version.status,
          live: liveBySlug.get(slug) === version.number,
          file_count: version.files.length,
          total_bytes: version.files.reduce((sum, file) => sum + file.byte_size, 0),
          created_at: version.createdAt,
        })),
      });
      return;
    }

    const liveMatch = /^\/deploy\/apps\/([^/]+)\/live-version$/.exec(path);
    if (liveMatch !== null && method === "POST") {
      const slug = liveMatch[1] ?? "";
      const parsed = JSON.parse(body.toString("utf8")) as { version_number?: unknown };
      const target = [...versions.values()].find(
        (version) =>
          version.slug === slug &&
          version.number === parsed.version_number &&
          version.status === "ready",
      );
      if (target === undefined) {
        respondJson(response, 404, {
          error: "not_found",
          error_description: "That version can't be made live.",
        });
        return;
      }
      liveBySlug.set(slug, target.number);
      respondJson(response, 200, {
        app_slug: slug,
        version_number: target.number,
        live: true,
        url: `https://${slug}.driggsby.dev`,
        console_url: consoleUrlFor(slug),
      });
      return;
    }

    respondJson(response, 404, { error: "not_found", error_description: "No such route." });
  }

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake deploy server has no port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    seedBlob(bytes: Buffer) {
      blobs.set(createHash("sha256").update(bytes).digest("hex"), bytes);
    },
    injectResponse(
      method: string,
      pathIncludes: string,
      status: number,
      body: unknown,
      headers?: Record<string, string>,
    ) {
      injected.push({ method, pathIncludes, status, body, ...(headers === undefined ? {} : { headers }) });
    },
    liveVersionNumber(slug: string) {
      return liveBySlug.get(slug) ?? null;
    },
    close: () => closeServer(server),
  };
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

// The real server hands back the page for the app inside Driggsby on every
// finalize and set-live answer, live or not; the fake does the same.
function consoleUrlFor(slug: string): string {
  return `https://app.driggsby.test/dashboards/${slug}`;
}
