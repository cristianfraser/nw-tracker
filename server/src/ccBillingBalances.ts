import {
  cacheKeyCcBillingDetail,
  getAggregationCached,
  invalidateCcBillingDetail,
} from "./aggregationCache.js";
import { effectiveCcExpenseLineAmountClp } from "./ccExpenseAmountClp.js";
import { oneShotStatementLineIdsSupersededByInstallmentPurchases } from "./ccCrossImportDedupe.js";
import {
  isInstallmentContractSummaryMerchant,
  redundantInstallmentSummaryLineIds,
  type CcStatementLineForInstallmentTotals,
} from "./ccInstallmentLineDedupe.js";
import { parseDdMmYyToIso, resolveInstallmentPayByIso } from "./ccInstallmentPayBy.js";
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { billingMonthForStatementDate, loadCreditCardBillingConfig } from "./ccBillingMonth.js";
import {
  installmentRemainingClpByCalendarMonth,
  ledgerFacturadoClpForBillingMonth,
  liveCreditCardOutstandingClp,
} from "./ccInstallmentLedgerDb.js";
import { listCcStatementsForAccount } from "./ccStatementsDb.js";
import { fxMonthEndForBalanceUsd } from "./fxRates.js";
import { creditCardBillingDetailInactive } from "./ccBillingInactive.js";
import { billingMonthForManualLedgerPurchase } from "./ccManualBillingMonth.js";
import { listStaleOpenWebPasteStatementDates } from "./ccOpenWebPastePdfReconcile.js";
import { isCcPaymentMerchant } from "./ccPaymentLines.js";
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

/**
 * FX date for valuing USD credit-card charges in DISPLAYED balances (facturado / balance_total /
 * detalle / graph): the facturación pay-by date minus one day. A foreign charge settles to CLP at
 * pay-by, so this locks the rate once that date passes (and floats on the latest rate before it),
 * instead of drifting with the statement-close rate. Import dedupe/matching keeps the raw
 * statement-date FX (only affects amount comparisons, not what the user sees).
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
  return payByIso ? isoAddDays(payByIso, -1) : parseDdMmYyToIso(statementDate);
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
  opts?: { excludePayments?: boolean }
): number {
  const fxDateIso = balanceUsdFxDateIso(accountId, statementDate);
  const rows = listRevolvingLineRowsForStatementDate(accountId, statementDate);
  const superseded = oneShotStatementLineIdsSupersededByInstallmentPurchases(accountId);
  let sum = 0;
  for (const r of rows) {
    if (superseded.has(r.id)) continue;
    if (isInstallmentContractSummaryMerchant(r.merchant)) continue;
    if (opts?.excludePayments && isCcPaymentMerchant(r.merchant)) continue;
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

/** ISO of a stored transaction_date (accepts `YYYY-MM-DD` or `DD/MM/YYYY` parser output). */
function normalizeTransactionDateIso(td: string | null): string | null {
  if (!td) return null;
  const t = td.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return parseDdMmYyToIso(t);
}

type PostCloseLineRow = RevolvingLineRow & {
  transaction_date: string | null;
  statement_date: string;
  dedupe_key: string | null;
};

/**
 * Section-3 bank charge (interés, comisión, impuesto) rather than consumption or a payment —
 * the same test `statementSection3ChargesClpForBillingMonth` sums for the monthly financing
 * cost, so the flow-based P/L and the financing chart agree by construction. Refunds (NOTA DE
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
 * Normalized non-installment line stream for post-close windows (transaction-date ISO,
 * dedupe key, signed CLP), memoized in the aggregation cache under the account's
 * `cc.billing_detail|<id>|…` satellite key — dropped by `invalidateCcBillingDetail` with the
 * detalle cache. Daily owed-on-date evaluates one window per session, so the scan must not
 * re-run per date.
 *
 * `financing` marks section-3 bank charges (intereses, comisiones, impuestos) using the same
 * predicate as the monthly financing-cost metric. They are owed like any other charge — the
 * balance walk ignores the flag — but `ccOwedFlowEvents.ts` withholds them from the flow leg
 * so that a card's P/L is exactly its cost of financing.
 */
export function normalizedPostCloseLines(
  accountId: number
): { iso: string; key: string; clp: number | null; financing?: boolean }[] {
  return getAggregationCached(`${cacheKeyCcBillingDetail(accountId)}|postclose_lines`, () => {
    const rows = db
      .prepare(
        `SELECT l.id, l.merchant, l.amount_clp, l.amount_usd, s.currency AS statement_currency,
                l.installment_flag, l.valor_cuota_mensual_clp, l.valor_cuota_mensual_usd,
                l.transaction_date, s.statement_date, l.dedupe_key
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

    // clp stays null when FX/amount is unresolvable — the line still consumes its dedupe key
    // inside a window (same as the single-window loop did).
    const lines: { iso: string; key: string; clp: number | null; financing?: boolean }[] = [];
    for (const r of rows) {
      if (superseded.has(r.id)) continue;
      if (isInstallmentContractSummaryMerchant(r.merchant)) continue;
      const iso = normalizeTransactionDateIso(r.transaction_date);
      if (!iso) continue;
      const key = r.dedupe_key ?? `${iso}|${r.merchant}|${r.amount_clp}|${r.amount_usd}`;
      const clp = effectiveCcExpenseLineAmountClp(
        { ...r, installment_flag: 0, valor_cuota_mensual_clp: null, valor_cuota_mensual_usd: null },
        fxDateFor(r.statement_date)
      );
      lines.push({
        iso,
        key,
        clp: clp != null && Number.isFinite(clp) ? clp : null,
        ...(isFinancingChargeLine(r) ? { financing: true } : {}),
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
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s.pago_iso)) {
        throw new Error(
          `cc_statements ${s.statement_date}: invalid monto_pagado_anterior_date ${s.pago_iso}`
        );
      }
      const covered = lines.some(
        (l) => l.iso === s.pago_iso && l.clp != null && Math.abs(l.clp + amtAbs) < 1
      );
      if (covered) continue;
      lines.push({ iso: s.pago_iso, key: `hdr-pago|${s.pago_iso}|${amtAbs}`, clp: -amtAbs });
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
): { iso: string; key: string; clp: number }[] {
  return getAggregationCached(
    `${cacheKeyCcBillingDetail(accountId)}|instpurchase_events`,
    () => {
      const purchases = db
        .prepare(
          `SELECT id, purchase_date, total_amount_clp FROM cc_installment_purchases
           WHERE account_id = ? AND purchase_date IS NOT NULL AND total_amount_clp IS NOT NULL`
        )
        .all(accountId) as { id: number; purchase_date: string; total_amount_clp: number }[];
      const events: { iso: string; key: string; clp: number }[] = [];
      for (const pu of purchases) {
        const iso = normalizeTransactionDateIso(pu.purchase_date);
        if (!iso) continue;
        const amt = Math.round(pu.total_amount_clp);
        if (!Number.isFinite(amt) || amt === 0) continue;
        events.push({ iso, key: `inst-purchase|${pu.id}`, clp: amt });
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

/** Σ positive revolving charges in a billing month (all statement closes on distinct dates). */
export function incrementalChargesClpForBillingMonth(
  accountId: number,
  billingMonth: string
): number {
  const seenDates = new Set<string>();
  let sum = 0;
  for (const st of listCcStatementsForAccount(accountId)) {
    if (st.billing_month !== billingMonth) continue;
    if (seenDates.has(st.statement_date)) continue;
    seenDates.add(st.statement_date);
    sum += sumRevolvingChargesClpForStatementDate(accountId, st.statement_date);
  }
  const openBm = billingMonthForManualLedgerPurchase(accountId);
  if (openBm === billingMonth) {
    for (const stmtDate of listStaleOpenWebPasteStatementDates(accountId, billingMonth)) {
      if (seenDates.has(stmtDate)) continue;
      seenDates.add(stmtDate);
      sum += sumRevolvingChargesClpForStatementDate(accountId, stmtDate);
    }
  }
  return sum;
}

/**
 * Open-cycle USD (foreign) charges billed so far, in USD and CLP — used to split the open month's
 * facturado into its CLP and US$ stacked components. Mirrors the statement iteration of
 * {@link incrementalChargesClpForBillingMonth} but keeps only USD-denominated lines (foreign charges
 * that carry `amount_usd` with no CLP amount, or lines on a USD statement). Payments/abonos net in
 * via their negative amounts.
 */
export function openMonthUsdFacturado(
  accountId: number,
  billingMonth: string
): { usd: number; clp: number } {
  const superseded = oneShotStatementLineIdsSupersededByInstallmentPurchases(accountId);
  const seenDates = new Set<string>();
  let usd = 0;
  let clp = 0;
  const addStatement = (statementDate: string) => {
    const fxDateIso = balanceUsdFxDateIso(accountId, statementDate);
    for (const r of listRevolvingLineRowsForStatementDate(accountId, statementDate)) {
      if (superseded.has(r.id)) continue;
      if (isInstallmentContractSummaryMerchant(r.merchant)) continue;
      const isUsdLine =
        (r.amount_clp == null && r.amount_usd != null) ||
        String(r.statement_currency).toLowerCase() === "usd";
      if (!isUsdLine) continue;
      if (r.amount_usd != null && Number.isFinite(r.amount_usd)) usd += r.amount_usd;
      const c = effectiveCcExpenseLineAmountClp(
        { ...r, installment_flag: 0, valor_cuota_mensual_clp: null, valor_cuota_mensual_usd: null },
        fxDateIso
      );
      if (c != null && Number.isFinite(c)) clp += c;
    }
  };
  for (const st of listCcStatementsForAccount(accountId)) {
    if (st.billing_month !== billingMonth) continue;
    if (seenDates.has(st.statement_date)) continue;
    seenDates.add(st.statement_date);
    addStatement(st.statement_date);
  }
  const openBm = billingMonthForManualLedgerPurchase(accountId);
  if (openBm === billingMonth) {
    for (const stmtDate of listStaleOpenWebPasteStatementDates(accountId, billingMonth)) {
      if (seenDates.has(stmtDate)) continue;
      seenDates.add(stmtDate);
      addStatement(stmtDate);
    }
  }
  return { usd, clp };
}

function sumNonInstallmentLinesForAccountStatementDateClp(
  accountId: number,
  statementDate: string
): number {
  return sumRevolvingLinesForAccountStatementDateClp(accountId, statementDate);
}

function sumNonInstallmentLinesClp(statementId: number): number {
  const row = db
    .prepare(
      `SELECT account_id, statement_date FROM cc_statements WHERE id = ?`
    )
    .get(statementId) as { account_id: number; statement_date: string } | undefined;
  if (!row) return 0;
  return sumNonInstallmentLinesForAccountStatementDateClp(
    row.account_id,
    row.statement_date
  );
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
export function facturadoFromStatement(
  accountId: number,
  statementDate: string,
  stmt: { currency: string; monto_facturado: number | null; source_pdf?: string | null },
  fxDate: string
): { facturado_clp: number | null; facturado_usd: number | null } {
  const headerMonto =
    stmt.monto_facturado != null &&
    Number.isFinite(stmt.monto_facturado) &&
    stmt.monto_facturado > 0
      ? stmt.monto_facturado
      : null;
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

function cupoEnCuotasForBillingMonth(
  billingMonth: string,
  remainingByMonth: Map<string, number>,
  cupoLive: number,
  currentBillingMonth: string | null
): number {
  if (currentBillingMonth && billingMonth === currentBillingMonth) return cupoLive;
  return remainingByMonth.get(billingMonth) ?? 0;
}

function facturadoClpUsdForStatementSlotLocal(
  accountId: number,
  slot: import("./ccBillingStatementSlots.js").CcStatementSlotByCurrency
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

export function recomputeCcBillingMonthBalances(accountId: number): number {
  invalidateCcBillingDetail(accountId);
  const remainingByMonth = installmentRemainingClpByCalendarMonth(accountId);
  const cupoLive =
    remainingByMonth.get(billingMonthForStatementDate(chileCalendarTodayYmd()) ?? "") ??
    liveCreditCardOutstandingClp(accountId) ??
    0;
  const currentBillingMonth = billingMonthForStatementDate(chileCalendarTodayYmd());
  const statements = listCcStatementsForAccount(accountId);
  let n = 0;

  db.prepare(`DELETE FROM cc_billing_month_balances WHERE account_id = ?`).run(accountId);

  for (const [billingMonth, slot] of statementSlotsByBillingMonth(accountId)) {
    const primary = slot.clp ?? slot.usd;
    if (!primary?.statement_date_iso) continue;
    const asOfIso = primary.statement_date_iso;
    const { facturado_clp, facturado_usd } = facturadoClpUsdForStatementSlotLocal(
      accountId,
      slot
    );
    const cupoAtMonth = cupoEnCuotasForBillingMonth(
      billingMonth,
      remainingByMonth,
      cupoLive,
      currentBillingMonth
    );
    const clpStmtId = slot.clp?.id ?? primary.id;
    const revolving = sumNonInstallmentLinesClp(clpStmtId);
    const saldo_total_usd =
      slot.usd?.deuda_total != null && slot.usd.deuda_total > 0 ? slot.usd.deuda_total : 0;

    upsertBalance.run({
      account_id: accountId,
      billing_month: billingMonth,
      as_of_date: asOfIso,
      as_of_kind: "statement",
      facturado_clp: facturado_clp > 0 ? facturado_clp : null,
      facturado_usd: facturado_usd > 0 ? facturado_usd : null,
      cupo_utilizado_clp: cupoAtMonth,
      saldo_total_clp: cupoAtMonth + revolving,
      saldo_total_usd: saldo_total_usd > 0 ? saldo_total_usd : null,
    });
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
        cupo_utilizado_clp: cupoLive,
        saldo_total_clp: cupoLive,
        saldo_total_usd: null,
      });
      n += 1;
    }
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
