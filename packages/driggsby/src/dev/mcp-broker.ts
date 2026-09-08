// The tool-call broker: the only place `driggsby dev` talks to Driggsby.
// It holds the app token in the CLI process (never in page HTML), calls the
// Driggsby MCP endpoint, and hands the host page a plain
// { ok, result | error } envelope. Bounds mirror the production host: a few
// calls in flight, a bounded queue, and a hard per-call timeout, so a
// buggy app can hammer its own laptop but never Driggsby.
import { type BrokerResult, GENERIC_TOOL_TROUBLE } from "./dev-servers.ts";

export const MAX_IN_FLIGHT_CALLS = 4;
export const MAX_QUEUED_CALLS = 64;
export const TOOL_CALL_TIMEOUT_MS = 30_000;
// Server-supplied error text is untrusted; it reaches the page's console,
// so it gets a hard length cap like every other untrusted string we relay.
export const MAX_ERROR_MESSAGE_CHARS = 500;

export const SIGN_IN_AGAIN_MESSAGE =
  "Your sign-in on this machine isn't valid anymore. In this app's folder, run: npx driggsby@latest login — then reload this page.";

// Sent when an app doesn't provide its own reason. The Driggsby MCP
// endpoint requires a short reason on most read tools; a locally previewed
// dashboard has exactly one.
const DEFAULT_REASON = "Rendering this data in the developer's own Driggsby app preview.";

export interface BrokerOptions {
  baseUrl: string;
  token: string;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
  // The reason sent when a call gives none; the dev preview's by default.
  defaultReason?: string;
  // What a 401 reads as; the dev preview's "reload this page" by default.
  signInAgainMessage?: string;
  // "envelope" (default): a connection failure becomes an { ok: false }
  // envelope, so a page never sees a rejection. "throw": it rejects
  // runToolCall instead, so a CLI command can name the host to allow.
  transportErrors?: "envelope" | "throw";
}

interface QueuedCall {
  tool: string;
  argumentsObject: Record<string, unknown>;
  resolve: (result: BrokerResult) => void;
  reject: (error: unknown) => void;
}

// One broker per `driggsby dev` run (or per `driggsby query`). With the
// default transportErrors, runToolCall never rejects — every failure
// becomes an { ok: false } envelope with a person-readable message.
export class McpBroker {
  private readonly options: BrokerOptions;
  private readonly queue: QueuedCall[] = [];
  private inFlight = 0;
  private nextRequestId = 1;

  constructor(options: BrokerOptions) {
    this.options = options;
  }

  async runToolCall(
    tool: string,
    argumentsObject: Record<string, unknown>,
  ): Promise<BrokerResult> {
    if (this.queue.length >= MAX_QUEUED_CALLS) {
      return { ok: false, error: { message: GENERIC_TOOL_TROUBLE } };
    }
    return await new Promise<BrokerResult>((resolve, reject) => {
      this.queue.push({ tool, argumentsObject, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    while (this.inFlight < MAX_IN_FLIGHT_CALLS) {
      const call = this.queue.shift();
      if (call === undefined) {
        return;
      }
      this.inFlight += 1;
      void this.execute(call).finally(() => {
        this.inFlight -= 1;
        this.pump();
      });
    }
  }

  private async execute(call: QueuedCall): Promise<void> {
    let result: BrokerResult;
    try {
      result = await this.callMcp(call.tool, call.argumentsObject);
    } catch (error) {
      if (this.options.transportErrors === "throw") {
        call.reject(error);
        return;
      }
      result = { ok: false, error: { message: GENERIC_TOOL_TROUBLE } };
    }
    call.resolve(result);
  }

  private async callMcp(
    tool: string,
    argumentsObject: Record<string, unknown>,
  ): Promise<BrokerResult> {
    const toolArguments: Record<string, unknown> = { ...argumentsObject };
    if (typeof toolArguments.reason !== "string" || toolArguments.reason.trim() === "") {
      toolArguments.reason = this.options.defaultReason ?? DEFAULT_REASON;
    }
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;

    const doFetch = this.options.fetchImplementation ?? fetch;
    // Bare headers on purpose: the Driggsby endpoint refuses anything that
    // looks like a browser call (an Origin or Sec-Fetch-Site header), and
    // Node's fetch sends neither on its own.
    const response = await doFetch(new URL("/mcp", this.options.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "tools/call",
        params: { name: tool, arguments: toolArguments },
      }),
      // The bearer token must never travel to a redirect target, and tool
      // results must never come from one either.
      redirect: "error",
      signal: AbortSignal.timeout(this.options.timeoutMs ?? TOOL_CALL_TIMEOUT_MS),
    });

    if (response.status === 401) {
      return { ok: false, error: { message: this.options.signInAgainMessage ?? SIGN_IN_AGAIN_MESSAGE } };
    }
    if (!response.ok) {
      return { ok: false, error: { message: GENERIC_TOOL_TROUBLE } };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, error: { message: GENERIC_TOOL_TROUBLE } };
    }
    return interpretJsonRpc(payload);
  }
}

// The Driggsby MCP endpoint answers in JSON-RPC 2.0. Three shapes matter:
// a protocol-level error ({ error: { message } }), a tool-level refusal
// (result.isError true, message in content[0].text), and success
// (result.structuredContent is the data the app's watch callback gets).
function interpretJsonRpc(payload: unknown): BrokerResult {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, error: { message: GENERIC_TOOL_TROUBLE } };
  }
  const envelope = payload as Record<string, unknown>;

  const error = envelope.error;
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>).message;
    return {
      ok: false,
      error: { message: typeof message === "string" ? capMessage(message) : GENERIC_TOOL_TROUBLE },
    };
  }

  const result = envelope.result;
  if (typeof result !== "object" || result === null) {
    return { ok: false, error: { message: GENERIC_TOOL_TROUBLE } };
  }
  const resultRecord = result as Record<string, unknown>;
  if (resultRecord.isError === true) {
    return { ok: false, error: { message: toolRefusalMessage(resultRecord) } };
  }
  return { ok: true, result: resultRecord.structuredContent ?? null };
}

function toolRefusalMessage(resultRecord: Record<string, unknown>): string {
  const content = resultRecord.content;
  if (Array.isArray(content)) {
    const first = content[0] as unknown;
    if (typeof first === "object" && first !== null) {
      const text = (first as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim() !== "") {
        return capMessage(text);
      }
    }
  }
  return GENERIC_TOOL_TROUBLE;
}

function capMessage(message: string): string {
  return message.length > MAX_ERROR_MESSAGE_CHARS
    ? `${message.slice(0, MAX_ERROR_MESSAGE_CHARS)}…`
    : message;
}
