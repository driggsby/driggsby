// The small part of MCP a Claude Code channel needs, over stdio: one
// JSON-RPC message per line. It answers the handshake and ping, refuses
// every other request, and sends notifications. Claude Code first offers
// protocol revision 2026-07-28 (server/discover); a channel on that
// revision can't deliver events, so that request is refused like any
// other and Claude Code falls back to initialize.
import type { Readable } from "node:stream";

// Revisions this server speaks, newest first. 2026-07-28 is left out on
// purpose: Claude Code won't register a channel on it.
const PROTOCOL_VERSIONS: readonly string[] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
// Claude Code's messages are small; a longer line is dropped unread.
export const MAX_LINE_BYTES = 1024 * 1024;
const METHOD_NOT_FOUND = -32601;

type RequestId = string | number;

export interface ChannelRpcOptions {
  input: Readable;
  write: (line: string) => void;
  version: string;
  // What initialize answers with besides the revision and server name.
  initializeResult: () => Record<string, unknown>;
  // Claude Code has finished the handshake; notifications may follow.
  onInitialized: () => void;
}

export class ChannelRpc {
  readonly closed: Promise<void>;
  private readonly options: ChannelRpcOptions;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private skipping = false;
  private initialized = false;

  constructor(options: ChannelRpcOptions) {
    this.options = options;
    this.closed = new Promise((resolve) => {
      options.input.on("end", resolve);
      options.input.on("close", resolve);
      options.input.on("error", resolve);
    });
    options.input.on("data", (chunk: Buffer | string) => {
      this.receive(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: Record<string, unknown>): void {
    this.options.write(`${JSON.stringify(message)}\n`);
  }

  private receive(chunk: Buffer): void {
    let rest = chunk;
    for (let newline = rest.indexOf(0x0a); newline !== -1; newline = rest.indexOf(0x0a)) {
      const piece = rest.subarray(0, newline);
      rest = rest.subarray(newline + 1);
      if (!this.skipping && this.pendingBytes + piece.length <= MAX_LINE_BYTES) {
        this.handleLine(Buffer.concat([...this.pending, piece]).toString("utf8"));
      }
      this.pending = [];
      this.pendingBytes = 0;
      this.skipping = false;
    }
    if (this.skipping || rest.length === 0) {
      return;
    }
    if (this.pendingBytes + rest.length > MAX_LINE_BYTES) {
      this.pending = [];
      this.pendingBytes = 0;
      this.skipping = true;
      return;
    }
    this.pending.push(Buffer.from(rest));
    this.pendingBytes += rest.length;
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return;
    }
    const message = parsed as Record<string, unknown>;
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return;
    }
    if (!("id" in message)) {
      if (message.method === "notifications/initialized" && !this.initialized) {
        this.initialized = true;
        this.options.onInitialized();
      }
      return;
    }
    const id = message.id;
    if (typeof id !== "string" && typeof id !== "number") {
      return;
    }
    this.answer(id, message.method, message.params);
  }

  private answer(id: RequestId, method: string, params: unknown): void {
    if (method === "initialize") {
      this.send({ jsonrpc: "2.0", id, result: this.initializeResult(params) });
    } else if (method === "ping") {
      this.send({ jsonrpc: "2.0", id, result: {} });
    } else {
      this.send({ jsonrpc: "2.0", id, error: { code: METHOD_NOT_FOUND, message: "Method not found" } });
    }
  }

  private initializeResult(params: unknown): Record<string, unknown> {
    const asked = typeof params === "object" && params !== null ? (params as Record<string, unknown>).protocolVersion : undefined;
    const protocolVersion = typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
    const { capabilities, instructions } = this.options.initializeResult();
    return {
      protocolVersion,
      capabilities,
      serverInfo: { name: "driggsby", version: this.options.version },
      ...(instructions === undefined ? {} : { instructions }),
    };
  }
}
