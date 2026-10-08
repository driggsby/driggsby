// The items command's actions. Each maps to exactly one Driggsby item tool
// (the same tools the Driggsby MCP server offers); describe reads those
// tools' own descriptions instead of calling one.
export const ITEM_ACTION_TOOLS = {
  save: "save_transaction_items",
  delete: "delete_transaction_items",
} as const;

export type ItemToolAction = keyof typeof ITEM_ACTION_TOOLS;
export type ItemAction = ItemToolAction | "describe";

export const ITEM_ACTIONS: readonly ItemAction[] = ["describe", "save", "delete"];

export function isItemAction(value: string): value is ItemAction {
  return (ITEM_ACTIONS as readonly string[]).includes(value);
}
