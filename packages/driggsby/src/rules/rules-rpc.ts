// The rules command's channel to Driggsby: one JSON-RPC POST to /mcp with
// the saved sign-in. Unlike the dev preview's broker, a tool refusal keeps
// its structured details (a blocking suggestion and its options, the
// overlapping rule), because an agent needs them to answer and save again.
import { CliError } from "../cli-error.ts";
import { type DeploySession, SIGN_IN_AGAIN_MESSAGE } from "../deploy/api-session.ts";
import { GENERIC_TOOL_TROUBLE } from "../dev/dev-servers.ts";
import { capForTerminal, sanitizeForTerminal } from "../terminal-text.ts";
import { RULE_ACTION_TOOLS } from "./rule-actions.ts";

// A preview replays the person's posted history; give it longer than a
// dashboard read gets.
export const RULES_CALL_TIMEOUT_MS = 60_000;
// Server messages are hostile text: sanitized and bounded before they reach
// the terminal. Generous, because a rule refusal explains itself.
const MAX_SERVER_MESSAGE_CHARS = 1_000;

export const RULES_NOT_AVAILABLE_MESSAGE =
  "This sign-in can't use transaction rules. Sign in again and approve the request:\n" +
  "  npx driggsby@latest login\n" +
  "If rules still aren't available after that, they aren't open to your account yet.";

export type RuleToolOutcome =
  | { kind: "ok"; result: unknown }
  | { kind: "refused"; message: string; details: unknown }
  | { kind: "error"; message: string };

export interface RuleToolDescription {
  name: string;
  title: string | null;
  description: string;
  inputSchema: unknown;
}

export async function callRuleTool(
  session: DeploySession,
  tool: string,
  toolArguments: Record<string, unknown>,
): Promise<RuleToolOutcome> {
  const payload = await postMcp(session, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: tool, arguments: toolArguments },
  });
  return interpretToolCall(payload);
}

// The rule tools' own descriptions and input schemas, from the tools/list
// this sign-in sees. None listed means the sign-in predates rules or rules
// aren't open to the account; either way the next step is the same.
export async function listRuleTools(session: DeploySession): Promise<RuleToolDescription[]> {
  const payload = await postMcp(session, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tools = asRecord(asRecord(payload)?.result)?.tools;
  if (!Array.isArray(tools)) {
    throw new CliError(GENERIC_TOOL_TROUBLE, 1);
  }
  const listed: unknown[] = tools;
  const wanted: ReadonlySet<string> = new Set(Object.values(RULE_ACTION_TOOLS));
  const found = listed.flatMap((tool: unknown): RuleToolDescription[] => {
    const record = asRecord(tool);
    if (
      record === null ||
      typeof record.name !== "string" ||
      !wanted.has(record.name) ||
      typeof record.description !== "string"
    ) {
      return [];
    }
    return [
      {
        name: record.name,
        title: typeof record.title === "string" ? record.title : null,
        description: record.description,
        inputSchema: record.inputSchema ?? null,
      },
    ];
  });
  if (found.length === 0) {
    throw new CliError(RULES_NOT_AVAILABLE_MESSAGE, 1);
  }
  return found;
}

// Three shapes: a protocol error ({ error: { message } }), a tool refusal
// (result.isError, details in structuredContent), and success.
export function interpretToolCall(payload: unknown): RuleToolOutcome {
  const envelope = asRecord(payload);
  if (envelope === null) {
    return { kind: "error", message: GENERIC_TOOL_TROUBLE };
  }
  const error = asRecord(envelope.error);
  if (error !== null) {
    return { kind: "error", message: serverMessage(error.message) };
  }
  const result = asRecord(envelope.result);
  if (result === null) {
    return { kind: "error", message: GENERIC_TOOL_TROUBLE };
  }
  const structured: unknown = result.structuredContent ?? null;
  if (result.isError === true) {
    const message = asRecord(structured)?.error ?? firstText(result.content);
    return { kind: "refused", message: serverMessage(message), details: structured };
  }
  return { kind: "ok", result: structured };
}

// A refusal's message lives in structuredContent.error; the MCP text
// content is the fallback, the same one the dev preview's broker reads.
function firstText(content: unknown): unknown {
  return Array.isArray(content) ? asRecord(content[0] as unknown)?.text : undefined;
}

async function postMcp(session: DeploySession, body: Record<string, unknown>): Promise<unknown> {
  // Bare headers on purpose: the Driggsby endpoint refuses anything that
  // looks like a browser call (an Origin or Sec-Fetch-Site header), and
  // Node's fetch sends neither on its own.
  const response = await fetch(new URL("/mcp", session.baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
    body: JSON.stringify(body),
    // The bearer token must never travel to a redirect target.
    redirect: "error",
    signal: AbortSignal.timeout(RULES_CALL_TIMEOUT_MS),
  });
  if (response.status === 401) {
    throw new CliError(SIGN_IN_AGAIN_MESSAGE, 1);
  }
  if (!response.ok) {
    throw new CliError(GENERIC_TOOL_TROUBLE, 1);
  }
  try {
    const parsed: unknown = await response.json();
    return parsed;
  } catch {
    throw new CliError(GENERIC_TOOL_TROUBLE, 1);
  }
}

// capForTerminal strips control and bidi bytes, then bounds the length.
// Deliberately unwrapped: a server message can end in a command
// (npx driggsby@latest login), and a hard wrap could split it; the terminal
// soft-wraps a long line and copy-paste stays intact.
function serverMessage(value: unknown): string {
  if (typeof value !== "string") {
    return GENERIC_TOOL_TROUBLE;
  }
  const clean = sanitizeForTerminal(value).trim();
  if (clean === "") {
    return GENERIC_TOOL_TROUBLE;
  }
  return clean.length > MAX_SERVER_MESSAGE_CHARS ? `${capForTerminal(clean, MAX_SERVER_MESSAGE_CHARS - 1)}…` : clean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
