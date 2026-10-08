// Argv parsing for `driggsby items <ACTION> [--params <JSON> | --params-file
// <PATH>] [--yes]`: the rules command's grammar (args-rules.ts) over the
// item tools.
import { type ActionCommandSpec, parseActionCommand } from "./args-rules.ts";
import { type ParsedCommand } from "./args-shared.ts";
import { ITEMS_HELP } from "./help.ts";
import { type ItemAction, isItemAction, ITEM_ACTIONS } from "./items/item-actions.ts";

const ITEMS_SPEC: ActionCommandSpec<ItemAction> = {
  name: "items",
  article: "an",
  usage: "Usage: npx driggsby@latest items <ACTION> [--params <JSON>] [--yes]",
  help: ITEMS_HELP,
  actions: ITEM_ACTIONS,
  isAction: isItemAction,
  describeAction: "describe",
  deleteAction: "delete",
  deleteNeedsYes:
    "error: removing a charge's items can't be undone — Spending counts it whole\n" +
    "again. To remove them, run the same command again with --yes.",
  exampleParams: `'{"transaction_refs":["txn_..."]}'`,
};

export function parseItems(argv: string[]): ParsedCommand {
  const parsed = parseActionCommand(argv, ITEMS_SPEC);
  return parsed.kind === "action" ? { kind: "items", action: parsed.action, params: parsed.params, yes: parsed.yes } : parsed;
}
