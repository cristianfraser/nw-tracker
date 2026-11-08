import { db } from "./db.js";
import { isCardDebtSettlementKind, requireStoredCardLineKind } from "./cards/lineKinds.js";

/**
 * A card line that pays dollar debt: a dollar credit whose stored kind (`cards/lineKinds.ts`) is a
 * payment (ABONO DE DIVISAS, a PAGO or MONTO CANCELADO in dollars) or a traspaso de deuda's USD leg.
 */
export function isCcUsdPaymentLine(line: { id: number; kind: string | null; usd: number }): boolean {
  if (!(line.usd < 0)) return false;
  return isCardDebtSettlementKind(requireStoredCardLineKind(line.kind, line.id));
}

const usdStatementLinesStmt = db.prepare(
  `SELECT id, kind, merchant, amount_usd FROM cc_statement_lines WHERE statement_id = ?`
);

/**
 * What a dollar statement that prints no total billed, read from its lines: every charge and credit
 * of the period, net, with the payments of the previous facturación left out — they settle that
 * one, they are not billed in this one ({@link isCcUsdPaymentLine}). The Santander international
 * statement JSON is such a statement (its header is all nulls); where the card feed showed the
 * close, `feedCloseStatementMismatches` holds this figure to the feed's SALDO INICIAL. A line with
 * no dollar amount on a dollar statement throws.
 */
export function usdBilledFromStatementLines(statementId: number): number {
  const rows = usdStatementLinesStmt.all(statementId) as {
    id: number;
    kind: string | null;
    merchant: string | null;
    amount_usd: number | null;
  }[];
  let cents = 0;
  for (const r of rows) {
    const usd = r.amount_usd;
    if (usd == null || !Number.isFinite(usd)) {
      throw new Error(`Dollar statement ${statementId}: line ${r.id} (${r.merchant ?? ""}) has no dollar amount`);
    }
    if (isCcUsdPaymentLine({ id: r.id, kind: r.kind, usd })) continue;
    cents += Math.round(usd * 100);
  }
  return cents / 100;
}
