import { billingMonthForStatementDate } from "./ccBillingMonth.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import {
  incrementalChargesClpForBillingMonth,
  listCcBillingMonthBalances,
  facturadoFromStatement,
  openMonthUsdFacturado,
  postCloseLiveBalanceAdjustmentsClp,
  type CcBillingMonthBalanceRow,
} from "./ccBillingBalances.js";
import { withCcOneShotScanCache } from "./ccCrossImportDedupe.js";
import { statementSlotsByBillingMonth, type CcStatementSlotByCurrency } from "./ccBillingStatementSlots.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  ccInstallmentLedgerRowCount,
  ccLedgerMonthEndIso,
  creditCardInstallmentPaymentsByBillingMonth,
  cupoEnCuotasClpForCalendarMonth,
  installmentRemainingClpByCalendarMonth,
  liveCreditCardOutstandingClp,
} from "./ccInstallmentLedgerDb.js";
import { creditCardBillingDetailInactive } from "./ccBillingInactive.js";
import { billingMonthForManualLedgerPurchase, isPdfStatementSource } from "./ccManualBillingMonth.js";
import { listStaleOpenWebPasteStatementDates } from "./ccOpenWebPastePdfReconcile.js";
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
  /** Plan-only future month (no statement or balance evidence yet). */
  projected?: boolean;
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
  /** No imported PDF close yet — facturado = únicos + cuota a pagar. */
  is_open_month: boolean;
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

export type { CcStatementSlotByCurrency } from "./ccBillingStatementSlots.js";
export { statementSlotsByBillingMonth } from "./ccBillingStatementSlots.js";

/** CLP and USD facturado headers for a billing-month statement slot (matches buildFacturaciones). */
export function facturadoClpUsdForStatementSlot(
  accountId: number,
  slot: CcStatementSlotByCurrency
): { facturado_clp: number; facturado_usd: number } {
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

  const facturado_clp =
    slot.clp?.monto_facturado != null && slot.clp.monto_facturado > 0
      ? Math.round(slot.clp.monto_facturado)
      : (clpDerived.facturado_clp ?? 0);
  const facturado_usd =
    slot.usd?.monto_facturado != null && slot.usd.monto_facturado > 0
      ? slot.usd.monto_facturado
      : (usdDerived.facturado_usd ?? 0);
  return { facturado_clp, facturado_usd };
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
  const openBm = billingMonthForManualLedgerPurchase(accountId);
  const staleDates =
    openBm === billingMonth
      ? new Set(listStaleOpenWebPasteStatementDates(accountId, billingMonth))
      : null;

  for (const st of listCcStatementsForAccount(accountId)) {
    const staleCarry = staleDates?.has(st.statement_date) === true;
    if (!staleCarry && st.billing_month !== billingMonth) continue;
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

/**
 * Open-month facturado from imported statement lines only (matches facturación modal scope).
 * PAGOs are NOT netted here: a PAGO in the open cycle settles the *prior* facturación, so it
 * must not reduce this cycle's billed únicos. Pasted "últimos movimientos" always carry the
 * prior bill's PAGO (dated post-cierre → lands in the open web-paste bucket); netting it drove
 * the total negative and the clamp collapsed facturado to cuota-only. Matches the closed-month
 * convention (`facturadoFromStatement` = charges + cuotas, payment merchants excluded). Payments
 * belong to the balance roll-forward only (see `buildBillingDetailByMonthInner`). The ≥0 clamp
 * stays for the refund-heavy edge (non-payment negative lines still net inside the sum).
 */
export function facturadoClpFromOpenMonthStatementLines(
  accountId: number,
  billingMonth: string
): number {
  const charges = incrementalChargesClpForBillingMonth(accountId, billingMonth);
  return charges > 0 ? Math.round(charges) : 0;
}

/**
 * Open-month facturado: what is billed in THIS facturación cycle — charges/únicos billed so
 * far plus the cuota a pagar — not the prior balance rolled forward, and not net of the prior
 * bill's PAGO. Shared by Facturaciones and Detalle por mes so both views report the same facturado.
 */
export function openMonthFacturadoTotalClp(
  accountId: number,
  billingMonth: string,
  cuotaAPagarClp: number
): number {
  const uniquo = facturadoClpFromOpenMonthStatementLines(accountId, billingMonth);
  return uniquo + cuotaAPagarClp;
}


/** Same balance rule as Detalle por mes / historial (closed statement months subtract next cuota). */
export function billingDetailBalanceClp(
  facturadoClp: number | null,
  cupoEnCuotasClp: number,
  cuotaAPagarNextMesClp: number,
  hasPdfClose: boolean
): number {
  return hasPdfClose
    ? (facturadoClp ?? 0) + cupoEnCuotasClp - cuotaAPagarNextMesClp
    : (facturadoClp ?? 0) + cupoEnCuotasClp;
}

function cuotaAPagarNextMesClp(
  billingMonth: string,
  ledgerMonths: CcInstallmentMonthRow[]
): number {
  // Plan months are statement/facturación months: the cuotas billed at this month's close
  // (payable ~10th of the next month) live at the billing month itself. The old +1 /
  // pay-by-month lookup read the NEXT cycle's cuotas — nearly equal for constant-cuota
  // plans, wrong at every plan start/end.
  const row = ledgerMonths.find((m) => m.month === billingMonth);
  return row && row.total_clp > 0 ? row.total_clp : 0;
}

export function buildBillingDetailByMonth(
  accountId: number,
  ledgerMonths: CcInstallmentMonthRow[] = []
): CcBillingDetailMonthRow[] {
  // Memoize the account-level one-shot scans for this synchronous build (read-only).
  return withCcOneShotScanCache(() => buildBillingDetailByMonthInner(accountId, ledgerMonths));
}

function buildBillingDetailByMonthInner(
  accountId: number,
  ledgerMonths: CcInstallmentMonthRow[]
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
    const cuotaNext = cuotaAPagarNextMesClp(billingMonth, ledgerMonths);
    if (!hasPdfClose && !inactive) {
      // Open month: facturado is what is billed this cycle (matches Facturaciones), not the
      // prior balance rolled forward.
      totalFacturado = openMonthFacturadoTotalClp(accountId, billingMonth, cuotaNext);
    }

    const kind: "statement" | "manual" =
      !hasPdfClose && primary != null
        ? "manual"
        : primary != null
          ? "statement"
          : snap?.as_of_kind === "manual"
            ? "manual"
            : "statement";
    const asOfDate =
      primary?.statement_date_iso ?? snap?.as_of_date ?? `${billingMonth}-01`;

    const cupo = cupoEnCuotasForBillingMonth(accountId, billingMonth, cupoLive);
    const balanceTotal = billingDetailBalanceClp(
      totalFacturado,
      cupo,
      cuotaNext,
      hasPdfClose || inactive
    );
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

  // Roll the most-recently-closed month's balance into the open month.
  // Balance = priorClosedBalance + (charges this cycle − payments this cycle).
  // This means: before any PAGO row is imported, open month mirrors the closed balance.
  const openBmRoll = billingMonthForManualLedgerPurchase(accountId);
  if (openBmRoll && !inactive) {
    const openIdx = out.findIndex((r) => r.billing_month === openBmRoll);
    if (openIdx >= 0) {
      const priorClosed = out
        .filter((r) => r.billing_month < openBmRoll && r.as_of_kind === "statement")
        .sort((a, b) => b.billing_month.localeCompare(a.billing_month))[0];
      if (priorClosed) {
        const netCharges =
          incrementalChargesClpForBillingMonth(accountId, openBmRoll) -
          paymentAbonosClpForBillingMonth(accountId, openBmRoll);
        out[openIdx]!.balance_total_clp = Math.round(priorClosed.balance_total_clp + netCharges);
      }
    }
  }

  const withProjected = appendProjectedBillingDetailRows(
    accountId,
    ledgerMonths,
    slots,
    out
  );

  // Live end-of-month balance: closed statement months carry their statement-close anchor plus any
  // activity dated after the close but on/before the calendar month-end (charges +, payments −),
  // billed on a later statement. Runs after the open-month rollforward so its base stays the anchor
  // (no double-counting). The open month is already live via its rollforward; projected rows have
  // no lines so the adjustment is 0.
  const statementRows = withProjected.filter(
    (row) => row.as_of_kind === "statement" && /^\d{4}-\d{2}-\d{2}$/.test(row.as_of_date)
  );
  const adjustments = postCloseLiveBalanceAdjustmentsClp(
    accountId,
    statementRows.map((row) => ({
      closeIso: row.as_of_date,
      monthEndIso: ccLedgerMonthEndIso(row.billing_month),
    }))
  );
  statementRows.forEach((row, i) => {
    const adj = adjustments[i]!;
    if (adj !== 0) row.balance_total_clp = Math.round(row.balance_total_clp + adj);
  });

  withProjected.sort((a, b) => b.billing_month.localeCompare(a.billing_month));
  return withProjected;
}

/**
 * Future billing months: plan cupo + cuota schedule. Months after the open facturación have
 * no facturado (null — nothing billed yet) and saldo = cuotas still OWED at that month-end
 * (pay frame): billing at the close (~20th) is a reclassification, the money leaves on the
 * pay-by (~10th of the next month), so month-end owed = the remainder after the PREVIOUS
 * month's close. The series steps down one facturación per month and lands on a trailing
 * zero month once the final cuota's pay-by has passed.
 */
function appendProjectedBillingDetailRows(
  accountId: number,
  ledgerMonths: CcInstallmentMonthRow[],
  slots: Map<string, CcStatementSlotByCurrency>,
  existing: CcBillingDetailMonthRow[]
): CcBillingDetailMonthRow[] {
  if (ccInstallmentLedgerRowCount(accountId) === 0 || existing.length === 0) {
    return existing;
  }

  const existingMonths = new Set(existing.map((r) => r.billing_month));
  const lastDetalleYm = [...existingMonths].sort((a, b) => b.localeCompare(a))[0]!;
  const payByMonth = creditCardInstallmentPaymentsByBillingMonth(accountId);
  const remainingByMonth = installmentRemainingClpByCalendarMonth(accountId);

  /** Cuotas still owed at month-end `ym`: the plan remainder after (ym − 1)'s close. */
  const owedAtMonthEnd = (ym: string): number =>
    remainingByMonth.get(addCalendarMonths(ym, -1)) ?? 0;
  // A month is worth projecting while a cuota bills at its close, something is still owed at
  // its month-end, or the previous month-end owed something (the trailing month landing at 0).
  const monthHasProjectedData = (ym: string): boolean =>
    (payByMonth.get(ym) ?? 0) > 0 ||
    owedAtMonthEnd(ym) > 0 ||
    owedAtMonthEnd(addCalendarMonths(ym, -1)) > 0;

  const candidateMonths = new Set<string>();
  for (const ym of [...payByMonth.keys(), ...remainingByMonth.keys()]) {
    candidateMonths.add(ym);
    candidateMonths.add(addCalendarMonths(ym, 1));
  }
  let maxProjectedYm: string | null = null;
  for (const ym of candidateMonths) {
    if (ymCompare(ym, lastDetalleYm) <= 0) continue;
    if (!monthHasProjectedData(ym)) continue;
    if (maxProjectedYm == null || ymCompare(ym, maxProjectedYm) > 0) {
      maxProjectedYm = ym;
    }
  }
  if (maxProjectedYm == null) return existing;

  const projected: CcBillingDetailMonthRow[] = [];
  for (const ym of [...candidateMonths].sort(ymCompare)) {
    if (ymCompare(ym, lastDetalleYm) <= 0) continue;
    if (ymCompare(ym, maxProjectedYm) > 0) continue;
    if (existingMonths.has(ym)) continue;
    if (!monthHasProjectedData(ym)) continue;

    const cupo = owedAtMonthEnd(ym);
    const cuotaNext = cuotaAPagarNextMesClp(ym, ledgerMonths);
    projected.push({
      billing_month: ym,
      as_of_date: `${ym}-01`,
      as_of_kind: "manual",
      total_facturado_actual_clp: null,
      total_facturado_clp: null,
      cupo_en_cuotas_clp: cupo,
      cuota_a_pagar_next_mes_clp: cuotaNext,
      balance_total_clp: billingDetailBalanceClp(null, cupo, cuotaNext, false),
      projected: true,
    });
  }

  return projected.length > 0 ? [...existing, ...projected] : existing;
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

export function buildFacturaciones(
  accountId: number,
  ledgerMonths: CcInstallmentMonthRow[]
): CcFacturacionRow[] {
  return withCcOneShotScanCache(() => buildFacturacionesInner(accountId, ledgerMonths));
}

function buildFacturacionesInner(
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

    let facturadoClp =
      slot.clp?.monto_facturado != null && slot.clp.monto_facturado > 0
        ? Math.round(slot.clp.monto_facturado)
        : clpDerived.facturado_clp;
    let facturadoUsd =
      slot.usd?.monto_facturado != null && slot.usd.monto_facturado > 0
        ? slot.usd.monto_facturado
        : usdDerived.facturado_usd;

    const { pay_by, pay_by_iso: payByIso } = resolveFacturacionPayBy(slot, primary);
    let facturadoUsdClp =
      facturadoUsd != null
        ? usdToClpAtPayBy(facturadoUsd, payByIso) ?? usdDerived.facturado_clp
        : null;
    const cuotaAPagarClp = cuotaAPagarNextMesClp(billingMonth, ledgerMonths);
    const cuotaAPagar = cuotaAPagarClp > 0 ? cuotaAPagarClp : null;
    let facturadoTotal = facturadoTotalClpForStatementSlot(accountId, slot);
    const hasPdfClose = hasPdfStatementCloseForBillingMonth(slot);
    if (!hasPdfClose) {
      // Open month: "facturado" is what is billed in THIS cycle — únicos billed so far plus
      // the cuota a pagar — not the prior unpaid balance rolled forward. Detalle por mes uses
      // the same helper so both views report the same facturado.
      facturadoTotal = openMonthFacturadoTotalClp(accountId, billingMonth, cuotaAPagar ?? 0);
      // Manually-entered USD purchases in the open cycle are billed too — split them out of the
      // total so they show as the US$ stacked bar instead of being lumped into facturado_clp.
      const openUsd = openMonthUsdFacturado(accountId, billingMonth);
      if (openUsd.usd !== 0 || openUsd.clp !== 0) {
        facturadoUsd = openUsd.usd;
        facturadoUsdClp = Math.round(openUsd.clp);
      }
      facturadoClp = facturadoTotal - (facturadoUsdClp ?? 0);
    }

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
      cuota_a_pagar_clp: cuotaAPagar,
      is_open_month: !hasPdfClose,
    });
  }

  out.sort((a, b) => b.billing_month.localeCompare(a.billing_month));
  return out;
}
