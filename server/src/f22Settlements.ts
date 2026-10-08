/**
 * How a filed Formulario 22 was settled (`f22_settlements`, written by
 * scripts/link-f22-settlements.ts): what the form asked for — a refund (code 87) or a payment
 * (code 91) — against the linked evidence. A refund is received reajustado (the Tesorería
 * adjusts it for inflation), so its difference is that adjustment. A linked card payment is found
 * again by its account, day and pesos (a line's id changes on re-import); evidence that is gone
 * throws. An `offset` is a refund the Tesorería kept to pay another year's debt: it settles the
 * refund's year (`offset_kept`) and pays the debt's year (`offset_paid`).
 */
import { db } from "./db.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";

export type F22SettlementLink = {
  kind: "refund" | "payment" | "offset_kept" | "offset_paid";
  account_id: number | null;
  account_name: string | null;
  movement_id: number | null;
  /** For an offset: the other tax year (the debt's for `offset_kept`, the refund's for `offset_paid`). */
  other_tax_year: number | null;
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
  /** settled − expected (a refund's inflation adjustment; a late payment's adjustment and interest). */
  difference: number | null;
};

type SettlementRow = {
  tax_year: number;
  kind: "refund" | "payment" | "offset";
  account_id: number | null;
  account_name: string | null;
  movement_id: number | null;
  offset_tax_year: number | null;
  occurred_on: string;
  amount: number;
  description: string;
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
  const rows = db
    .prepare(
      `SELECT f.tax_year, f.kind, f.account_id, a.name AS account_name, f.movement_id, f.offset_tax_year,
              f.occurred_on, f.amount, f.description
         FROM f22_settlements f LEFT JOIN accounts a ON a.id = f.account_id
        WHERE f.tax_year = ? OR f.offset_tax_year = ? ORDER BY f.occurred_on, f.id`
    )
    .all(taxYear, taxYear) as SettlementRow[];
  const links: F22SettlementLink[] = rows.map((r) => {
    if (r.kind !== "offset") {
      return { ...r, kind: r.kind, other_tax_year: null };
    }
    const kept = r.tax_year === taxYear;
    if (kept ? expected?.kind !== "refund" : expected?.kind !== "payment") {
      throw new Error(
        `F22 AT${taxYear}: an offset ${kept ? "keeps a refund" : "pays a debt"} the filed form does not ${kept ? "request" : "owe"}`
      );
    }
    return {
      ...r,
      kind: kept ? "offset_kept" : "offset_paid",
      other_tax_year: kept ? r.offset_tax_year : r.tax_year,
    };
  });
  for (const l of links) {
    if (l.movement_id != null || l.account_id == null) continue;
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

/** A tax refund the Tesorería paid into an account, by its movement: income wherever it landed. */
export type F22RefundMovement = { movement_id: number; tax_year: number; account_id: number; occurred_on: string; amount: number };

export function loadF22RefundMovements(): F22RefundMovement[] {
  return db
    .prepare(
      `SELECT movement_id, tax_year, account_id, occurred_on, amount FROM f22_settlements
        WHERE kind = 'refund' AND movement_id IS NOT NULL ORDER BY occurred_on, id`
    )
    .all() as F22RefundMovement[];
}
