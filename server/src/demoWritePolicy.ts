import { demoModeEnabled } from "./demoModeFlag.js";
import { InputError } from "./inputError.js";

/**
 * Which writes the hosted demo accepts (docs/demo-about-plan.md §4). A leaf module: the read-only
 * guard (httpSecurity.ts) and the quota middleware (demoWritable.ts) both read it.
 *
 * Open: edits that carry no free text — a visitor's change shows to every other visitor until the
 * next reset, so nothing a visitor types reaches another one. Everything else stays read-only.
 */
const DEMO_WRITE_ALLOWLIST: readonly { method: string; path: RegExp }[] = [
  // An expense line's category, «Único» included (the route takes a slug, never a new category).
  { method: "PATCH", path: /^\/api\/flows\/expenses\/lines\/-?\d+\/category$/ },
  // An existing big group on a purchase (creating one is closed).
  { method: "PUT", path: /^\/api\/flows\/expenses\/purchase-big-group$/ },
  // A checking credit marked as a refund of spending, and back.
  { method: "POST", path: /^\/api\/income\/movements\/\d+\/refund$/ },
  { method: "DELETE", path: /^\/api\/income\/movements\/\d+\/refund$/ },
  // The cuotas count of a card purchase.
  { method: "POST", path: /^\/api\/accounts\/\d+\/cc-statement-lines\/\d+\/make-installment$/ },
  // Pieces of an expense line (day, amount and category only).
  { method: "PUT", path: /^\/api\/flows\/expenses\/line-pieces$/ },
  // Manual expenses, the description from DEMO_MANUAL_EXPENSE_DESCRIPTIONS.
  { method: "POST", path: /^\/api\/flows\/expenses\/manual$/ },
  { method: "PATCH", path: /^\/api\/flows\/expenses\/manual\/\d+$/ },
  { method: "DELETE", path: /^\/api\/flows\/expenses\/manual\/\d+$/ },
];

export function demoWriteAllowedByPolicy(method: string, path: string): boolean {
  return DEMO_WRITE_ALLOWLIST.some((rule) => rule.method === method && rule.path.test(path));
}

/**
 * The descriptions a demo visitor may give a manual expense, stored as written (expense text, like
 * a bank's merchant name, not UI copy). Fixed because the database is shared.
 */
export const DEMO_MANUAL_EXPENSE_DESCRIPTIONS = [
  "Coffee",
  "Lunch",
  "Groceries",
  "Taxi",
  "Parking",
  "Pharmacy",
  "Haircut",
  "Books",
  "Cinema",
  "Gift",
] as const;

/** On the demo, a manual expense's description must be one of the list; elsewhere anything goes. */
export function assertDemoManualExpenseDescription(description: unknown): void {
  if (!demoModeEnabled()) return;
  const text = typeof description === "string" ? description.trim() : "";
  if (!(DEMO_MANUAL_EXPENSE_DESCRIPTIONS as readonly string[]).includes(text)) {
    throw new InputError(`demo: the description must be one of ${DEMO_MANUAL_EXPENSE_DESCRIPTIONS.join(", ")}`);
  }
}
