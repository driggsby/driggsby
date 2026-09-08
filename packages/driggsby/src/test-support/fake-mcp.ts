// A loopback fake of the Driggsby MCP endpoint for command and broker
// tests. `respond` decides each answer from the parsed JSON-RPC body.
import { createServer, type Server } from "node:http";

export interface RecordedRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface FakeMcp {
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

export async function startFakeMcp(
  respond: (body: Record<string, unknown>) => { status: number; payload: unknown },
): Promise<FakeMcp> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "not json" }));
        return;
      }
      requests.push({ headers: { ...request.headers }, body });
      const answer = respond(body);
      response.writeHead(answer.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(answer.payload));
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
    requests,
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

export function successEnvelope(
  body: Record<string, unknown>,
  structuredContent: unknown,
): { status: number; payload: unknown } {
  return {
    status: 200,
    payload: {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        structuredContent,
        isError: false,
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      },
    },
  };
}
