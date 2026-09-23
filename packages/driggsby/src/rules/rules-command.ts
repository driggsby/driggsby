// driggsby rules: read and change the signed-in person's transaction
// rules. Each action is one call to a Driggsby transaction-rule tool (the
// same tools the Driggsby MCP server offers); describe prints those tools'
// own descriptions, so the rule format is never copied into this CLI.
// stdout carries only JSON (the result, or a refusal's own details) so an
// agent can pipe or save it; every message is a CliError on stderr.
import { apiBaseUrl } from "../api/base-url.ts";
import { CliError } from "../cli-error.ts";
import { type CredentialEnvironment, defaultCredentialEnvironment } from "../credentials/store.ts";
import { deployFailure, requireDeploySession } from "../deploy/api-session.ts";
import { RULE_ACTION_TOOLS, RULE_ACTIONS, type RuleAction, type RuleToolAction } from "./rule-actions.ts";
import { callRuleTool, listRuleTools, type RuleToolDescription, terminalSafeJson } from "./rules-rpc.ts";

export interface RulesCommandOptions {
  action: RuleAction;
  params: Record<string, unknown>;
}

export interface RulesCommandIo {
  out: (text: string) => void;
}

// Most rule tools require a short reason; when the caller gives none, this
// names the CLI.
export const RULES_REASON = "Managing transaction rules from the driggsby CLI.";

function defaultRulesIo(): RulesCommandIo {
  return {
    out: (text) => {
      process.stdout.write(text);
    },
  };
}

export async function runRules(
  options: RulesCommandOptions,
  environment: CredentialEnvironment = defaultCredentialEnvironment(),
  io: RulesCommandIo = defaultRulesIo(),
): Promise<number> {
  const { action, params } = options;
  const baseUrl = apiBaseUrl(environment.env);
  const retryCommand = retryCommandFor(options);
  try {
    const session = await requireDeploySession(environment);
    if (action === "describe") {
      const tools = await listRuleTools(session);
      io.out(`${terminalSafeJson(describePayload(tools))}\n`);
      return 0;
    }
    const outcome = await callRuleTool(session, RULE_ACTION_TOOLS[action], withReason(params));
    if (outcome.kind === "ok") {
      io.out(`${terminalSafeJson(outcome.result)}\n`);
      return 0;
    }
    if (outcome.kind === "refused") {
      io.out(`${terminalSafeJson(outcome.details)}\n`);
    }
    throw new CliError(outcome.message, 1);
  } catch (error) {
    throw deployFailure(error, baseUrl, retryCommand);
  }
}

// What describe prints: the tools' own descriptions, plus the CLI command
// that runs each tool the descriptions name.
// Each action's flags, keyed by action so a new action can't be left out.
const ACTION_FLAGS: Record<RuleToolAction, string> = {
  list: " [--params <JSON>]",
  tags: "",
  preview: " --params <JSON>",
  save: " --params <JSON>",
  delete: " --params <JSON> --yes",
};

export function describePayload(tools: RuleToolDescription[]): Record<string, unknown> {
  const howToRun: Record<string, string> = {};
  for (const action of RULE_ACTIONS) {
    if (action !== "describe") {
      howToRun[RULE_ACTION_TOOLS[action]] = `npx driggsby@latest rules ${action}${ACTION_FLAGS[action]}`;
    }
  }
  // The two read tools the rule descriptions send an agent to first.
  howToRun.search_cash_transactions = "npx driggsby@latest query search_cash_transactions --params <JSON>";
  howToRun.query_cash_sql = "npx driggsby@latest query query_cash_sql --sql <SQL>";
  return {
    how_to_run: howToRun,
    notes: [
      "--params is the tool's arguments object as JSON; --params-file <PATH> reads the same object from a file.",
      "The CLI fills in reason when you leave it out.",
    ],
    tools,
  };
}

function withReason(params: Record<string, unknown>): Record<string, unknown> {
  const reason = params.reason;
  if (typeof reason === "string" && reason.trim() !== "") {
    return params;
  }
  return { ...params, reason: RULES_REASON };
}

// The command to run again after a network blip. Params are never rebuilt
// into a shell line (no quoting is right for every shell), so they are named
// in a plain sentence under the command instead. A retried save is safe: a
// confirm token redeems once, so a save that already landed is refused, not
// applied twice.
function retryCommandFor(options: RulesCommandOptions): string {
  const command = `npx driggsby@latest rules ${options.action}${options.action === "delete" ? " --yes" : ""}`;
  return Object.keys(options.params).length === 0 ? command : `${command}\n  with the same params as before`;
}
