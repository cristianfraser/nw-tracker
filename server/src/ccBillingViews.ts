import { billingMonthForStatementDate } from "./ccBillingMonth.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import { listCcBillingMonthBalances, type CcBillingMonthBalanceRow } from "./ccBillingBalances.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { facturadoFromStatement } from "./ccBillingBalances.js";
import {
  cupoEnCuotasClpForCalendarMonth,
  ledgerFacturadoClpForBillingMonth,
  liveCreditCardOutstandingClp,
} from "./ccInstallmentLedgerDb.js";
import { creditCardBillingDetailInactive } from "./ccBillingInactive.js";
import { isPdfStatementSource, lastPdfBillingMonthForAccount } from "./ccManualBillingMonth.js";
import { isCcPaymentMerchant } from "./ccPaymentLines.js";
import { ymCompare } from "./calendarMonth.js";
import { db } from "./db.js";
import { parseDdMmYyToIso, resolveInstallmentPayByIso } from "./ccInstallmentPayBy.js";
import { listCcStatementsForAccount, type CcStatementRow } from "./ccStatementsDb.js";
import type { CcInstallmentMonthRow } from "./creditCardInstallments.js";
import { fxMonthEndForBalanceUsd } from "./fxRates.js";
export type CcBillingDetailMonthRow = {
  billing_month: string;
  as_of_date: string;
  as_of_kind: "statement" | "manual";
  /** Closed-statement facturado only; null when not yet closed. */
  total_facturado_actual_clp: number | null;
  /** Same as actual for balance math (no manual estimate). */
  total_facturado_clp: number | null;
  cupo_en_cuotas_clp: number;
  /** Ledger cuota due in the pay-by month (~10th of month after close). */
  cuota_a_pagar_next_mes_clp: number;
  balance_total_clp: number;
};

export type CcFacturacionRow = {
  billing_month: string;
  close_date: string;
  close_date_iso: string;
  pay_by: string | null;
  pay_by_iso: string | null;
  facturado_clp: number | null;
  facturado_usd: number | null;
  facturado_usd_clp: number | null;
  facturado_total_clp: number | null;
  cuota_a_pagar_clp: number | null;
};

function pickSnapshotRow(
  rows: CcBillingMonthBalanceRow[],
  billingMonth: string
): CcBillingMonthBalanceRow | null {
  const forMonth = rows.filter(
    (r) => r.billing_month === billingMonth && r.as_of_kind !== "month_end"
  );
  const statement = forMonth.find((r) => r.as_of_kind === "statement");
  if (statement) return statement;
  const manual = forMonth.find((r) => r.as_of_kind === "manual");
  return manual ?? null;
}

function cupoEnCuotasForBillingMonth(
  accountId: number,
  billingMonth: string,
  cupoLive: number
): number {
  const currentBillingMonth = billingMonthForStatementDate(chileCalendarTodayYmd());
  if (currentBillingMonth && billingMonth === currentBillingMonth) return cupoLive;
  return cupoEnCuotasClpForCalendarMonth(accountId, billingMonth);
}

export type CcStatementSlotByCurrency = {
  clp: CcStatementRow | null;
  usd: CcStatementRow | null;
};

function statementSlotsByBillingMonth(accountId: number): Map<string, CcStatementSlotByCurrency> {
  const byMonth = new Map<string, CcStatementSlotByCurrency>();
  for (const st of listCcStatementsForAccount(accountId)) {
    const bm = st.billing_month;
    if (!bm) continue;
    let slot = byMonth.get(bm);
    if (!slot) {
      slot = { clp: null, usd: null };
      byMonth.set(bm, slot);
    }
    if (st.currency === "usd") slot.usd = st;
    else slot.clp = st;
  }
  return byMonth;
}

/** CLP+USD facturado for a billing month from imported statements (header or line-derived). */
export function facturadoTotalClpForStatementSlot(
  accountId: number,
  slot: CcStatementSlotByCurrency
): number | null {
  const primary = slot.clp ?? slot.usd;
  if (!primary) return null;

  const clpDerived = slot.clp
    ? facturadoFromStatement(
        accountId,
        slot.clp.statement_date,
        slot.clp,
        slot.clp.statement_date_iso
      )
    : { facturado_clp: null as number | null, facturado_usd: null as number | null };
  const usdDerived = slot.usd
    ? facturadoFromStatement(
        accountId,
        slot.usd.statement_date,
        slot.usd,
        slot.usd.statement_date_iso
      )
    : { facturado_clp: null as number | null, facturado_usd: null as number | null };

  const facturadoClp =
    slot.clp?.monto_facturado != null && slot.clp.monto_facturado > 0
      ? Math.round(slot.clp.monto_facturado)
      : clpDerived.facturado_clp;
  const facturadoUsd =
    slot.usd?.monto_facturado != null && slot.usd.monto_facturado > 0
      ? slot.usd.monto_facturado
      : usdDerived.facturado_usd;

  const { pay_by_iso: payByIso } = resolveFacturacionPayBy(slot, primary);
  const facturadoUsdClp =
    facturadoUsd != null
      ? usdToClpAtPayBy(facturadoUsd, payByIso) ?? usdDerived.facturado_clp
      : null;
  const total = (facturadoClp ?? 0) + (facturadoUsdClp ?? 0);
  return total > 0 ? total : null;
}

/** True when an imported PDF (not web-paste) closed this billing month. */
export function hasPdfStatementCloseForBillingMonth(
  slot: CcStatementSlotByCurrency | undefined
): boolean {
  if (!slot) return false;
  for (const st of [slot.clp, slot.usd]) {
    if (st && isPdfStatementSource(st.source_pdf)) return true;
  }
  return false;
}

const stmtPaymentLinesForStatement = db.prepare(`
  SELECT merchant, amount_clp FROM cc_statement_lines WHERE statement_id = ?
`);

/** Sum PAGO / ABONO lines in a billing month (DB stores payments as negative CLP). */
export function paymentAbonosClpForBillingMonth(
  accountId: number,
  billingMonth: string
): number {
  let sum = 0;
  for (const st of listCcStatementsForAccount(accountId)) {
    if (st.billing_month !== billingMonth) continue;
    const rows = stmtPaymentLinesForStatement.all(st.id) as {
      merchant: string | null;
      amount_clp: number | null;
    }[];
    for (const r of rows) {
      if (!isCcPaymentMerchant(r.merchant)) continue;
      const amt = r.amount_clp;
      if (amt == null || !Number.isFinite(amt)) continue;
      sum += Math.round(Math.abs(amt));
    }
  }
  return sum;
}

function closedFacturadoClpForPdfBillingMonth(
  accountId: number,
  priorPdfMonth: string,
  slots: Map<string, CcStatementSlotByCurrency>
): number | null {
  const slot = slots.get(priorPdfMonth);
  if (!slot) return null;
  return facturadoTotalClpForStatementSlot(accountId, slot);
}

/**
 * Open month before PDF close: prior closed facturado + incremental charges − abonos.
 * Returns null when there is no prior PDF month to roll forward.
 */
export function rolledFacturadoForOpenBillingMonth(
  accountId: number,
  openBillingMonth: string,
  slots: Map<string, CcStatementSlotByCurrency>,
  statementOrBalanceFacturado: number | null
): number | null {
  const priorPdf = lastPdfBillingMonthForAccount(accountId);
  if (!priorPdf || ymCompare(openBillingMonth, priorPdf) <= 0) return null;

  const priorFacturado = closedFacturadoClpForPdfBillingMonth(accountId, priorPdf, slots);
  if (priorFacturado == null || priorFacturado <= 0) return null;

  const ledgerIncremental = ledgerFacturadoClpForBillingMonth(accountId, openBillingMonth);
  const statementIncremental = statementOrBalanceFacturado ?? 0;
  const incremental = Math.max(ledgerIncremental, statementIncremental);
  const payments = paymentAbonosClpForBillingMonth(accountId, openBillingMonth);
  return Math.round(priorFacturado + incremental - payments);
}

function cuotaAPagarNextMesClp(
  billingMonth: string,
  ledgerMonths: CcInstallmentMonthRow[],
  slots: Map<string, CcStatementSlotByCurrency>
): number {
  const slot = slots.get(billingMonth);
  const primary = slot?.clp ?? slot?.usd;
  if (slot && primary) {
    const { pay_by_iso: payByIso } = resolveFacturacionPayBy(slot, primary);
    const cuota = cuotaForPayByMonth(payByIso, ledgerMonths);
    if (cuota != null) return cuota;
  }
  const payYm = addCalendarMonths(billingMonth, 1);
  const row = ledgerMonths.find((m) => m.month === payYm);
  return row && row.total_clp > 0 ? row.total_clp : 0;
}

export function buildBillingDetailByMonth(
  accountId: number,
  ledgerMonths: CcInstallmentMonthRow[] = []
): CcBillingDetailMonthRow[] {
  const balances = listCcBillingMonthBalances(accountId).filter(
    (r) => r.as_of_kind !== "month_end"
  );
  const cupoLive = liveCreditCardOutstandingClp(accountId) ?? 0;
  const slots = statementSlotsByBillingMonth(accountId);
  const months = new Set<string>();
  for (const r of balances) {
    months.add(r.billing_month);
  }
  for (const bm of slots.keys()) {
    months.add(bm);
  }

  const inactive = creditCardBillingDetailInactive(accountId);
  const lastStatementBillingMonth =
    inactive && slots.size > 0
      ? [...slots.keys()].sort((a, b) => a.localeCompare(b)).at(-1) ?? null
      : null;

  const out: CcBillingDetailMonthRow[] = [];
  for (const billingMonth of months) {
    const slot = slots.get(billingMonth);
    const primary = slot?.clp ?? slot?.usd;
    if (inactive) {
      if (!primary) continue;
      if (
        lastStatementBillingMonth &&
        billingMonth.localeCompare(lastStatementBillingMonth) > 0
      ) {
        continue;
      }
    }
    const snap = pickSnapshotRow(balances, billingMonth);
    if (!snap && !primary) continue;

    const fromStatement = slot ? facturadoTotalClpForStatementSlot(accountId, slot) : null;
    const fromBalance =
      snap?.as_of_kind === "statement" &&
      snap.facturado_clp != null &&
      snap.facturado_clp > 0
        ? snap.facturado_clp
        : null;
    let totalFacturado = fromStatement ?? fromBalance;

    const hasPdfClose = hasPdfStatementCloseForBillingMonth(slot);
    if (!hasPdfClose && !inactive) {
      const rolled = rolledFacturadoForOpenBillingMonth(
        accountId,
        billingMonth,
        slots,
        fromStatement ?? fromBalance
      );
      if (rolled != null) totalFacturado = rolled;
    }

    const kind: "statement" | "manual" =
      primary != null ? "statement" : snap?.as_of_kind === "manual" ? "manual" : "statement";
    const asOfDate =
      primary?.statement_date_iso ?? snap?.as_of_date ?? `${billingMonth}-01`;

    const cupo = cupoEnCuotasForBillingMonth(accountId, billingMonth, cupoLive);
    const cuotaNext = cuotaAPagarNextMesClp(billingMonth, ledgerMonths, slots);
    const balanceTotal = (totalFacturado ?? 0) + cupo - cuotaNext;
    out.push({
      billing_month: billingMonth,
      as_of_date: asOfDate,
      as_of_kind: kind,
      total_facturado_actual_clp: totalFacturado,
      total_facturado_clp: totalFacturado,
      cupo_en_cuotas_clp: cupo,
      cuota_a_pagar_next_mes_clp: cuotaNext,
      balance_total_clp: balanceTotal,
    });
  }

  out.sort((a, b) => b.billing_month.localeCompare(a.billing_month));
  return out;
}

function usdToClpAtPayBy(usd: number, payByIso: string | null): number | null {
  if (!Number.isFinite(usd) || usd <= 0) return null;
  const fxDate = payByIso ?? "";
  const fx = fxMonthEndForBalanceUsd(fxDate);
  if (!fx?.clp_per_usd || fx.clp_per_usd <= 0) return null;
  return Math.round(usd * fx.clp_per_usd);
}

function isoToDdMmYyyy(iso: string): string {
  const [y, mo, d] = iso.split("-");
  return `${d}/${mo}/${y}`;
}

/** Explicit PDF pay_by when present; else statement close + 10th of next month (see ccInstallmentPayBy). */
function resolveFacturacionPayBy(
  slot: CcStatementSlotByCurrency,
  primary: CcStatementRow
): { pay_by: string | null; pay_by_iso: string | null } {
  for (const st of [slot.clp, slot.usd]) {
    if (!st) continue;
    const explicit = String(st.pay_by ?? "").trim();
    if (explicit) {
      return {
        pay_by: explicit,
        pay_by_iso: parseDdMmYyToIso(explicit),
      };
    }
  }
  const payByIso = resolveInstallmentPayByIso({
    statement_date: primary.statement_date_iso ?? primary.statement_date,
    period_to: primary.period_to ?? undefined,
  });
  if (!payByIso) return { pay_by: null, pay_by_iso: null };
  return { pay_by: isoToDdMmYyyy(payByIso), pay_by_iso: payByIso };
}

function cuotaForPayByMonth(
  payByIso: string | null,
  ledgerMonths: CcInstallmentMonthRow[]
): number | null {
  if (!payByIso) return null;
  const ym = billingMonthForStatementDate(payByIso);
  if (!ym) return null;
  const row = ledgerMonths.find((m) => m.month === ym);
  if (!row || row.total_clp <= 0) return null;
  return row.total_clp;
}

export function buildFacturaciones(
  accountId: number,
  ledgerMonths: CcInstallmentMonthRow[]
): CcFacturacionRow[] {
  const byMonth = statementSlotsByBillingMonth(accountId);

  const out: CcFacturacionRow[] = [];
  for (const [billingMonth, slot] of byMonth) {
    const primary = slot.clp ?? slot.usd;
    if (!primary) continue;

    const clpDerived = slot.clp
      ? facturadoFromStatement(
          accountId,
          slot.clp.statement_date,
          slot.clp,
          slot.clp.statement_date_iso
        )
      : { facturado_clp: null as number | null, facturado_usd: null as number | null };
    const usdDerived = slot.usd
      ? facturadoFromStatement(
          accountId,
          slot.usd.statement_date,
          slot.usd,
          slot.usd.statement_date_iso
        )
      : { facturado_clp: null as number | null, facturado_usd: null as number | null };

    const facturadoClp =
      slot.clp?.monto_facturado != null && slot.clp.monto_facturado > 0
        ? Math.round(slot.clp.monto_facturado)
        : clpDerived.facturado_clp;
    const facturadoUsd =
      slot.usd?.monto_facturado != null && slot.usd.monto_facturado > 0
        ? slot.usd.monto_facturado
        : usdDerived.facturado_usd;

    const { pay_by, pay_by_iso: payByIso } = resolveFacturacionPayBy(slot, primary);
    const facturadoUsdClp =
      facturadoUsd != null
        ? usdToClpAtPayBy(facturadoUsd, payByIso) ?? usdDerived.facturado_clp
        : null;
    const facturadoTotal = facturadoTotalClpForStatementSlot(accountId, slot);

    out.push({
      billing_month: billingMonth,
      close_date: primary.statement_date,
      close_date_iso: primary.statement_date_iso,
      pay_by,
      pay_by_iso: payByIso,
      facturado_clp: facturadoClp,
      facturado_usd: facturadoUsd,
      facturado_usd_clp: facturadoUsdClp,
      facturado_total_clp: facturadoTotal,
      cuota_a_pagar_clp: cuotaForPayByMonth(payByIso, ledgerMonths),
    });
  }

  out.sort((a, b) => b.billing_month.localeCompare(a.billing_month));
  return out;
}
