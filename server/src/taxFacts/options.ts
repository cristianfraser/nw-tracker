/**
 * The option contracts' movements in a window (`option_contracts`, migration 304): how many, and
 * the net premium they moved — received (a written option, a long one sold) less paid (a long one
 * bought, a short one bought back), in the premiums' currency. Expiries and assignments move no
 * money. Jurisdiction-neutral: the F22 reads it to refuse or exclude options, the 1040 takes the
 * lots themselves (`optionTaxLotEvents.ts`).
 */
import { db } from "../db.js";
import type { DateWindow } from "../dateWindow.js";
import { OPTION_PREMIUM_PAID_FLOW_KINDS, OPTION_PREMIUM_RECEIVED_FLOW_KINDS, OPTION_UNITS_FLOW_KINDS } from "../optionFlowKinds.js";

export type OptionMovementFacts = {
  movements: number;
  /** Premiums received less paid; 0 without movements. */
  netPremium: number;
  /** The premiums' currency; null without premium movements. */
  currency: string | null;
};

export function optionMovementFacts(window: DateWindow): OptionMovementFacts {
  const kinds = OPTION_UNITS_FLOW_KINDS as readonly string[];
  const rows = db
    .prepare(
      `SELECT flow_kind, amount, currency FROM movements
        WHERE flow_kind IN (${kinds.map(() => "?").join(", ")}) AND occurred_on BETWEEN ? AND ?`
    )
    .all(...kinds, window.fromYmd, window.throughYmd) as { flow_kind: string; amount: number; currency: string }[];
  const received = OPTION_PREMIUM_RECEIVED_FLOW_KINDS as readonly string[];
  const paid = OPTION_PREMIUM_PAID_FLOW_KINDS as readonly string[];
  const currencies = new Set(rows.filter((r) => received.includes(r.flow_kind) || paid.includes(r.flow_kind)).map((r) => r.currency));
  if (currencies.size > 1) throw new Error(`Option facts: premiums in ${[...currencies].join(" and ")} in ${window.fromYmd}→${window.throughYmd}`);
  let netPremium = 0;
  for (const r of rows) {
    if (received.includes(r.flow_kind)) netPremium += Math.abs(r.amount);
    else if (paid.includes(r.flow_kind)) netPremium -= Math.abs(r.amount);
  }
  return { movements: rows.length, netPremium: Math.round(netPremium * 100) / 100, currency: [...currencies][0] ?? null };
}
