// The deploy API protocol client: one function per endpoint, exact request
// shapes, fail-closed response parsing. Every request carries the app token,
// so redirects are always refused — the token goes to the configured API
// origin and nowhere else.
import { DeployApiError, DeployError } from "./errors.ts";
import { slugProblem } from "./limits.ts";

export interface DeployApi {
  baseUrl: string;
  token: string;
  // Optional override for every request's timeout, in milliseconds. When
  // absent, JSON calls get 30 seconds and blob uploads get 5 minutes.
  requestTimeoutMs?: number;
}

const JSON_REQUEST_TIMEOUT_MS = 30_000;
// Blob uploads carry up to 25 MB, which legitimately takes minutes on a
// slow link; the timeout exists so a stalled connection fails with a clear
// signal instead of hanging indefinitely.
const BLOB_UPLOAD_TIMEOUT_MS = 300_000;
// Every endpoint answers with a small JSON object; anything enormous is not
// a real Driggsby response. The cap bounds what gets parsed and surfaced,
// not what the network buffers — the request timeout bounds that. Same
// treatment as the CLI's sign-in client.
const MAX_RESPONSE_BODY_CHARS = 1_000_000;

export interface ManifestFile {
  path: string;
  sha256: string;
  byteSize: number;
}

export interface CreatedVersion {
  versionId: string;
  versionNumber: number;
  appSlug: string;
  missingBlobSha256s: string[];
}

export interface FinalizedVersion {
  kind: "finalized";
  appSlug: string;
  versionNumber: number;
  live: boolean;
  url: string | null;
}

export interface BlobsMissing {
  kind: "blobs-missing";
  missingBlobSha256s: string[];
}

export interface VersionSummary {
  versionId: string;
  number: number;
  status: "uploading" | "ready";
  live: boolean;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
}

export interface VersionList {
  appSlug: string;
  url: string;
  liveVersionNumber: number | null;
  versions: VersionSummary[];
}

const UNEXPECTED_RESPONSE_MESSAGE =
  "The Driggsby deploy API sent a response we didn't recognize. Please try\n" +
  "again in a minute.";

export interface CreatedApp {
  appSlug: string;
  url: string;
}

// Creates the app itself. The server assigns the final slug — the readable
// base name passed here plus a unique ending — and every later deploy
// targets that assigned slug, so callers must persist it (in driggsby.json)
// before uploading anything. The request field is base_name, not slug: the
// two are different values on the two sides of this round trip, and the API
// keeps them visibly distinct.
export async function createApp(
  api: DeployApi,
  baseName: string,
  appName?: string,
): Promise<CreatedApp> {
  const body: Record<string, unknown> = { base_name: baseName };
  if (appName !== undefined) {
    body.app_name = appName;
  }
  const parsed = await requestJson(api, "POST", "/deploy/apps", {
    json: body,
    expectedStatus: 201,
  });
  const appSlug = stringField(parsed, "app_slug");
  // The assigned slug gets written into driggsby.json and reused as a URL
  // path segment, so it is shape-validated like every other server field —
  // a malformed answer must fail here, never land on disk.
  if (slugProblem(appSlug) !== null) {
    throw new DeployError(UNEXPECTED_RESPONSE_MESSAGE);
  }
  return { appSlug, url: stringField(parsed, "url") };
}

// app_name here is NOT a leftover of the old create-by-deploy flow: the
// server intentionally keeps rename-on-redeploy, applying a sent app_name
// to the existing app once the deploy is accepted.
export async function createVersion(
  api: DeployApi,
  slug: string,
  files: ManifestFile[],
  appName?: string,
): Promise<CreatedVersion> {
  const body: Record<string, unknown> = {
    files: files.map((file) => ({ path: file.path, sha256: file.sha256, byte_size: file.byteSize })),
  };
  if (appName !== undefined) {
    body.app_name = appName;
  }
  const parsed = await requestJson(api, "POST", `/deploy/apps/${encodeURIComponent(slug)}/versions`, {
    json: body,
    expectedStatus: 201,
  });
  const versionId = stringField(parsed, "version_id");
  const versionNumber = integerField(parsed, "version_number");
  const appSlug = stringField(parsed, "app_slug");
  const missing = stringArrayField(parsed, "missing_blob_sha256s");
  return { versionId, versionNumber, appSlug, missingBlobSha256s: missing };
}

export async function uploadBlob(
  api: DeployApi,
  sha256: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  const path = `/deploy/blobs/${encodeURIComponent(sha256)}`;
  if (signal === undefined) {
    await requestJson(api, "PUT", path, { rawBody: bytes, expectedStatus: 200 });
    return;
  }
  // The caller's signal (the upload pool's) outlives this one request, so
  // the forwarding listener is detached once the request settles —
  // otherwise every upload in a large deploy would leave one listener
  // behind on the shared signal for the rest of the round.
  const scoped = new AbortController();
  const forward = (): void => {
    scoped.abort(signal.reason);
  };
  if (signal.aborted) {
    forward();
  } else {
    signal.addEventListener("abort", forward, { once: true });
  }
  try {
    await requestJson(api, "PUT", path, {
      rawBody: bytes,
      expectedStatus: 200,
      signal: scoped.signal,
    });
  } finally {
    signal.removeEventListener("abort", forward);
  }
}

export async function finalizeVersion(
  api: DeployApi,
  versionId: string,
  live: boolean,
): Promise<FinalizedVersion | BlobsMissing> {
  const response = await rawRequest(api, "POST", `/deploy/versions/${encodeURIComponent(versionId)}/finalize`, {
    json: live ? {} : { live: false },
  });
  if (response.status === 409) {
    const parsed = await parseJsonBody(response);
    if (typeof parsed === "object" && parsed !== null && errorCode(parsed) === "blobs_missing") {
      return {
        kind: "blobs-missing",
        missingBlobSha256s: stringArrayField(parsed as Record<string, unknown>, "missing_blob_sha256s"),
      };
    }
    throw apiErrorFrom(response, parsed);
  }
  const parsed = await expectStatus(response, 200);
  return parseFinalized(parsed);
}

export async function listVersions(api: DeployApi, slug: string): Promise<VersionList> {
  const parsed = await requestJson(api, "GET", `/deploy/apps/${encodeURIComponent(slug)}/versions`, {
    expectedStatus: 200,
  });
  const rawVersions = parsed.versions;
  if (!Array.isArray(rawVersions)) {
    throw new DeployError(UNEXPECTED_RESPONSE_MESSAGE);
  }
  const liveVersionNumber = parsed.live_version_number;
  return {
    appSlug: stringField(parsed, "app_slug"),
    url: stringField(parsed, "url"),
    liveVersionNumber:
      typeof liveVersionNumber === "number" && Number.isSafeInteger(liveVersionNumber)
        ? liveVersionNumber
        : null,
    versions: rawVersions.map((raw: unknown) => {
      if (typeof raw !== "object" || raw === null) {
        throw new DeployError(UNEXPECTED_RESPONSE_MESSAGE);
      }
      const record = raw as Record<string, unknown>;
      const status = record.status;
      if (status !== "uploading" && status !== "ready") {
        throw new DeployError(UNEXPECTED_RESPONSE_MESSAGE);
      }
      return {
        versionId: stringField(record, "version_id"),
        number: integerField(record, "number"),
        status,
        live: record.live === true,
        fileCount: integerField(record, "file_count"),
        totalBytes: integerField(record, "total_bytes"),
        createdAt: stringField(record, "created_at"),
      };
    }),
  };
}

export async function setLiveVersion(
  api: DeployApi,
  slug: string,
  versionNumber: number,
): Promise<FinalizedVersion> {
  const parsed = await requestJson(api, "POST", `/deploy/apps/${encodeURIComponent(slug)}/live-version`, {
    json: { version_number: versionNumber },
    expectedStatus: 200,
  });
  return parseFinalized(parsed);
}

interface RequestOptions {
  json?: unknown;
  rawBody?: Uint8Array;
  expectedStatus?: number;
  // A caller-owned cancellation signal (the upload pool aborting its
  // siblings after a failure). Combined with the per-request timeout.
  signal?: AbortSignal;
}

async function requestJson(
  api: DeployApi,
  method: string,
  path: string,
  options: RequestOptions,
): Promise<Record<string, unknown>> {
  const response = await rawRequest(api, method, path, options);
  return expectStatus(response, options.expectedStatus ?? 200);
}

async function rawRequest(
  api: DeployApi,
  method: string,
  path: string,
  options: RequestOptions,
): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${api.token}` };
  let body: string | Uint8Array | undefined;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.rawBody !== undefined) {
    headers["content-type"] = "application/octet-stream";
    body = options.rawBody;
  }
  const timeoutMs =
    api.requestTimeoutMs ??
    (options.rawBody === undefined ? JSON_REQUEST_TIMEOUT_MS : BLOB_UPLOAD_TIMEOUT_MS);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return fetch(`${api.baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    // The bearer token must never travel to a redirect target.
    redirect: "error",
    // A stalled connection fails as a TimeoutError instead of hanging; the
    // caller's own signal (if any) can also cancel the request early.
    signal:
      options.signal === undefined ? timeoutSignal : anyAbortSignal(options.signal, timeoutSignal),
  });
}

// AbortSignal.any needs Node 20.3+, and these packages support Node 18, so
// combine the two signals by hand. Each combined signal lives for one
// request; the reasons are forwarded so a timeout still reads as a
// TimeoutError.
function anyAbortSignal(first: AbortSignal, second: AbortSignal): AbortSignal {
  const controller = new AbortController();
  for (const signal of [first, second]) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener(
      "abort",
      () => {
        controller.abort(signal.reason);
      },
      { once: true, signal: controller.signal },
    );
  }
  return controller.signal;
}

async function expectStatus(response: Response, expected: number): Promise<Record<string, unknown>> {
  const parsed = await parseJsonBody(response);
  if (response.status !== expected) {
    throw apiErrorFrom(response, parsed);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new DeployError(UNEXPECTED_RESPONSE_MESSAGE);
  }
  return parsed as Record<string, unknown>;
}

async function parseJsonBody(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // A body that never finishes arriving surfaces here as the request
    // signal's TimeoutError. That is a stalled connection, not a malformed
    // body, so it must propagate to the network-failure guidance instead of
    // reading as an unrecognized response.
    const name = (error as { name?: unknown }).name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw error;
    }
    return null;
  }
  if (text.length > MAX_RESPONSE_BODY_CHARS) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function apiErrorFrom(response: Response, parsed: unknown): DeployApiError {
  const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
  if (typeof parsed === "object" && parsed !== null) {
    const code = errorCode(parsed);
    const description = (parsed as Record<string, unknown>).error_description;
    if (code !== null) {
      return new DeployApiError(
        response.status,
        code,
        typeof description === "string" ? description : "",
        retryAfterSeconds,
      );
    }
  }
  return new DeployApiError(
    response.status,
    "unexpected_response",
    UNEXPECTED_RESPONSE_MESSAGE,
    retryAfterSeconds,
  );
}

// Only the whole-seconds Retry-After form is honored; the HTTP-date form (or
// anything malformed) reads as "no header" and the caller uses its default.
function parseRetryAfterSeconds(header: string | null): number | null {
  if (header === null || !/^[0-9]+$/.test(header.trim())) {
    return null;
  }
  return Number.parseInt(header.trim(), 10);
}

function errorCode(parsed: object): string | null {
  const code = (parsed as Record<string, unknown>).error;
  return typeof code === "string" ? code : null;
}

function parseFinalized(parsed: Record<string, unknown>): FinalizedVersion {
  return {
    kind: "finalized",
    appSlug: stringField(parsed, "app_slug"),
    versionNumber: integerField(parsed, "version_number"),
    live: parsed.live === true,
    url: typeof parsed.url === "string" ? parsed.url : null,
  };
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new DeployError(UNEXPECTED_RESPONSE_MESSAGE);
  }
  return value;
}

// Every numeric field in the protocol is a count or a version number, so
// anything that isn't a plain exact integer is a malformed response — and
// rejecting it here keeps values like 1.79e308 from ever reaching a
// rendered table.
function integerField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DeployError(UNEXPECTED_RESPONSE_MESSAGE);
  }
  return value;
}

function stringArrayField(record: Record<string, unknown>, field: string): string[] {
  const value = record[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new DeployError(UNEXPECTED_RESPONSE_MESSAGE);
  }
  return value as string[];
}
