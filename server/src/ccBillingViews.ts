import { addCalendarMonths } from "./ccYearMonth.js";
import {
  balanceUsdFxDateIso,
  incrementalChargesClpForBillingMonth,
  listCcBillingMonthBalances,
  facturadoFromStatement,
  openMonthUsdFacturado,
  payByFxDateIso,
  postCloseLiveBalanceAdjustmentsClp,
  type CcBillingMonthBalanceRow,
} from "./ccBillingBalances.js";
import { effectiveCcExpenseLineAmountClp } from "./ccExpenseAmountClp.js";
import {
  accountHasUsdStatements,
  facturacionUsdRatesForAccount,
  type FacturacionUsdRateSource,
} from "./ccFacturacionUsdRate.js";
import { withCcOneShotScanCache } from "./ccCrossImportDedupe.js";
import {
  statementSlotsByBillingMonth,
  type CcStatementSlotByCurrency,
} from "./ccBillingStatementSlots.js";
import {
  ccInstallmentLedgerRowCount,
  ccLedgerMonthEndIso,
  creditCardInstallmentPaymentsByBillingMonth,
  installmentRemainingClpByCalendarMonth,
  liveCreditCardOutstandingClp,
} from "./ccInstallmentLedgerDb.js";
import { creditCardBillingDetailInactive } from "./ccBillingInactive.js";
import {
  billingMonthForManualLedgerPurchase,
  closeDateForBillingMonth,
  pdfClosedBillingMonthsForAccount,
  provisionallyClosedBillingMonthsForAccount,
} from "./ccManualBillingMonth.js";
import { ddMmYyyyFromIso, feedBillingCloseForMonth, type CcCloseSource } from "./ccBillingCloses.js";
import type { CcCuotaPurchaseKind } from "./ccCuotaPurchaseKinds.js";
import { statementDatesForFacturacion } from "./ccOpenWebPastePdfReconcile.js";
import { parseOpenWebPasteBillingMonth } from "./ccOpenWebPasteRepair.js";
import { oneShotStatementLineIdsSupersededByInstallmentPurchases } from "./ccCrossImportDedupe.js";
import { isCcPaymentOrUsdDebtAbonoMerchant } from "./ccPaymentLines.js";
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
  /**
   * Closed at the bank, statement not imported yet (see `isProvisionallyClosedBillingMonth`):
   * facturado is the feed's SALDO INICIAL when the feed observed the close, else the app's
   * estimate. Statement-framed like a closed month so the next month's roll starts from it.
   */
  provisional?: boolean;
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
  /** Closed at the bank, statement pending (feed SALDO INICIAL or a passed announced close). */
  is_provisional_close: boolean;
  /** Where `close_date` comes from; `estimated` = config cycle, nothing published by the bank. */
  close_date_source: CcCloseSource;
  /** Provisional month with the bank's total: what the app had estimated for it (únicos + cuotas). */
  provisional_estimate_total_clp: number | null;
  /**
   * The USD/CLP rate this facturación's dollar charges show at — `facturado_usd_clp` and its
   * expense lines: the rate actually paid, today's while unpaid (`ccFacturacionUsdRate.ts`).
   * Null on a card that never billed in dollars.
   */
  usd_rate_clp: number | null;
  usd_rate_source: FacturacionUsdRateSource | null;
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

/**
 * Cupo en cuotas of a billing month. The live cupo — every cuota still unpaid, the ones just
 * billed included (the bank's «cupo utilizado en cuotas») — is the OPEN month's frame. A closed
 * month, by statement or provisionally, carries its billed cuotas inside facturado, so its cupo is
 * the plan remainder after it. The rule used to key on the calendar month, which handed a month
 * closed on the 24th the live figure until the 31st and counted its billed cuotas twice: the
 * provisionally closed 2026-09 ·0901 row read 1x,xx M against an 8,xx M owed walk (first cuotas
 * only on statement-closed months, whose later cuotas the live figure already treats as paid).
 *
 * The live figure learns a cuota was billed from the statement that prints it, so while a month is
 * only provisionally closed its cuotas still count as unbilled there. The open month subtracts them
 * (`provisionalBilledCuotasClp`): the bank moved them into that month's facturado at the close, and
 * without it the open row carried them on top of the provisional row that already bills them —
 * 2026-10 ·0901 read 7,xx M of cuota debt against September's 5,xx M until the September
 * statement arrived.
 */
function cupoEnCuotasForBillingMonth(
  billingMonth: string,
  cupoLive: number,
  openBillingMonth: string | null,
  remainingAfterMonth: ReadonlyMap<string, number>,
  pendingCuotaPurchases: ReadonlyMap<string, number>,
  provisionalBilledCuotasClp: number
): number {
  // Feed-typed cuota purchases with no plan yet are installment debt from their purchase date:
  // all of them are part of the debt «now», and a closed month still owes its own in full
  // (nothing of a cuota comercio is billed in its cycle; a precio contado's first cuota, which is,
  // is the one small overlap left until the statement's plan replaces the line).
  if (openBillingMonth && billingMonth === openBillingMonth) {
    let pending = 0;
    for (const v of pendingCuotaPurchases.values()) pending += v;
    return Math.max(0, cupoLive - provisionalBilledCuotasClp) + pending;
  }
  // Not `cupoEnCuotasClpForCalendarMonth`: that one also swaps in the live figure for the
  // current calendar month, which is exactly the double count described above.
  return (remainingAfterMonth.get(billingMonth) ?? 0) + (pendingCuotaPurchases.get(billingMonth) ?? 0);
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
      ? usdToClpAsDebt(facturadoUsd, payByIso) ?? usdDerived.facturado_clp
      : null;
  const total = (facturadoClp ?? 0) + (facturadoUsdClp ?? 0);
  return total > 0 ? total : null;
}

const stmtPaymentLinesForStatement = db.prepare(`
  SELECT merchant, amount_clp, amount_usd FROM cc_statement_lines WHERE statement_id = ?
`);

/**
 * Sum PAGO / ABONO / ABONO DE DIVISAS lines in a billing month, in CLP (DB stores payments as
 * negative). The divisas abono is a USD-only line (`amount_clp` 0) — it is valued through
 * `effectiveCcExpenseLineAmountClp` at `balanceUsdFxDateIso`, the exact helper + FX date the
 * open-cycle charge sums use, so the open-month balance roll (charges − payments) is unchanged
 * by classifying it as a payment instead of a negative charge.
 */
export function paymentAbonosClpForBillingMonth(
  accountId: number,
  billingMonth: string
): number {
  let sum = 0;
  const dates = new Set(statementDatesForFacturacion(accountId, billingMonth));
  for (const st of listCcStatementsForAccount(accountId)) {
    if (!dates.has(st.statement_date)) continue;
    const fxDateIso = balanceUsdFxDateIso(accountId, st.statement_date);
    const rows = stmtPaymentLinesForStatement.all(st.id) as {
      merchant: string | null;
      amount_clp: number | null;
      amount_usd: number | null;
    }[];
    for (const r of rows) {
      if (!isCcPaymentOrUsdDebtAbonoMerchant(r.merchant)) continue;
      const clp = effectiveCcExpenseLineAmountClp(
        {
          installment_flag: 0,
          amount_clp: r.amount_clp,
          amount_usd: r.amount_usd,
          valor_cuota_mensual_clp: null,
          valor_cuota_mensual_usd: null,
          statement_currency: st.currency,
        },
        fxDateIso
      );
      if (clp == null || !Number.isFinite(clp)) continue;
      sum += Math.abs(clp);
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
  // A cuota purchase the feed typed but whose plan is not known yet is not billed in its cycle
  // (cuota comercio: nothing; precio contado: one cuota of an unknown count) — `ccFeedCuotaPurchases.ts`.
  const pendingCuotaPurchases = cuotaPurchaseLinesClpByBucketMonth(accountId).get(billingMonth) ?? 0;
  const charges = incrementalChargesClpForBillingMonth(accountId, billingMonth) - pendingCuotaPurchases;
  return charges > 0 ? Math.round(charges) : 0;
}

const selCuotaPurchaseLines = db.prepare<[number]>(
  `SELECT l.id, l.merchant, l.transaction_date, l.posting_date, l.amount_clp, l.cuota_purchase_kind,
          s.source_pdf
   FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
   WHERE s.account_id = ? AND s.source_pdf LIKE 'import:web-paste|open|%'
     AND l.cuota_purchase_kind IS NOT NULL
   ORDER BY l.id`
);

/** A feed-typed cuota purchase still waiting for its plan: the count is not known yet. */
export type CcPendingCuotaPurchase = {
  statement_line_id: number;
  merchant: string | null;
  /** Purchase date (ISO) — installment debt from this day, like a plan's contract. */
  purchase_date: string;
  /** Full principal (CLP), what the feed listed. */
  amount_clp: number;
  kind: CcCuotaPurchaseKind;
  /** The open-bucket facturación the line sits in (`YYYY-MM`). */
  billing_month: string;
};

/**
 * Feed-typed cuota purchases whose plan is not known yet (`cuota_purchase_kind`, see
 * `ccFeedCuotaPurchases.ts`). A line a plan already supersedes is excluded — the plan carries it.
 * One list for every reader: the cupo figures, the daily «deuda en cuotas» walk, the projected
 * rows and the card page's «¿cuántas cuotas?» notice.
 */
export function pendingCuotaPurchaseLines(accountId: number): CcPendingCuotaPurchase[] {
  const rows = selCuotaPurchaseLines.all(accountId) as {
    id: number;
    merchant: string | null;
    transaction_date: string | null;
    posting_date: string | null;
    amount_clp: number | null;
    cuota_purchase_kind: CcCuotaPurchaseKind;
    source_pdf: string;
  }[];
  if (rows.length === 0) return [];
  const superseded = oneShotStatementLineIdsSupersededByInstallmentPurchases(accountId);
  const out: CcPendingCuotaPurchase[] = [];
  for (const r of rows) {
    if (superseded.has(r.id)) continue;
    const bm = parseOpenWebPasteBillingMonth(r.source_pdf);
    if (!bm) continue;
    const purchaseDate =
      parseDdMmYyToIso(String(r.transaction_date ?? "")) ?? parseDdMmYyToIso(String(r.posting_date ?? ""));
    if (!purchaseDate) {
      throw new Error(`Cuota purchase line ${r.id} (${r.merchant ?? "?"}) has no parseable date`);
    }
    out.push({
      statement_line_id: r.id,
      merchant: r.merchant,
      purchase_date: purchaseDate,
      amount_clp: Math.abs(r.amount_clp ?? 0),
      kind: r.cuota_purchase_kind,
      billing_month: bm,
    });
  }
  return out;
}

/** Σ CLP of {@link pendingCuotaPurchaseLines} per open-bucket month. */
export function cuotaPurchaseLinesClpByBucketMonth(accountId: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of pendingCuotaPurchaseLines(accountId)) {
    out.set(p.billing_month, (out.get(p.billing_month) ?? 0) + p.amount_clp);
  }
  return out;
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


type ProvisionalFacturado = {
  /** `feed` = the bank's billed total (SALDO INICIAL); `estimate` = únicos + cuotas. */
  source: "feed" | "estimate";
  close_iso: string;
  close_ddmmyyyy: string;
  close_source: CcCloseSource;
  pay_by_iso: string | null;
  facturado_clp: number;
  facturado_usd: number | null;
  facturado_usd_clp: number | null;
  total_clp: number;
  /** The app's own estimate for the month (únicos billed so far + cuota a pagar). */
  estimate_total_clp: number;
};

function signedUsdToClpAsDebt(usd: number, payByIso: string | null): number | null {
  if (usd === 0) return 0;
  const abs = usdToClpAsDebt(Math.abs(usd), payByIso);
  return abs == null ? null : usd < 0 ? -abs : abs;
}

/**
 * Facturado of a provisionally closed month. When the feed observed the close, the bank already
 * stated the billed total per currency (SALDO INICIAL = «Monto total facturado», verified against
 * statements) and it replaces the app's estimate outright; the USD side is valued as debt
 * (pay-by − 1) like a statement's — the facturaciones row then shows it at its own rate. When
 * only the announced close has passed, the estimate stands.
 */
function provisionalFacturado(
  accountId: number,
  billingMonth: string,
  cuotaAPagarClp: number
): ProvisionalFacturado {
  const close = closeDateForBillingMonth(accountId, billingMonth);
  const pay_by_iso = resolveInstallmentPayByIso({ statement_date: close.close_iso });
  const estimate_total_clp = openMonthFacturadoTotalClp(accountId, billingMonth, cuotaAPagarClp);
  const base = {
    close_iso: close.close_iso,
    close_ddmmyyyy: close.close_ddmmyyyy,
    close_source: close.source,
    pay_by_iso,
    estimate_total_clp,
  };
  const feed = feedBillingCloseForMonth(accountId, billingMonth);
  if (!feed) {
    const openUsd = openMonthUsdFacturado(accountId, billingMonth);
    const usdClp = openUsd.usd !== 0 || openUsd.clp !== 0 ? Math.round(openUsd.clp) : null;
    return {
      ...base,
      source: "estimate",
      facturado_clp: estimate_total_clp - (usdClp ?? 0),
      facturado_usd: usdClp != null ? openUsd.usd : null,
      facturado_usd_clp: usdClp,
      total_clp: estimate_total_clp,
    };
  }
  const facturado_clp = Math.round(feed.saldo_inicial_clp ?? 0);
  const facturado_usd = feed.saldo_inicial_usd;
  const facturado_usd_clp =
    facturado_usd != null ? signedUsdToClpAsDebt(facturado_usd, pay_by_iso) : null;
  if (facturado_usd != null && facturado_usd !== 0 && facturado_usd_clp == null) {
    throw new Error(
      `Account ${accountId} ${billingMonth}: no USD/CLP rate for the pay-by ${pay_by_iso} of the ` +
        `feed-observed close — cannot value its US$${facturado_usd} SALDO INICIAL`
    );
  }
  return {
    ...base,
    source: "feed",
    facturado_clp,
    facturado_usd,
    facturado_usd_clp,
    total_clp: facturado_clp + (facturado_usd_clp ?? 0),
  };
}

/**
 * Balance total for a billing month (Detalle por mes / historial / month-end valuation
 * anchors): facturado (which carries the cuotas billed at that close) + the plan remainder.
 *
 * The cupo term here is the plan remainder — cuotas with due month strictly AFTER the billing
 * month (`installmentRemainingClpByCalendarMonth`), for every month but the open one (see
 * `cupoEnCuotasForBillingMonth`) — so the just-billed cuota appears exactly once, inside
 * facturado. The pre-2026-08 form additionally subtracted
 * `cuota_a_pagar_next_mes`, a netting that assumes a cupo figure which still CONTAINS the
 * billed cuota (the bank's live «cupo utilizado en cuotas», which only frees it when the
 * payment posts); with the post-close remainder actually fed here it removed the billed
 * cuota twice, sinking every closed month-end anchor one cuota below true owed. Provably
 * wrong at the floor: after the 2025-01 facturación was paid in full (2025-01-31) the ·0781
 * anchor read $2.xxx.xxx — below the $3.xxx.xxx still owed in unbilled cuotas alone.
 */
export function billingDetailBalanceClp(
  facturadoClp: number | null,
  cupoEnCuotasClp: number
): number {
  return (facturadoClp ?? 0) + cupoEnCuotasClp;
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
  const pdfClosed = pdfClosedBillingMonthsForAccount(accountId);
  const inactive = creditCardBillingDetailInactive(accountId);
  // Closed at the bank, statement pending: a row even without bucket lines, statement-framed.
  const provisionalMonths = inactive
    ? new Set<string>()
    : provisionallyClosedBillingMonthsForAccount(accountId);
  const months = new Set<string>();
  for (const r of balances) {
    months.add(r.billing_month);
  }
  for (const bm of slots.keys()) {
    months.add(bm);
  }
  for (const bm of provisionalMonths) {
    months.add(bm);
  }

  const lastStatementBillingMonth =
    inactive && slots.size > 0
      ? [...slots.keys()].sort((a, b) => a.localeCompare(b)).at(-1) ?? null
      : null;

  const openBmRoll = billingMonthForManualLedgerPurchase(accountId);
  const remainingAfterMonth = installmentRemainingClpByCalendarMonth(accountId);
  const pendingCuotaPurchases = cuotaPurchaseLinesClpByBucketMonth(accountId);
  // Cuotas the bank billed at a close whose statement has not arrived (see the cupo rule).
  let provisionalBilledCuotasClp = 0;
  for (const bm of provisionalMonths) {
    if (openBmRoll == null || bm < openBmRoll) {
      provisionalBilledCuotasClp += cuotaAPagarNextMesClp(bm, ledgerMonths);
    }
  }
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
    if (!snap && !primary && !provisionalMonths.has(billingMonth)) continue;

    const fromStatement = slot ? facturadoTotalClpForStatementSlot(accountId, slot) : null;
    const fromBalance =
      snap?.as_of_kind === "statement" &&
      snap.facturado_clp != null &&
      snap.facturado_clp > 0
        ? snap.facturado_clp
        : null;
    let totalFacturado = fromStatement ?? fromBalance;

    const hasPdfClose = pdfClosed.has(billingMonth);
    const cuotaNext = cuotaAPagarNextMesClp(billingMonth, ledgerMonths);
    const provisional =
      !hasPdfClose && provisionalMonths.has(billingMonth)
        ? provisionalFacturado(accountId, billingMonth, cuotaNext)
        : null;
    if (provisional) {
      // Closed at the bank: the billed total (the feed's, else the estimate) at the real close.
      totalFacturado = provisional.total_clp;
    } else if (!hasPdfClose && !inactive) {
      // Open month: facturado is what is billed this cycle (matches Facturaciones), not the
      // prior balance rolled forward.
      totalFacturado = openMonthFacturadoTotalClp(accountId, billingMonth, cuotaNext);
    }

    const kind: "statement" | "manual" = provisional
      ? "statement"
      : !hasPdfClose && primary != null
        ? "manual"
        : primary != null
          ? "statement"
          : snap?.as_of_kind === "manual"
            ? "manual"
            : "statement";
    const asOfDate =
      provisional?.close_iso ??
      primary?.statement_date_iso ??
      snap?.as_of_date ??
      `${billingMonth}-01`;

    const cupo = cupoEnCuotasForBillingMonth(
      billingMonth,
      cupoLive,
      openBmRoll,
      remainingAfterMonth,
      pendingCuotaPurchases,
      provisionalBilledCuotasClp
    );
    const balanceTotal = billingDetailBalanceClp(totalFacturado, cupo);
    out.push({
      billing_month: billingMonth,
      as_of_date: asOfDate,
      as_of_kind: kind,
      total_facturado_actual_clp: totalFacturado,
      total_facturado_clp: totalFacturado,
      cupo_en_cuotas_clp: cupo,
      cuota_a_pagar_next_mes_clp: cuotaNext,
      balance_total_clp: balanceTotal,
      ...(provisional ? { provisional: true } : {}),
    });
  }

  // Roll the most-recently-closed month's balance into the open month.
  // Balance = priorClosedBalance + (charges this cycle − payments this cycle).
  // This means: before any PAGO row is imported, open month mirrors the closed balance.
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

  // A cuota purchase whose count is not known yet has no schedule: it stays installment debt, flat,
  // until its plan replaces it — the daily walk carries it the same way, so the charts agree.
  let pendingCuotaPurchasesClp = 0;
  for (const v of cuotaPurchaseLinesClpByBucketMonth(accountId).values()) pendingCuotaPurchasesClp += v;

  const projected: CcBillingDetailMonthRow[] = [];
  for (const ym of [...candidateMonths].sort(ymCompare)) {
    if (ymCompare(ym, lastDetalleYm) <= 0) continue;
    if (ymCompare(ym, maxProjectedYm) > 0) continue;
    if (existingMonths.has(ym)) continue;
    if (!monthHasProjectedData(ym)) continue;

    const cupo = owedAtMonthEnd(ym) + pendingCuotaPurchasesClp;
    const cuotaNext = cuotaAPagarNextMesClp(ym, ledgerMonths);
    projected.push({
      billing_month: ym,
      as_of_date: `${ym}-01`,
      as_of_kind: "manual",
      total_facturado_actual_clp: null,
      total_facturado_clp: null,
      cupo_en_cuotas_clp: cupo,
      cuota_a_pagar_next_mes_clp: cuotaNext,
      balance_total_clp: billingDetailBalanceClp(null, cupo),
      projected: true,
    });
  }

  return projected.length > 0 ? [...existing, ...projected] : existing;
}

/** USD valued as debt for a facturación paid by `payByIso`: the pay-by − 1 rate (`balanceUsdFxDateIso`). */
function usdToClpAsDebt(usd: number, payByIso: string | null): number | null {
  if (!Number.isFinite(usd) || usd <= 0 || !payByIso) return null;
  const fx = fxMonthEndForBalanceUsd(payByFxDateIso(payByIso));
  if (!fx?.clp_per_usd || fx.clp_per_usd <= 0) return null;
  return Math.round(usd * fx.clp_per_usd);
}

/**
 * Re-values each facturación's dollar side at the rate it shows — the rate actually paid, today's
 * while unpaid (`ccFacturacionUsdRate.ts`) — instead of the debt frame the builder uses (pay-by − 1,
 * which the detalle, the owed walk and the month-end anchors keep). `facturado_clp` is untouched,
 * so the total is its CLP side plus the re-valued dollars.
 */
function applyFacturacionUsdRates(accountId: number, rows: CcFacturacionRow[]): void {
  if (!accountHasUsdStatements(accountId)) return;
  const rates = facturacionUsdRatesForAccount(accountId, rows);
  for (const row of rows) {
    const rate = rates.get(row.billing_month);
    if (!rate) throw new Error(`Account ${accountId}: no USD rate for facturación ${row.billing_month}`);
    row.usd_rate_clp = rate.clp_per_usd;
    row.usd_rate_source = rate.source;
    if (row.facturado_usd == null) continue;
    const shown = Math.round(row.facturado_usd * rate.clp_per_usd);
    const total = (row.facturado_clp ?? 0) + shown;
    row.facturado_usd_clp = shown;
    row.facturado_total_clp = row.facturado_total_clp == null && total <= 0 ? null : total;
  }
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
  return { pay_by: ddMmYyyyFromIso(payByIso), pay_by_iso: payByIso };
}

export function buildFacturaciones(
  accountId: number,
  ledgerMonths: CcInstallmentMonthRow[]
): CcFacturacionRow[] {
  return withCcOneShotScanCache(() => buildFacturacionesInner(accountId, ledgerMonths));
}

/**
 * Each facturación's pay-by (ISO), as the facturaciones table shows it: a statement-closed month's
 * printed PAGAR HASTA (else derived from its close), an open or provisionally closed month's 10th
 * after its best published close. A month the table has no row for yet (the open month before any
 * bucket or statement has landed in it, while a stale bucket's leftovers already belong to it, see
 * `facturacionMonthByStatementDate`) resolves the way its open row would. Throws when a facturación
 * has no resolvable pay-by, so nothing dated by it drops out silently.
 */
export function facturacionPayByIsoResolver(
  accountId: number,
  facturaciones: readonly Pick<CcFacturacionRow, "billing_month" | "pay_by_iso">[]
): (billingMonth: string) => string {
  const byMonth = new Map<string, string | null>(
    facturaciones.map((f) => [f.billing_month, f.pay_by_iso])
  );
  return (billingMonth) => {
    if (!byMonth.has(billingMonth)) {
      const close = closeDateForBillingMonth(accountId, billingMonth);
      byMonth.set(billingMonth, resolveInstallmentPayByIso({ statement_date: close.close_iso }));
    }
    const iso = byMonth.get(billingMonth);
    if (!iso) {
      throw new Error(`Account ${accountId}: facturación ${billingMonth} has no resolvable pay-by date`);
    }
    return iso;
  };
}

/**
 * The USD/CLP rate a facturación's dollar lines show at: its row's `usd_rate_clp`, so its expense
 * lines add up to the row. A month the table has no row for yet (the open month before any bucket
 * lands in it, while a stale bucket's leftovers already belong to it) gets the rate its open row
 * would carry. Throws on a card that never billed in dollars (it has no rate).
 */
export function facturacionUsdRateResolver(
  accountId: number,
  facturaciones: readonly CcFacturacionRow[]
): (billingMonth: string) => number {
  const byMonth = new Map<string, number | null>(
    facturaciones.map((f) => [f.billing_month, f.usd_rate_clp])
  );
  return (billingMonth) => {
    if (!byMonth.has(billingMonth)) {
      const close = closeDateForBillingMonth(accountId, billingMonth).close_iso;
      const rates = facturacionUsdRatesForAccount(accountId, [
        ...facturaciones,
        {
          billing_month: billingMonth,
          close_date_iso: close,
          pay_by_iso: resolveInstallmentPayByIso({ statement_date: close }),
        },
      ]);
      byMonth.set(billingMonth, rates.get(billingMonth)!.clp_per_usd);
    }
    const rate = byMonth.get(billingMonth);
    if (rate == null) {
      throw new Error(`Account ${accountId}: facturación ${billingMonth} has no USD rate for its dollar lines`);
    }
    return rate;
  };
}

function buildFacturacionesInner(
  accountId: number,
  ledgerMonths: CcInstallmentMonthRow[]
): CcFacturacionRow[] {
  const byMonth = statementSlotsByBillingMonth(accountId);
  const pdfClosed = pdfClosedBillingMonthsForAccount(accountId);
  // A card that stopped billing has no statement pending: a close it no longer bills is not a
  // provisional facturación (the detail builder applies the same gate). Without it the retired
  // ·0161 read December 2025 as «provisoria» for good — its November statement announced that close.
  const provisionalMonths = creditCardBillingDetailInactive(accountId)
    ? new Set<string>()
    : provisionallyClosedBillingMonthsForAccount(accountId);

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
        ? usdToClpAsDebt(facturadoUsd, payByIso) ?? usdDerived.facturado_clp
        : null;
    const cuotaAPagarClp = cuotaAPagarNextMesClp(billingMonth, ledgerMonths);
    const cuotaAPagar = cuotaAPagarClp > 0 ? cuotaAPagarClp : null;
    let facturadoTotal = facturadoTotalClpForStatementSlot(accountId, slot);
    const hasPdfClose = pdfClosed.has(billingMonth);
    if (!hasPdfClose && provisionalMonths.has(billingMonth)) {
      out.push(provisionalFacturacionRow(accountId, billingMonth, cuotaAPagarClp));
      continue;
    }
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

    // An open month's bucket is keyed by the config close (an identity, see
    // `statementCloseDdMmYyyyForBillingMonth`); what it shows is the best published close — the
    // previous statement's announced next period — and the pay-by derived from that.
    const openClose = hasPdfClose ? null : closeDateForBillingMonth(accountId, billingMonth);
    const openPayByIso = openClose
      ? resolveInstallmentPayByIso({ statement_date: openClose.close_iso })
      : null;
    out.push({
      billing_month: billingMonth,
      close_date: openClose?.close_ddmmyyyy ?? primary.statement_date,
      close_date_iso: openClose?.close_iso ?? primary.statement_date_iso,
      pay_by: openClose ? (openPayByIso ? ddMmYyyyFromIso(openPayByIso) : null) : pay_by,
      pay_by_iso: openClose ? openPayByIso : payByIso,
      facturado_clp: facturadoClp,
      facturado_usd: facturadoUsd,
      facturado_usd_clp: facturadoUsdClp,
      facturado_total_clp: facturadoTotal,
      cuota_a_pagar_clp: cuotaAPagar,
      is_open_month: !hasPdfClose,
      is_provisional_close: false,
      close_date_source: openClose?.source ?? "statement",
      provisional_estimate_total_clp: null,
      usd_rate_clp: null,
      usd_rate_source: null,
    });
  }
  // A provisional month with no bucket lines still closed at the bank.
  for (const billingMonth of provisionalMonths) {
    if (byMonth.has(billingMonth)) continue;
    out.push(
      provisionalFacturacionRow(
        accountId,
        billingMonth,
        cuotaAPagarNextMesClp(billingMonth, ledgerMonths)
      )
    );
  }

  applyFacturacionUsdRates(accountId, out);
  out.sort((a, b) => b.billing_month.localeCompare(a.billing_month));
  return out;
}

function provisionalFacturacionRow(
  accountId: number,
  billingMonth: string,
  cuotaAPagarClp: number
): CcFacturacionRow {
  const pv = provisionalFacturado(accountId, billingMonth, cuotaAPagarClp);
  return {
    billing_month: billingMonth,
    close_date: pv.close_ddmmyyyy,
    close_date_iso: pv.close_iso,
    pay_by: pv.pay_by_iso ? ddMmYyyyFromIso(pv.pay_by_iso) : null,
    pay_by_iso: pv.pay_by_iso,
    facturado_clp: pv.facturado_clp,
    facturado_usd: pv.facturado_usd,
    facturado_usd_clp: pv.facturado_usd_clp,
    facturado_total_clp: pv.total_clp,
    cuota_a_pagar_clp: cuotaAPagarClp > 0 ? cuotaAPagarClp : null,
    is_open_month: false,
    is_provisional_close: true,
    close_date_source: pv.close_source,
    provisional_estimate_total_clp: pv.source === "feed" ? pv.estimate_total_clp : null,
    usd_rate_clp: null,
    usd_rate_source: null,
  };
}
