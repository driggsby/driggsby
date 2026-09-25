// The tool-call broker: the only place `driggsby dev` talks to Driggsby.
// It holds the app token in the CLI process (never in page HTML), calls the
// Driggsby MCP endpoint, and hands the host page a plain
// { ok, result | error } envelope. Bounds mirror the production host: two
// calls in flight, a bounded queue, a hard per-call timeout, and (for the
// preview) the host's retries by kind of failure, so a preview loads the
// way the deployed app would and a buggy app can hammer its own laptop but
// never Driggsby.
import { capForTerminal, sanitizeForTerminal } from "../terminal-text.ts";
import { type BrokerResult, GENERIC_TOOL_TROUBLE } from "./dev-servers.ts";
import {
  httpRetryHint,
  refusalKind,
  refusalRetryHint,
  RETRY_LIMITS,
  type RetryHint,
  retryDelayMs,
} from "./retry-policy.ts";

export const MAX_IN_FLIGHT_CALLS = 2;
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
  // true (the preview): retry failures the way the production host does
  // (retry-policy.ts). Off by default, so a one-off command answers at once.
  retries?: boolean;
  // Tests replace the retry wait and its jitter.
  wait?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}

interface QueuedCall {
  tool: string;
  argumentsObject: Record<string, unknown>;
  // Retries already made.
  attempt: number;
  // The broker's epoch when the call arrived; dropPending() moves on.
  epoch: number;
  resolve: (result: BrokerResult) => void;
  reject: (error: unknown) => void;
}

interface CallOutcome {
  result: BrokerResult;
  retry: RetryHint | null;
}

// One broker per `driggsby dev` run (or per `driggsby query`). With the
// default transportErrors, runToolCall never rejects — every failure
// becomes an { ok: false } envelope with a person-readable message.
export class McpBroker {
  private readonly options: BrokerOptions;
  private readonly queue: QueuedCall[] = [];
  // Calls waiting out a retry delay, outside the queue until it's over.
  private readonly waiting = new Set<QueuedCall>();
  private inFlight = 0;
  private nextRequestId = 1;
  private closed = false;
  private epoch = 0;

  constructor(options: BrokerOptions) {
    this.options = options;
  }

  async runToolCall(
    tool: string,
    argumentsObject: Record<string, unknown>,
  ): Promise<BrokerResult> {
    if (this.closed || this.queue.length + this.waiting.size >= MAX_QUEUED_CALLS) {
      return { ok: false, error: { message: GENERIC_TOOL_TROUBLE } };
    }
    return await new Promise<BrokerResult>((resolve, reject) => {
      this.queue.push({ tool, argumentsObject, attempt: 0, epoch: this.epoch, resolve, reject });
      this.pump();
    });
  }

  // The page reloaded (a file changed): calls still queued or waiting to
  // retry belong to the old document, so they're answered now instead of
  // run, like the production host clearing its queue. A call already in
  // flight gets its answer but is never retried.
  dropPending(): void {
    this.epoch += 1;
    for (const call of [...this.queue, ...this.waiting]) {
      call.resolve({ ok: false, error: { message: GENERIC_TOOL_TROUBLE } });
    }
    this.queue.length = 0;
    this.waiting.clear();
  }

  // The preview is stopping: pending calls are answered and no new
  // request starts.
  close(): void {
    this.closed = true;
    this.dropPending();
  }

  private pump(): void {
    while (!this.closed && this.inFlight < MAX_IN_FLIGHT_CALLS) {
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
    let outcome: CallOutcome;
    try {
      outcome = await this.callMcp(call.tool, call.argumentsObject);
    } catch (error) {
      if (this.options.transportErrors === "throw") {
        call.reject(error);
        return;
      }
      outcome = { ...failed(GENERIC_TOOL_TROUBLE), retry: { kind: "transport", afterMs: null } };
    }
    const current = !this.closed && call.epoch === this.epoch;
    const retry = this.options.retries === true && current ? outcome.retry : null;
    if (retry !== null && call.attempt < RETRY_LIMITS[retry.kind]) {
      this.retryLater(call, retry, outcome.result);
      return;
    }
    call.resolve(outcome.result);
  }

  // A call waiting to retry gives up its slot and rejoins the back of the
  // queue when its wait is over. If the queue is full by then, it keeps the
  // answer it has; if the pending calls were dropped or the broker closed
  // meanwhile, that already answered it.
  private retryLater(call: QueuedCall, retry: RetryHint, answer: BrokerResult): void {
    const delay = retryDelayMs(call.attempt, retry.afterMs, this.options.random);
    call.attempt += 1;
    this.waiting.add(call);
    void (this.options.wait ?? sleep)(delay).then(() => {
      if (!this.waiting.delete(call)) {
        return;
      }
      if (this.queue.length >= MAX_QUEUED_CALLS) {
        call.resolve(answer);
        return;
      }
      this.queue.push(call);
      this.pump();
    });
  }

  private async callMcp(
    tool: string,
    argumentsObject: Record<string, unknown>,
  ): Promise<CallOutcome> {
    const toolArguments: Record<string, unknown> = { ...argumentsObject };
    if (typeof toolArguments.reason !== "string" || toolArguments.reason.trim() === "") {
      toolArguments.reason = this.options.defaultReason ?? DEFAULT_REASON;
    }
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;

    const doFetch = this.options.fetchImplementation ?? fetch;
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? TOOL_CALL_TIMEOUT_MS);
    // Our own timeout is retried once, like a server timeout; any other
    // failure to get an answer is retried as a failed request.
    const cutOff = (): RetryHint => ({ kind: signal.aborted ? "timeout" : "transport", afterMs: null });
    let response: Response;
    try {
      // Bare headers on purpose: the Driggsby endpoint refuses anything that
      // looks like a browser call (an Origin or Sec-Fetch-Site header), and
      // Node's fetch sends neither on its own.
      response = await doFetch(new URL("/mcp", this.options.baseUrl), {
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
        signal,
      });
    } catch (error) {
      if (this.options.transportErrors === "throw") {
        throw error;
      }
      return { ...failed(GENERIC_TOOL_TROUBLE), retry: cutOff() };
    }

    if (response.status === 401) {
      return failed(this.options.signInAgainMessage ?? SIGN_IN_AGAIN_MESSAGE);
    }
    if (!response.ok) {
      return { ...failed(GENERIC_TOOL_TROUBLE), retry: httpRetryHint(response.status, response.headers.get("Retry-After")) };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      // A body that isn't JSON would come back the same; a read cut off by
      // the timeout or a dropped connection may not.
      return { ...failed(GENERIC_TOOL_TROUBLE), retry: error instanceof SyntaxError ? null : cutOff() };
    }
    return interpretJsonRpc(payload);
  }
}

function failed(message: string): CallOutcome {
  return { result: { ok: false, error: { message } }, retry: null };
}

// Unref'd: a retry's wait never keeps a stopped preview's process alive.
async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds).unref();
  });
}

// The Driggsby MCP endpoint answers in JSON-RPC 2.0. Three shapes matter:
// a protocol-level error ({ error: { message } }), a tool-level refusal
// (result.isError true, message in content[0].text), and success
// (result.structuredContent is the data the app's watch callback gets). A
// refusal the service marks retryable carries its kind and retry hint in
// structuredContent.
function interpretJsonRpc(payload: unknown): CallOutcome {
  if (typeof payload !== "object" || payload === null) {
    return failed(GENERIC_TOOL_TROUBLE);
  }
  const envelope = payload as Record<string, unknown>;

  const error = envelope.error;
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>).message;
    return failed(typeof message === "string" ? capMessage(message) : GENERIC_TOOL_TROUBLE);
  }

  const result = envelope.result;
  if (typeof result !== "object" || result === null) {
    return failed(GENERIC_TOOL_TROUBLE);
  }
  const resultRecord = result as Record<string, unknown>;
  if (resultRecord.isError === true) {
    // A known kind reaches the app even when it isn't worth retrying (a
    // daily limit), as the production host forwards it.
    const kind = refusalKind(resultRecord.structuredContent);
    const message = toolRefusalMessage(resultRecord);
    return {
      result: { ok: false, error: kind === null ? { message } : { message, kind } },
      retry: refusalRetryHint(resultRecord.structuredContent),
    };
  }
  return { result: { ok: true, result: resultRecord.structuredContent ?? null }, retry: null };
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

// The server's own error text is hostile input on every path that shows it
// (a terminal for `query`, a page for `dev`): strip control and bidi bytes
// and cap the length in one place, so no caller has to remember to.
function capMessage(message: string): string {
  const clean = sanitizeForTerminal(message);
  // Text that was nothing but invisible code points sanitizes to nothing;
  // a blank error helps nobody.
  if (clean.trim() === "") {
    return GENERIC_TOOL_TROUBLE;
  }
  return clean.length > MAX_ERROR_MESSAGE_CHARS ? `${capForTerminal(clean, MAX_ERROR_MESSAGE_CHARS)}…` : clean;
}
