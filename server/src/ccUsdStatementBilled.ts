import { db } from "./db.js";
import { isCcPaymentOrUsdDebtAbonoMerchant } from "./ccPaymentLines.js";
import { isCcTraspasoDeudaMerchant } from "./ccStatementSection3.js";

/**
 * A card line that pays dollar debt: a dollar credit that is a payment (ABONO DE DIVISAS, a PAGO or
 * MONTO CANCELADO in dollars) or a traspaso de deuda's USD leg.
 */
export function isCcUsdPaymentLine(line: {
  installment_flag: number;
  merchant: string | null;
  usd: number;
}): boolean {
  if (line.installment_flag === 1 || !(line.usd < 0)) return false;
  return isCcPaymentOrUsdDebtAbonoMerchant(line.merchant) || isCcTraspasoDeudaMerchant(line.merchant);
}

const usdStatementLinesStmt = db.prepare(
  `SELECT id, installment_flag, merchant, amount_usd FROM cc_statement_lines WHERE statement_id = ?`
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
    installment_flag: number;
    merchant: string | null;
    amount_usd: number | null;
  }[];
  let cents = 0;
  for (const r of rows) {
    const usd = r.amount_usd;
    if (usd == null || !Number.isFinite(usd)) {
      throw new Error(`Dollar statement ${statementId}: line ${r.id} (${r.merchant ?? ""}) has no dollar amount`);
    }
    if (isCcUsdPaymentLine({ installment_flag: r.installment_flag, merchant: r.merchant, usd })) continue;
    cents += Math.round(usd * 100);
  }
  return cents / 100;
}
