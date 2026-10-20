// A loopback fake of the two Driggsby endpoints the import command uses:
// the raw upload (POST /statement-imports) and the CLI-only tools on /mcp.
// Tests script both and read back what the command sent.
import { createServer, type Server } from "node:http";

export interface UploadSeen {
  headers: Record<string, string | string[] | undefined>;
  bytes: Buffer;
}

export interface ToolSeen {
  name: string;
  arguments: Record<string, unknown>;
}

// drop: the connection closes with no answer, as a network failure would;
// http: a bare error status, as from a proxy in front of Driggsby.
export type ToolAnswer =
  | { ok: unknown }
  | { refused: string; details?: Record<string, unknown> }
  | { rpcError: string }
  | { drop: true }
  | { http: number };

export interface FakeDriggsby {
  baseUrl: string;
  uploads: UploadSeen[];
  tools: ToolSeen[];
  close: () => Promise<void>;
}

export async function startFakeDriggsby(handlers: {
  upload?: (seen: UploadSeen) => { status: number; payload: unknown };
  tool?: (seen: ToolSeen) => ToolAnswer;
}): Promise<FakeDriggsby> {
  const uploads: UploadSeen[] = [];
  const tools: ToolSeen[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const send = (status: number, payload: unknown): void => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (request.url === "/statement-imports") {
        const seen = { headers: { ...request.headers }, bytes: body };
        uploads.push(seen);
        const answer = handlers.upload?.(seen) ?? { status: 500, payload: {} };
        send(answer.status, answer.payload);
        return;
      }
      const rpc = JSON.parse(body.toString("utf8")) as { id: number; params: { name: string; arguments: Record<string, unknown> } };
      const seen = { name: rpc.params.name, arguments: rpc.params.arguments };
      tools.push(seen);
      const answer = handlers.tool?.(seen) ?? { rpcError: "That tool isn't available from the Driggsby CLI." };
      if ("drop" in answer) {
        request.socket.destroy();
        return;
      }
      if ("http" in answer) {
        send(answer.http, {});
        return;
      }
      if ("rpcError" in answer) {
        send(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: answer.rpcError } });
        return;
      }
      const structured = "ok" in answer ? answer.ok : { error: answer.refused, ...(answer.details ?? {}) };
      send(200, {
        jsonrpc: "2.0",
        id: rpc.id,
        result: { structuredContent: structured, isError: !("ok" in answer), content: [{ type: "text", text: JSON.stringify(structured) }] },
      });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no port");
  }
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    uploads,
    tools,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

// An import as Driggsby describes it, with made-up defaults.
export function importView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    import_ref: "imp_7kq2mxa9p4bz",
    file: "made-up-export.csv",
    state: "reading",
    lines: 412,
    bytes: 38_000,
    started_at: "2026-10-19T15:00:00Z",
    finished_at: null,
    undone_at: null,
    account: null,
    new_account: false,
    counts: null,
    dates: null,
    left_out: null,
    nothing_new: null,
    categorized: null,
    question: null,
    progress: null,
    stopped: null,
    ...overrides,
  };
}

export const LANDED = {
  account: { label: "Northwind Pay ••2222", ref: "acct_made_up" },
  counts: { new: 398, already_in_driggsby: 14, pending: 0 },
  dates: { from: "2026-06-01", to: "2026-10-15" },
  left_out: { not_posted: 1, unreadable: 0, balance: 1 },
};
