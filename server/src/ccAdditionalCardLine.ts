/**
 * Whether a card line is an additional cardholder's (a leaf: no database, so migration hooks can
 * ask while `db.ts` is loading). Re-exported by `ccAdditionalCardExpenseMatch.ts`.
 */
import { ccCardRegistry } from "./ccCardRegistry.js";

/**
 * Additional-cardholder purchase: the origin card is in the registry's
 * `additional_card_last4s` list. A bare origin ≠ statement-card mismatch is NOT
 * enough — the user's own predecessor/successor plastics show up as foreign
 * origins on transition-month statements (e.g. the 0901 successor charging while
 * statements were still 0781-branded) and those are the user's own gastos.
 */
export function isAdditionalCardExpenseLine(
  originCardLast4: string | null | undefined,
  primaryCardLast4: string | null | undefined,
  additionalCardLast4s: readonly string[] = ccCardRegistry().additional_card_last4s
): boolean {
  const origin = String(originCardLast4 ?? "").trim();
  const primary = String(primaryCardLast4 ?? "").trim();
  if (!origin || !primary) return false;
  if (origin === primary) return false;
  return additionalCardLast4s.includes(origin);
}
