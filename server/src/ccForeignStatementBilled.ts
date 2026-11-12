import { linesOfStatement } from "./cards/purchases.js";
import { isCardDebtSettlementKind, requireStoredCardLineKind } from "./cards/lineKinds.js";
import { currencyMinorDigits } from "./displayUnits.js";

/**
 * A card line that pays its debt in a foreign currency: a credit (negative `amount`, in its own
 * currency) whose stored kind (`cards/lineKinds.ts`) is a payment (ABONO DE DIVISAS, a PAGO or
 * MONTO CANCELADO in that currency) or a traspaso de deuda's foreign leg.
 */
export function isCcForeignPaymentLine(line: { id: number; kind: string | null; amount: number }): boolean {
  if (!(line.amount < 0)) return false;
  return isCardDebtSettlementKind(requireStoredCardLineKind(line.kind, line.id));
}

/**
 * What a statement in a foreign currency that prints no total billed, read from its lines: every
 * charge and credit of the period, net, with the payments of the previous facturación left out —
 * they settle that one, they are not billed in this one ({@link isCcForeignPaymentLine}). The
 * Santander international statement JSON is such a statement (its header is all nulls); where the
 * card feed showed the close, `feedCloseStatementMismatches` holds this figure to the feed's SALDO
 * INICIAL. A line not in the statement's currency throws.
 */
export function foreignBilledFromStatementLines(statementId: number, currency: string): number {
  const scale = 10 ** currencyMinorDigits(currency);
  let minor = 0;
  for (const r of linesOfStatement(statementId)) {
    const amount = r.currency === currency ? r.amount : null;
    if (amount == null || !Number.isFinite(amount)) {
      const code = currency.toUpperCase();
      throw new Error(`${code} statement ${statementId}: line ${r.id} (${r.merchant ?? ""}) has no ${code} amount`);
    }
    if (isCcForeignPaymentLine({ id: r.id, kind: r.kind, amount })) continue;
    minor += Math.round(amount * scale);
  }
  return minor / scale;
}
