/**
 * The writer of a card's stored billing-month snapshot (`cc_billing_month_metrics`). It sits above
 * the billing views: the rows are written first and then take their cupo and saldo from the detalle
 * built from them. The row readers stay in `ccBillingBalances.ts`, below the views.
 */
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import { facturadoByCurrencyForStatementSlot } from "./ccBillingViews.js";
import { isHomeCurrency } from "./displayUnits.js";
import { primaryStatementOfSlot, statementSlotsByBillingMonth } from "./ccBillingStatementSlots.js";
import { isListingSourceKind } from "./ccStatementSourceKind.js";
import { listCcStatementsForAccount } from "./ccStatementsDb.js";
import { billingMonthForManualLedgerPurchase } from "./cards/facturacion.js";
import { cardStoppedBilling } from "./cards/lifecycle.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";

type BalanceWrite = {
  account_id: number;
  billing_month: string;
  as_of_date: string;
  as_of_kind: string;
  facturado: Readonly<Record<string, number | null>>;
  saldo_total: Readonly<Record<string, number | null>>;
};

const upsertMetric = db.prepare(`
  INSERT INTO cc_billing_month_metrics (account_id, billing_month, as_of_date, as_of_kind, metric, currency, amount)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(account_id, billing_month, as_of_date, as_of_kind, metric, currency) DO UPDATE SET amount = excluded.amount
`);

/** A month's snapshot rows: facturado and saldo total per currency (a null entry writes nothing), the peso cupo 0 until set. */
function writeBalance(b: BalanceWrite): void {
  const put = (metric: string, currency: string, amount: number | null) => {
    if (amount != null) upsertMetric.run(b.account_id, b.billing_month, b.as_of_date, b.as_of_kind, metric, currency, amount);
  };
  for (const [c, v] of Object.entries(b.facturado)) put("facturado", c, v);
  // Set from the detalle once it can be built from these rows.
  put("cupo_utilizado", "clp", 0);
  put("saldo_total", "clp", 0);
  for (const [c, v] of Object.entries(b.saldo_total)) if (!isHomeCurrency(c)) put("saldo_total", c, v);
}

const updateBalanceFromDetalle = db.prepare(`
  UPDATE cc_billing_month_metrics SET amount = CASE metric WHEN 'cupo_utilizado' THEN ? ELSE ? END
  WHERE account_id = ? AND billing_month = ? AND currency = 'clp' AND metric IN ('cupo_utilizado', 'saldo_total')
`);

/**
 * Rebuilds one card's stored `cc_billing_month_metrics` snapshot: a row per statement slot, as
 * of its close, and — while no statement closes it — the open facturación's row, as of today.
 * Facturado is per currency, the slot's own (`facturadoByCurrencyForStatementSlot`); a foreign
 * `saldo_total` is that currency's statement's printed deuda total. Cupo en cuotas and saldo total are the detalle row
 * the card page shows for that month (`billingDetailCacheForAccount`), so the snapshot cannot
 * drift from it: the rebuild used to carry its own cupo rule — keyed on the calendar month, the
 * double count `cupoEnCuotasForBillingMonth` describes — and a saldo of cupo + the statement's
 * revolving lines net of the previous bill's payment, which read negative on paid-off months.
 * The detalle reads these rows back (the open month's row keeps that month in the table before
 * any line lands in it), hence the order: rows first, then the detalle built from them.
 */
export function recomputeCcBillingMonthBalances(accountId: number): number {
  const statements = listCcStatementsForAccount(accountId);
  const months = new Set<string>();
  let n = 0;

  db.prepare(`DELETE FROM cc_billing_month_metrics WHERE account_id = ?`).run(accountId);

  for (const [billingMonth, slot] of statementSlotsByBillingMonth(accountId)) {
    const primary = primaryStatementOfSlot(accountId, slot);
    if (!primary?.statement_date_iso) continue;
    const asOfIso = primary.statement_date_iso;
    // Each currency the slot has a statement in: what it billed, and a foreign statement's printed
    // deuda total. Only positive figures are stored.
    const positive = (v: number | null | undefined): number | null => (v != null && v > 0 ? v : null);
    const facturado: Record<string, number | null> = {};
    for (const [currency, billed] of Object.entries(facturadoByCurrencyForStatementSlot(accountId, slot))) {
      facturado[currency] = positive(billed);
    }
    const saldoTotal: Record<string, number | null> = {};
    for (const [currency, st] of slot) {
      if (!isHomeCurrency(currency)) saldoTotal[currency] = positive(st.deuda_total);
    }

    writeBalance({
      account_id: accountId,
      billing_month: billingMonth,
      as_of_date: asOfIso,
      as_of_kind: "statement",
      facturado,
      saldo_total: saldoTotal,
    });
    months.add(billingMonth);
    n += 1;
  }

  const today = chileCalendarTodayYmd();
  const openBm = billingMonthForManualLedgerPurchase(accountId);
  if (openBm && !cardStoppedBilling(accountId)) {
    const hasPdfForOpen = statements.some(
      (s) => s.billing_month === openBm && !isListingSourceKind(s.source_kind)
    );
    if (!hasPdfForOpen) {
      writeBalance({
        account_id: accountId,
        billing_month: openBm,
        as_of_date: today,
        as_of_kind: "manual",
        facturado: {},
        saldo_total: {},
      });
      months.add(openBm);
      n += 1;
    }
  }

  const detailByMonth = new Map(
    billingDetailCacheForAccount(accountId).detail.map((r) => [r.billing_month, r])
  );
  for (const billingMonth of months) {
    const row = detailByMonth.get(billingMonth);
    if (!row) {
      throw new Error(
        `Account ${accountId}: stored billing month ${billingMonth} has no detalle row to take its cupo and saldo from`
      );
    }
    updateBalanceFromDetalle.run(row.cupo_statement, row.balance_statement, accountId, billingMonth);
  }

  return n;
}
