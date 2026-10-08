/**
 * How a filed Formulario 22 was settled (`f22_settlements`, written by
 * scripts/link-f22-settlements.ts): what the form asked for — a refund (code 87) or a payment
 * (code 91) — against the linked bank evidence. A refund is received reajustado (the Tesorería
 * adjusts it for inflation), so its difference is that adjustment. A linked card payment is found
 * again by its account, day and pesos (a line's id changes on re-import); evidence that is gone
 * throws.
 */
import { db } from "./db.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";

export type F22SettlementLink = {
  kind: "refund" | "payment";
  account_id: number;
  account_name: string;
  movement_id: number | null;
  occurred_on: string;
  amount: number;
  description: string;
};

export type F22Settlement = {
  /** What the filed form asked for; null when it settled at zero. */
  expected: { kind: "refund" | "payment"; amount: number } | null;
  links: F22SettlementLink[];
  /** Σ the linked amounts. */
  settled: number;
  /** settled − expected (a refund's inflation adjustment; 0 for a payment paid in full). */
  difference: number | null;
};

export function f22Settlement(taxYear: number, filed: Record<number, number> | null): F22Settlement | null {
  if (!filed) return null;
  const result = filed[305] ?? filed[304] ?? 0;
  const expected =
    result < 0
      ? { kind: "refund" as const, amount: filed[87] ?? -result }
      : result > 0
        ? { kind: "payment" as const, amount: filed[91] ?? result }
        : null;
  const links = db
    .prepare(
      `SELECT f.kind, f.account_id, a.name AS account_name, f.movement_id, f.occurred_on, f.amount, f.description
         FROM f22_settlements f JOIN accounts a ON a.id = f.account_id
        WHERE f.tax_year = ? ORDER BY f.occurred_on, f.id`
    )
    .all(taxYear) as F22SettlementLink[];
  for (const l of links) {
    if (l.movement_id != null) continue;
    const lines = db
      .prepare(
        `SELECT l.transaction_date FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
          WHERE s.account_id = ? AND l.amount_clp = ?`
      )
      .all(l.account_id, l.amount) as { transaction_date: string }[];
    if (!lines.some((x) => parseDdMmYyToIso(x.transaction_date) === l.occurred_on)) {
      throw new Error(`F22 AT${taxYear}: no card line of ${l.amount} on ${l.occurred_on} (account ${l.account_id}) any more`);
    }
  }
  const settled = links.reduce((s, l) => s + l.amount, 0);
  return { expected, links, settled, difference: expected && links.length ? settled - expected.amount : null };
}
