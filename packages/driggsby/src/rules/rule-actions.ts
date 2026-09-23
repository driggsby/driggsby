// The rules command's actions. Each maps to exactly one Driggsby
// transaction-rule tool (the same tools the Driggsby MCP server offers);
// describe reads those tools' own descriptions instead of calling one.
export const RULE_ACTION_TOOLS = {
  list: "list_transaction_rules",
  tags: "list_transaction_tags",
  preview: "preview_transaction_rule",
  save: "save_transaction_rule",
  delete: "delete_transaction_rule",
} as const;

export type RuleToolAction = keyof typeof RULE_ACTION_TOOLS;
export type RuleAction = RuleToolAction | "describe";

export const RULE_ACTIONS: readonly RuleAction[] = ["describe", "list", "tags", "preview", "save", "delete"];

export function isRuleAction(value: string): value is RuleAction {
  return (RULE_ACTIONS as readonly string[]).includes(value);
}
