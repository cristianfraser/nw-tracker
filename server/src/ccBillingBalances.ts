import { addCalendarMonths } from "./ccYearMonth.js";
import {
  cacheKeyCcBillingDetail,
  getAggregationCached,
  invalidateCcBillingDetail,
} from "./aggregationCache.js";
import { ddMmYyyyFromIso } from "./ccBillingCloses.js";
import {
  effectiveCcExpenseLineAmountClp,
  effectiveCcExpenseLineAmountUsd,
} from "./ccExpenseAmountClp.js";
import { oneShotStatementLineIdsSupersededByInstallmentPurchases } from "./ccCrossImportDedupe.js";
import {
  isInstallmentContractSummaryMerchant,
  redundantInstallmentSummaryLineIds,
  type CcStatementLineForInstallmentTotals,
} from "./ccInstallmentLineDedupe.js";
import {
  normalizeTransactionDateIso,
  parseDdMmYyToIso,
  resolveInstallmentPayByIso,
  statementLineDateIso,
} from "./ccInstallmentPayBy.js";
import { ccTraspasoLinkedClpByUsdLineId } from "./ccTraspasoDeudaLinks.js";
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { billingMonthForStatementDate, loadCreditCardBillingConfig } from "./ccBillingMonth.js";
import { ledgerFacturadoClpForBillingMonth } from "./ccInstallmentLedgerDb.js";
import { listCcStatementsForAccount } from "./ccStatementsDb.js";
import { fxMonthEndForBalanceUsd } from "./fxRates.js";
import { creditCardBillingDetailInactive } from "./ccBillingInactive.js";
import { billingMonthForManualLedgerPurchase } from "./ccManualBillingMonth.js";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import { facturadoClpUsdForStatementSlot } from "./ccBillingViews.js";
import { statementDatesForFacturacion } from "./ccOpenWebPastePdfReconcile.js";
import {
  isCcPaymentMerchant,
  isCcPaymentOrUsdDebtAbonoMerchant,
  requireHeaderPagoIso,
} from "./ccPaymentLines.js";
import {
  isClpSection3FinancingChargeMerchant,
  isUsdSection3FinancingChargeMerchant,
} from "./ccStatementSection3.js";
import { statementSlotsByBillingMonth } from "./ccBillingStatementSlots.js";

export type CcBillingMonthBalanceRow = {
  id: number;
  account_id: number;
  billing_month: string;
  as_of_date: string;
  as_of_kind: string;
  facturado_clp: number | null;
  facturado_usd: number | null;
  cupo_utilizado_clp: number;
  saldo_total_clp: number;
  saldo_total_usd: number | null;
};

const upsertBalance = db.prepare(`
  INSERT INTO cc_billing_month_balances (
    account_id, billing_month, as_of_date, as_of_kind,
    facturado_clp, facturado_usd, cupo_utilizado_clp, saldo_total_clp, saldo_total_usd
  ) VALUES (
    @account_id, @billing_month, @as_of_date, @as_of_kind,
    @facturado_clp, @facturado_usd, @cupo_utilizado_clp, @saldo_total_clp, @saldo_total_usd
  )
  ON CONFLICT(account_id, billing_month, as_of_date, as_of_kind) DO UPDATE SET
    facturado_clp = excluded.facturado_clp,
    facturado_usd = excluded.facturado_usd,
    cupo_utilizado_clp = excluded.cupo_utilizado_clp,
    saldo_total_clp = excluded.saldo_total_clp,
    saldo_total_usd = excluded.saldo_total_usd
`);

type RevolvingLineRow = {
  id: number;
  merchant: string | null;
  amount_clp: number | null;
  amount_usd: number | null;
  statement_currency: string;
  installment_flag: number;
  valor_cuota_mensual_clp: number | null;
  valor_cuota_mensual_usd: number | null;
};

const stmtPayByMetaByDate = db.prepare(
  `SELECT pay_by, period_to FROM cc_statements WHERE account_id = ? AND statement_date = ? LIMIT 1`
);

function isoAddDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The debt frame's FX date for a facturación paid by `payByIso`: the day before (see below). */
export function payByFxDateIso(payByIso: string): string {
  return isoAddDays(payByIso, -1);
}

/**
 * FX date for valuing USD credit-card charges as DEBT — the owed walk, month-end anchors, the
 * detalle / stored balances, open-month sums, payments and financing charges: the facturación
 * pay-by date minus one day. A foreign charge settles to CLP at pay-by, so this locks the rate
 * once that date passes (and floats on the latest rate before it), instead of drifting with the
 * statement-close rate. What a facturación SHOWS it cost (its row, the historial bars, its
 * expense lines) is the rate actually paid instead — `ccFacturacionUsdRate.ts`. Import
 * dedupe/matching keeps the raw statement-date FX (it only compares amounts).
 */
export function balanceUsdFxDateIso(accountId: number, statementDate: string): string | null {
  const meta = stmtPayByMetaByDate.get(accountId, statementDate) as
    | { pay_by: string | null; period_to: string | null }
    | undefined;
  const payByIso = resolveInstallmentPayByIso({
    pay_by: meta?.pay_by ?? undefined,
    statement_date: statementDate,
    period_to: meta?.period_to ?? undefined,
  });
  return payByIso ? payByFxDateIso(payByIso) : parseDdMmYyToIso(statementDate);
}

function listRevolvingLineRowsForStatementDate(
  accountId: number,
  statementDate: string
): RevolvingLineRow[] {
  return db
    .prepare(
      `SELECT l.id, l.merchant, l.amount_clp, l.amount_usd, s.currency AS statement_currency,
              l.installment_flag, l.valor_cuota_mensual_clp, l.valor_cuota_mensual_usd
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ? AND s.statement_date = ? AND l.installment_flag = 0`
    )
    .all(accountId, statementDate) as RevolvingLineRow[];
}

function sumRevolvingLinesForAccountStatementDateClp(
  accountId: number,
  statementDate: string,
  opts?: { excludePayments?: boolean; excludeUsdDebtPaymentAbonos?: boolean }
): number {
  const fxDateIso = balanceUsdFxDateIso(accountId, statementDate);
  const rows = listRevolvingLineRowsForStatementDate(accountId, statementDate);
  const superseded = oneShotStatementLineIdsSupersededByInstallmentPurchases(accountId);
  let sum = 0;
  for (const r of rows) {
    if (superseded.has(r.id)) continue;
    if (isInstallmentContractSummaryMerchant(r.merchant)) continue;
    if (opts?.excludePayments && isCcPaymentMerchant(r.merchant)) continue;
    if (
      opts?.excludeUsdDebtPaymentAbonos &&
      isCcPaymentOrUsdDebtAbonoMerchant(r.merchant)
    ) {
      continue;
    }
    const clp = effectiveCcExpenseLineAmountClp(
      { ...r, installment_flag: 0, valor_cuota_mensual_clp: null, valor_cuota_mensual_usd: null },
      fxDateIso
    );
    if (clp != null && Number.isFinite(clp)) sum += clp;
  }
  return sum;
}

/** One-shot charges only (excludes PAGO / ABONO — those are subtracted in open-month roll-forward). */
export function sumRevolvingChargesClpForStatementDate(
  accountId: number,
  statementDate: string
): number {
  return sumRevolvingLinesForAccountStatementDateClp(accountId, statementDate, {
    excludePayments: true,
  });
}

/**
 * Open-cycle variant: additionally excludes «ABONO DE DIVISAS» — the USD-debt payment the daily
 * feed lands in the open web-paste bucket. Like the PAGO it settles the *prior* facturación, so
 * it must not net against this cycle's charges; `paymentAbonosClpForBillingMonth` counts it (at
 * the same FX this walk would have used) so the open-month balance roll (charges − payments) is
 * unchanged by the classification. Kept out of {@link sumRevolvingChargesClpForStatementDate}:
 * that summer also derives facturado for closed header-less legacy USD statements, whose
 * displayed history (and month-end valuation anchors) must not move.
 */
function sumOpenCycleChargesClpForStatementDate(
  accountId: number,
  statementDate: string
): number {
  return sumRevolvingLinesForAccountStatementDateClp(accountId, statementDate, {
    excludePayments: true,
    excludeUsdDebtPaymentAbonos: true,
  });
}

type PostCloseLineRow = RevolvingLineRow & {
  transaction_date: string | null;
  posting_date: string | null;
  statement_date: string;
  dedupe_key: string | null;
};

/**
 * Section-3 bank charge (interés, comisión, impuesto) rather than consumption or a payment —
 * the same test `statementSection3ChargesClpForBillingMonth` sums for the monthly financing
 * cost (at the same FX date), so the flow-based P/L and the monthly sum agree by construction. Refunds (NOTA DE
 * CREDITO, negative amounts) match the section-3 merchant patterns but are negative
 * consumption, not cost, hence the positive-amount guard on both currencies.
 */
function isFinancingChargeLine(r: PostCloseLineRow): boolean {
  if (r.statement_currency === "usd") {
    const usd = r.amount_usd ?? 0;
    return usd > 0 && isUsdSection3FinancingChargeMerchant(r.merchant, usd);
  }
  return (r.amount_clp ?? 0) > 0 && isClpSection3FinancingChargeMerchant(r.merchant);
}

/**
 * Net CLP of owed-changing events whose date falls AFTER a billing month's statement close
 * and ON/BEFORE the calendar month-end — i.e. activity that belongs to the live end-of-month
 * balance but is billed on a later statement: revolving charges (+) and payments (−, incl.
 * header-only pagados synthesized below). Per-month cuota billing lines stay excluded:
 * billing moves debt between facturado/por-facturar, it does not change what is owed.
 * Deduped across statement versions by dedupe key so a transaction billed on both a
 * web-paste and a PDF statement is counted once.
 *
 * `includeInstallmentPurchases` (daily owed walk + daily CC netting ONLY): adds installment
 * purchases at full contract value on their purchase date — cupo is consumed at purchase,
 * so the daily line ramps as you buy instead of stepping at the next anchor. The month-end
 * writer must NOT pass it: its `balance_total` is cupo-based at month-end and already
 * contains contracts made after the cierre (passing it double-counted them, +3.1M on the
 * 2026-06-30 anchor when first tried).
 *
 * Added to the statement-anchored `balance_total` so the Detalle por mes / chart show the true
 * end-of-month liability (e.g. a card paid off within its own closing cycle drops that month,
 * not the next). The statement anchor keeps the series drift-free across missing periods.
 */
export function postCloseLiveBalanceAdjustmentClp(
  accountId: number,
  closeIso: string,
  monthEndIso: string,
  opts?: { includeInstallmentPurchases?: boolean }
): number {
  return postCloseLiveBalanceAdjustmentsClp(accountId, [{ closeIso, monthEndIso }], opts)[0]!;
}

/**
 * Normalized non-installment line stream for post-close windows (the line's date — transaction,
 * else posting — dedupe key, signed CLP), memoized in the aggregation cache under the account's
 * `cc.billing_detail|<id>|…` satellite key — dropped by `invalidateCcBillingDetail` with the
 * detalle cache. Daily owed-on-date evaluates one window per session, so the scan must not
 * re-run per date.
 *
 * `financing` marks section-3 bank charges (intereses, comisiones, impuestos) using the same
 * predicate as the monthly financing-cost metric. They are owed like any other charge — the
 * balance walk ignores the flag — but `ccOwedFlowEvents.ts` withholds them from the flow leg
 * so that a card's P/L is exactly its cost of financing.
 */
export type PostCloseStreamEntry = {
  iso: string;
  key: string;
  clp: number | null;
  financing?: boolean;
  /**
   * `statement_date` (dd/mm/yyyy) of the statement row it sits on — a statement, an open bucket,
   * or the statement whose header carries the payment; null for an installment purchase event.
   * Which facturación that is, is `facturacionMonthByStatementDate`'s call.
   */
  statement_date: string | null;
};

/** Two calendar months before a close: a line dated on or before it, billed at that close, is backdated. */
function backdatedPostingCutoffIso(closeIso: string): string {
  const ym = addCalendarMonths(closeIso.slice(0, 7), -2);
  const lastDay = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
  return `${ym}-${String(Math.min(Number(closeIso.slice(8, 10)), lastDay)).padStart(2, "0")}`;
}

export function normalizedPostCloseLines(accountId: number): PostCloseStreamEntry[] {
  return getAggregationCached(`${cacheKeyCcBillingDetail(accountId)}|postclose_lines`, () => {
    const rows = db
      .prepare(
        `SELECT l.id, l.merchant, l.amount_clp, l.amount_usd, s.currency AS statement_currency,
                l.installment_flag, l.valor_cuota_mensual_clp, l.valor_cuota_mensual_usd,
                l.transaction_date, l.posting_date, s.statement_date, l.dedupe_key
         FROM cc_statement_lines l
         JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ? AND l.installment_flag = 0`
      )
      .all(accountId) as PostCloseLineRow[];
    const superseded = oneShotStatementLineIdsSupersededByInstallmentPurchases(accountId);

    const fxDateByStatementDate = new Map<string, string | null>();
    const fxDateFor = (statementDate: string): string | null => {
      if (!fxDateByStatementDate.has(statementDate)) {
        fxDateByStatementDate.set(statementDate, balanceUsdFxDateIso(accountId, statementDate));
      }
      return fxDateByStatementDate.get(statementDate) ?? null;
    };

    // A linked traspaso-de-deuda USD abono carries minus its CLP twin's booked pesos — the
    // pair is one debt reclassification and must net to exactly zero, never an fx estimate.
    // Unlinked traspaso legs (web-paste pastes, twin statement not imported) keep the fx
    // conversion below until the PDF import links the real pair.
    const traspasoClpByUsdLineId = ccTraspasoLinkedClpByUsdLineId(accountId);

    // clp stays null when FX/amount is unresolvable — the line still consumes its dedupe key
    // inside a window (same as the single-window loop did).
    const lines: PostCloseStreamEntry[] = [];
    for (const r of rows) {
      if (superseded.has(r.id)) continue;
      if (isInstallmentContractSummaryMerchant(r.merchant)) continue;
      // Transaction date, else posting date: a line printing only its posting date used to drop out here.
      let iso = statementLineDateIso(r);
      if (!iso) continue;
      // Dated two cycles or more before the statement that billed it: a backdated posting (a nota de
      // crédito carries the original purchase's date — ·0161's −4xx.xxx dated 22/02/2018 on the
      // June statement, −3xx.xxx dated 18/06/2020 on August's). It entered the debt in that
      // statement's cycle, so the walk and the month-end anchors both take it at that close;
      // dated at the purchase, the walk had counted it months before any anchor did.
      const closeIso = parseDdMmYyToIso(r.statement_date);
      if (closeIso && iso <= backdatedPostingCutoffIso(closeIso)) iso = closeIso;
      const key = r.dedupe_key ?? `${iso}|${r.merchant}|${r.amount_clp}|${r.amount_usd}`;
      const linkedTraspasoClp =
        r.statement_currency === "usd" ? traspasoClpByUsdLineId.get(r.id) : undefined;
      const clp =
        linkedTraspasoClp != null
          ? -linkedTraspasoClp
          : effectiveCcExpenseLineAmountClp(
              { ...r, installment_flag: 0, valor_cuota_mensual_clp: null, valor_cuota_mensual_usd: null },
              fxDateFor(r.statement_date)
            );
      lines.push({
        iso,
        key,
        clp: clp != null && Number.isFinite(clp) ? clp : null,
        ...(isFinancingChargeLine(r) ? { financing: true } : {}),
        statement_date: r.statement_date,
      });
    }

    // Header-only payments (current Santander CLP format): the previous facturación's
    // MONTO CANCELADO is statement meta, never a line — the parser drops the pagado-
    // anterior row by design and only the header carries the amount, with the printed
    // payment date stored alongside (migration 166). Synthesize the PAGO event so the
    // between-anchors daily walk sees payments, not just charges. Legacy statements that
    // DO carry the payment as a real line are skipped (no double count); duplicate
    // statement versions collapse on the shared synthetic key.
    const hdrPagos = db
      .prepare(
        `SELECT statement_date, monto_pagado_anterior AS amt,
                monto_pagado_anterior_date AS pago_iso
         FROM cc_statements
         WHERE account_id = ? AND currency = 'clp'
           AND monto_pagado_anterior IS NOT NULL AND monto_pagado_anterior_date IS NOT NULL`
      )
      .all(accountId) as { statement_date: string; amt: number; pago_iso: string }[];
    for (const s of hdrPagos) {
      const amtAbs = Math.abs(s.amt);
      if (!Number.isFinite(amtAbs) || amtAbs === 0) continue;
      const pagoIso = requireHeaderPagoIso(s.statement_date, s.pago_iso);
      const covered = lines.some(
        (l) => l.iso === pagoIso && l.clp != null && Math.abs(l.clp + amtAbs) < 1
      );
      if (covered) continue;
      lines.push({
        iso: pagoIso,
        key: `hdr-pago|${pagoIso}|${amtAbs}`,
        clp: -amtAbs,
        statement_date: s.statement_date,
      });
    }

    // The dated legs of header payments a statement printed without a date (migration 213):
    // payments like the dated ones above, which the walk and the month-end anchors otherwise
    // never subtracted. A leg is the bank-debit remainder of its header, never a printed line.
    // A dollar leg (migration 218: an old international statement's header abono) is valued like
    // the dollar lines of its statement, at that statement's debt fx.
    const legs = db
      .prepare(`SELECT statement_close_iso, currency, paid_on, amount FROM cc_header_payment_legs WHERE account_id = ?`)
      .all(accountId) as { statement_close_iso: string; currency: "clp" | "usd"; paid_on: string; amount: number }[];
    for (const g of legs) {
      const statementDate = ddMmYyyyFromIso(g.statement_close_iso);
      let clp: number | null = g.amount;
      if (g.currency === "usd") {
        const fxIso = fxDateFor(statementDate);
        const fx = fxIso ? fxMonthEndForBalanceUsd(fxIso)?.clp_per_usd : null;
        clp = fx != null && fx > 0 ? g.amount * fx : null;
      }
      lines.push({
        iso: g.paid_on,
        key: `hdr-leg|${g.statement_close_iso}|${g.currency === "usd" ? "usd|" : ""}${g.paid_on}|${g.amount}`,
        clp: clp != null ? -clp : null,
        statement_date: statementDate,
      });
    }

    return lines;
  });
}

/**
 * Installment purchases as owed events: +full contract value on the purchase date (cupo is
 * consumed at purchase). Consumed only by the daily owed walk / daily CC netting between
 * stored anchors — anchors already carry outstanding cuota principal (cupo-based), and the
 * walk resets at every anchor, so there is no double count. The superseded one-shot lines
 * are dropped from the line stream (they duplicate these contracts) and a nota-cancelled
 * plan self-corrects via its NOTA DE CREDITO revolving line.
 */
export function normalizedInstallmentPurchaseEvents(
  accountId: number
): { iso: string; key: string; clp: number; statement_date: null }[] {
  return getAggregationCached(
    `${cacheKeyCcBillingDetail(accountId)}|instpurchase_events`,
    () => {
      const purchases = db
        .prepare(
          `SELECT id, purchase_date, total_amount_clp FROM cc_installment_purchases
           WHERE account_id = ? AND purchase_date IS NOT NULL AND total_amount_clp IS NOT NULL`
        )
        .all(accountId) as { id: number; purchase_date: string; total_amount_clp: number }[];
      const events: { iso: string; key: string; clp: number; statement_date: null }[] = [];
      for (const pu of purchases) {
        const iso = normalizeTransactionDateIso(pu.purchase_date);
        if (!iso) continue;
        const amt = Math.round(pu.total_amount_clp);
        if (!Number.isFinite(amt) || amt === 0) continue;
        events.push({ iso, key: `inst-purchase|${pu.id}`, clp: amt, statement_date: null });
      }
      return events;
    }
  );
}

/**
 * Batch form of {@link postCloseLiveBalanceAdjustmentClp}: one (memoized) line scan for the
 * account, reused across every (close, month-end] window — the detalle builder calls this
 * once per account instead of re-scanning all lines per billing month.
 */
export function postCloseLiveBalanceAdjustmentsClp(
  accountId: number,
  windows: readonly { closeIso: string; monthEndIso: string }[],
  opts?: { includeInstallmentPurchases?: boolean }
): number[] {
  if (windows.length === 0) return [];
  const anyActive = windows.some(
    (w) => w.closeIso && w.monthEndIso && w.closeIso < w.monthEndIso
  );
  if (!anyActive) return windows.map(() => 0);

  const lines = opts?.includeInstallmentPurchases
    ? [...normalizedPostCloseLines(accountId), ...normalizedInstallmentPurchaseEvents(accountId)]
    : normalizedPostCloseLines(accountId);

  return windows.map((w) => {
    if (!w.closeIso || !w.monthEndIso || w.closeIso >= w.monthEndIso) return 0;
    const seen = new Set<string>();
    let sum = 0;
    for (const l of lines) {
      if (l.iso <= w.closeIso || l.iso > w.monthEndIso) continue;
      if (seen.has(l.key)) continue;
      seen.add(l.key);
      if (l.clp != null) sum += l.clp;
    }
    return sum;
  });
}

/**
 * What a closed facturación's month-end owes beyond its statement: every charge and payment dated
 * on or before the month-end that a later facturación bills, or none yet. Picked by billing, not by
 * date: a Santander purchase dated the close day bills next month (its next cycle starts ON the
 * close day), and a purchase dated days before the close can bill a statement late (·0161,
 * 21/02/2023 → March); a date window starting the day after the close left both out of the
 * month-end anchor, and the daily walk, which resets to the anchor, carried the shortfall to the
 * next one. A line's facturación is its statement row's (`billedMonthByStatementDate`, from
 * `facturacionMonthByStatementDate`, so a provisional month's bucket is billed by that month and a
 * stale bucket by the open one); a line on several statement versions counts as billed by the
 * earliest. A backdated line carries its statement's close as its date (`normalizedPostCloseLines`),
 * so it is billed by then and never counts here. The daily walk's window starts at its anchor's date, not at a close
 * (`postCloseLiveBalanceAdjustmentsClp`).
 */
export function unbilledAtMonthEndAdjustmentsClp(
  accountId: number,
  billedMonthByStatementDate: ReadonlyMap<string, string>,
  windows: readonly { billingMonth: string; monthEndIso: string }[]
): number[] {
  if (windows.length === 0) return [];
  const entries = normalizedPostCloseLines(accountId);
  const firstBilled = new Map<string, string | null>();
  for (const e of entries) {
    let bm: string | null = null;
    if (e.statement_date != null) {
      bm = billedMonthByStatementDate.get(e.statement_date) ?? null;
      if (bm == null) throw new Error(`Account ${accountId}: no facturación for statement date ${e.statement_date}`);
    }
    const prev = firstBilled.get(e.key);
    if (!firstBilled.has(e.key) || (bm != null && (prev == null || bm < prev))) firstBilled.set(e.key, bm);
  }
  return windows.map((w) => {
    const seen = new Set<string>();
    let sum = 0;
    for (const e of entries) {
      if (e.iso > w.monthEndIso || seen.has(e.key)) continue;
      const billed = firstBilled.get(e.key) ?? null;
      if (billed != null && billed <= w.billingMonth) continue;
      seen.add(e.key);
      if (e.clp != null) sum += e.clp;
    }
    return sum;
  });
}

/**
 * Σ revolving charges in a billing month (its statement dates, `statementDatesForFacturacion`).
 * Open-month only (facturado display + balance roll-forward), so payment lines — PAGO / MONTO
 * CANCELADO / ABONO DE DIVISAS — are excluded: they settle the prior facturación, not this cycle's
 * charges. Non-payment negative lines (refunds, notas de crédito) still net inside the sum.
 */
export function incrementalChargesClpForBillingMonth(
  accountId: number,
  billingMonth: string
): number {
  let sum = 0;
  for (const stmtDate of statementDatesForFacturacion(accountId, billingMonth)) {
    sum += sumOpenCycleChargesClpForStatementDate(accountId, stmtDate);
  }
  return sum;
}

/**
 * Installment plans bought after `afterIso` (exclusive), at the value the owed walk adds them
 * (`normalizedInstallmentPurchaseEvents`: the plan's total on its purchase date). The open month's
 * balance roll-forward adds them beside the cycle's lines: a cuota purchase is debt from the day
 * it is made, and once a line becomes a plan it leaves the line sums (a converted or feed-created
 * plan supersedes its purchase row). The bound is the closed month's CALENDAR month-end, not its
 * close: that month's balance already carries every plan bought through its month-end (its cupo
 * is the plan remainder by calendar month), so a plan bought between the close and the month-end
 * (·0101, 28/09/2026) is already in it.
 */
export function installmentPurchasesClpAfter(accountId: number, afterIso: string): number {
  let sum = 0;
  for (const e of normalizedInstallmentPurchaseEvents(accountId)) {
    if (e.iso > afterIso) sum += e.clp;
  }
  return sum;
}

/**
 * Open-cycle USD (foreign) charges billed so far, in USD and CLP — used to split the open month's
 * facturado into its CLP and US$ stacked components. Reads the same statement dates as
 * {@link incrementalChargesClpForBillingMonth} but keeps only USD-denominated lines (foreign charges
 * that carry `amount_usd` with no CLP amount, or lines on a USD statement). Payment lines (PAGO /
 * MONTO CANCELADO / ABONO DE DIVISAS) are EXCLUDED — same rule as the CLP side
 * (`facturadoClpFromOpenMonthStatementLines`): a payment in the open cycle settles the *prior*
 * facturación, so it must not reduce this cycle's billed US$ (the feed's divisas abono drove the
 * open month to −US$xxx,xx on ·0781, 2026-08). Payments belong to the balance roll-forward only.
 * Non-payment negative lines (refunds) still net in.
 *
 * "No CLP amount" must accept **0 as well as NULL**: the importer parses an empty `amount_clp`
 * CSV cell through `Number("")` → 0, so every stored foreign web-paste line carries 0, never NULL
 * (0-means-absent is the corpus convention — 1361 lines store 0, none store NULL). A NULL-only test
 * matched no real row, so the open cycle's US$ leg silently collapsed into `facturado_clp`.
 * `effectiveCcExpenseLineAmountUsd` is the same null-vs-0 rule the CLP helper below applies, so the
 * two legs of the split can't drift.
 */
export function openMonthUsdFacturado(
  accountId: number,
  billingMonth: string
): { usd: number; clp: number } {
  const superseded = oneShotStatementLineIdsSupersededByInstallmentPurchases(accountId);
  let usd = 0;
  let clp = 0;
  const addStatement = (statementDate: string) => {
    const fxDateIso = balanceUsdFxDateIso(accountId, statementDate);
    for (const r of listRevolvingLineRowsForStatementDate(accountId, statementDate)) {
      if (superseded.has(r.id)) continue;
      if (isInstallmentContractSummaryMerchant(r.merchant)) continue;
      if (isCcPaymentOrUsdDebtAbonoMerchant(r.merchant)) continue;
      const oneShot = {
        ...r,
        installment_flag: 0,
        valor_cuota_mensual_clp: null,
        valor_cuota_mensual_usd: null,
      };
      const u = effectiveCcExpenseLineAmountUsd(oneShot);
      if (u == null) continue; // CLP-denominated line — not part of the US$ split
      usd += u;
      const c = effectiveCcExpenseLineAmountClp(oneShot, fxDateIso);
      if (c != null && Number.isFinite(c)) clp += c;
    }
  };
  for (const stmtDate of statementDatesForFacturacion(accountId, billingMonth)) addStatement(stmtDate);
  return { usd, clp };
}

function installmentCuotaDueForAccountStatementDateClp(
  accountId: number,
  statementDate: string
): number {
  const fxDateIso = balanceUsdFxDateIso(accountId, statementDate);
  const rows = db
    .prepare(
      `SELECT l.id, l.merchant, l.installment_flag, l.amount_clp, l.amount_usd,
              s.currency AS statement_currency,
              l.valor_cuota_mensual_clp, l.valor_cuota_mensual_usd
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ? AND s.statement_date = ?`
    )
    .all(accountId, statementDate) as {
    id: number;
    merchant: string | null;
    installment_flag: number;
    amount_clp: number | null;
    amount_usd: number | null;
    statement_currency: string;
    valor_cuota_mensual_clp: number | null;
    valor_cuota_mensual_usd: number | null;
  }[];

  const forDedupe: CcStatementLineForInstallmentTotals[] = rows.map((r) => ({
    statement_line_id: r.id,
    account_id: accountId,
    statement_date: statementDate,
    merchant: r.merchant,
    installment_flag: r.installment_flag,
    amount_clp: r.amount_clp,
    amount_usd: r.amount_usd,
    valor_cuota_mensual_clp: r.valor_cuota_mensual_clp,
    valor_cuota_mensual_usd: r.valor_cuota_mensual_usd,
    fx_date_iso: fxDateIso,
  }));
  const redundant = redundantInstallmentSummaryLineIds(forDedupe);

  let sum = 0;
  for (const r of rows) {
    if (redundant.has(r.id)) continue;
    if (r.installment_flag !== 1) continue;
    const cuota = effectiveCcExpenseLineAmountClp(
      { ...r, installment_flag: 1 },
      fxDateIso
    );
    if (cuota != null && cuota > 0) sum += cuota;
  }
  return sum;
}

/** Header monto_facturado when present; otherwise Σ revolving lines + installment cuotas on that close. */
/**
 * What a statement's header says it billed: «Monto total facturado a pagar» as printed, whatever
 * the sign — a period that ended in credit bills a negative amount (·0161: the peso statement of
 * 2018-06-25, −2xx.xxx, and six dollar ones), one with nothing to pay 0. Null only when the
 * statement prints none (open buckets, web pastes), which falls back to its lines. Reading ≤ 0 as
 * «no header» had left every credit out of the month-end anchors.
 */
export function statementHeaderFacturado(stmt: { monto_facturado: number | null }): number | null {
  return stmt.monto_facturado != null && Number.isFinite(stmt.monto_facturado) ? stmt.monto_facturado : null;
}

export function facturadoFromStatement(
  accountId: number,
  statementDate: string,
  stmt: { currency: string; monto_facturado: number | null; source_pdf?: string | null },
  fxDate: string
): { facturado_clp: number | null; facturado_usd: number | null } {
  const headerMonto = statementHeaderFacturado(stmt);
  if (headerMonto != null) {
    if (stmt.currency === "usd") {
      const fx = fxMonthEndForBalanceUsd(balanceUsdFxDateIso(accountId, statementDate))?.clp_per_usd;
      const clp =
        fx != null && fx > 0 ? Math.round(headerMonto * fx) : null;
      return { facturado_clp: clp, facturado_usd: headerMonto };
    }
    return {
      facturado_clp: Math.round(headerMonto),
      facturado_usd: null,
    };
  }
  const revolving = sumRevolvingChargesClpForStatementDate(accountId, statementDate);
  const cuota = installmentCuotaDueForAccountStatementDateClp(accountId, statementDate);
  let clp = revolving + cuota;
  if (clp <= 0) {
    const isWebPaste = String(stmt.source_pdf ?? "").trim().startsWith("import:web-paste");
    if (!isWebPaste) {
      const billingMonth = billingMonthForStatementDate(fxDate);
      if (billingMonth) {
        clp = ledgerFacturadoClpForBillingMonth(accountId, billingMonth);
      }
    }
  }
  return { facturado_clp: clp > 0 ? clp : null, facturado_usd: null };
}

const updateBalanceFromDetalle = db.prepare(`
  UPDATE cc_billing_month_balances SET cupo_utilizado_clp = ?, saldo_total_clp = ?
  WHERE account_id = ? AND billing_month = ?
`);

/**
 * Rebuilds one card's stored `cc_billing_month_balances` snapshot: a row per statement slot, as
 * of its close, and — while no statement closes it — the open facturación's row, as of today.
 * Facturado is per currency, the slot's own (`facturadoClpUsdForStatementSlot`); `saldo_total_usd`
 * is the USD statement's printed deuda total. Cupo en cuotas and saldo total are the detalle row
 * the card page shows for that month (`billingDetailCacheForAccount`), so the snapshot cannot
 * drift from it: the rebuild used to carry its own cupo rule — keyed on the calendar month, the
 * double count `cupoEnCuotasForBillingMonth` describes — and a saldo of cupo + the statement's
 * revolving lines net of the previous bill's payment, which read negative on paid-off months.
 * The detalle reads these rows back (the open month's row keeps that month in the table before
 * any line lands in it), hence the order: rows first, then the detalle built from them.
 */
export function recomputeCcBillingMonthBalances(accountId: number): number {
  invalidateCcBillingDetail(accountId);
  const statements = listCcStatementsForAccount(accountId);
  const months = new Set<string>();
  let n = 0;

  db.prepare(`DELETE FROM cc_billing_month_balances WHERE account_id = ?`).run(accountId);

  for (const [billingMonth, slot] of statementSlotsByBillingMonth(accountId)) {
    const primary = slot.clp ?? slot.usd;
    if (!primary?.statement_date_iso) continue;
    const asOfIso = primary.statement_date_iso;
    const { facturado_clp, facturado_usd } = facturadoClpUsdForStatementSlot(accountId, slot);
    const saldo_total_usd =
      slot.usd?.deuda_total != null && slot.usd.deuda_total > 0 ? slot.usd.deuda_total : 0;

    upsertBalance.run({
      account_id: accountId,
      billing_month: billingMonth,
      as_of_date: asOfIso,
      as_of_kind: "statement",
      facturado_clp: facturado_clp > 0 ? facturado_clp : null,
      facturado_usd: facturado_usd > 0 ? facturado_usd : null,
      // Set from the detalle below, once it can be built from these rows.
      cupo_utilizado_clp: 0,
      saldo_total_clp: 0,
      saldo_total_usd: saldo_total_usd > 0 ? saldo_total_usd : null,
    });
    months.add(billingMonth);
    n += 1;
  }

  const today = chileCalendarTodayYmd();
  const openBm = billingMonthForManualLedgerPurchase(accountId);
  if (openBm && !creditCardBillingDetailInactive(accountId)) {
    const hasPdfForOpen = statements.some(
      (s) => s.billing_month === openBm && !String(s.source_pdf ?? "").startsWith("import:web-paste")
    );
    if (!hasPdfForOpen) {
      upsertBalance.run({
        account_id: accountId,
        billing_month: openBm,
        as_of_date: today,
        as_of_kind: "manual",
        facturado_clp: null,
        facturado_usd: null,
        cupo_utilizado_clp: 0,
        saldo_total_clp: 0,
        saldo_total_usd: null,
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
    updateBalanceFromDetalle.run(row.cupo_en_cuotas_clp, row.balance_total_clp, accountId, billingMonth);
  }

  return n;
}

export function listCcBillingMonthBalances(accountId: number): CcBillingMonthBalanceRow[] {
  return db
    .prepare(
      `SELECT id, account_id, billing_month, as_of_date, as_of_kind,
              facturado_clp, facturado_usd, cupo_utilizado_clp, saldo_total_clp, saldo_total_usd
       FROM cc_billing_month_balances WHERE account_id = ?
       ORDER BY billing_month DESC, as_of_date DESC`
    )
    .all(accountId) as CcBillingMonthBalanceRow[];
}

export function patchCreditCardBillingConfig(
  accountId: number,
  patch: { billing_cycle_start_day?: number; billing_cycle_end_day?: number | null }
): void {
  const cur = loadCreditCardBillingConfig(accountId);
  const start = patch.billing_cycle_start_day ?? cur.billing_cycle_start_day;
  const end =
    patch.billing_cycle_end_day !== undefined
      ? patch.billing_cycle_end_day
      : cur.billing_cycle_end_day;
  db.prepare(
    `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day)
     VALUES (?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       billing_cycle_start_day = excluded.billing_cycle_start_day,
       billing_cycle_end_day = excluded.billing_cycle_end_day`
  ).run(accountId, start, end ?? null);
  invalidateCcBillingDetail(accountId);
}
