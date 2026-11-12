import { cacheKeyCcBillingPart } from "./cacheFamilies.js";
import { isListingSourceKind } from "./ccStatementSourceKind.js";
import { getAggregationCached } from "./cacheRegistry.js";
import {
  cardLineNativeAmount,
  debtCcExpenseLineAmountClp,
  debtFrameClpPerUsd,
  effectiveCcExpenseLineAmountClp,
  effectiveCcExpenseLineAmountUsd,
  uniformDebtUsdRateInEffect,
} from "./ccExpenseAmountClp.js";
import {
  billedOneShotLines,
  debtEventLines,
  linesOfClose,
  planPurchaseEvents,
  withCcOneShotScanCache,
} from "./cards/purchases.js";
import {
  redundantInstallmentSummaryLineIds,
  type CcStatementLineForInstallmentTotals,
} from "./ccInstallmentLineDedupe.js";
import { normalizeTransactionDateIso, resolveInstallmentPayByIso } from "./ccInstallmentPayBy.js";
import { ccTraspasoLinkedClpByForeignLineId } from "./ccTraspasoDeudaLinks.js";
import { foreignBilledFromStatementLines } from "./ccForeignStatementBilled.js";
import { db } from "./db.js";
import { ccDerivedPayByRuleForAccount } from "./ccIssuerForAccount.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { loadCreditCardBillingConfig } from "./cards/config.js";
import { ledgerFacturadoClpForBillingMonth } from "./ccInstallmentLedgerDb.js";
import { listCcStatementsForAccount } from "./ccStatementsDb.js";
import { fxMonthEndForBalanceUsd } from "./fxRates.js";
import { isHomeCurrency, roundToCurrency } from "./displayUnits.js";
import { convertCurrency } from "./rates.js";
import { legacyAmountColumn } from "./cards/statementStorage.js";
import { cardStoppedBilling } from "./cards/lifecycle.js";
import { billingMonthForManualLedgerPurchase } from "./cards/facturacion.js";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import { facturadoClpUsdForStatementSlot } from "./ccBillingViews.js";
import { statementDatesForFacturacion } from "./ccOpenWebPastePdfReconcile.js";
import { isCcPaymentOrUsdDebtAbonoMerchant, requireHeaderPagoIso } from "./ccPaymentLines.js";
import { primaryStatementOfSlot, statementSlotsByBillingMonth } from "./ccBillingStatementSlots.js";
import { ddMmYyyyFromIso, parseDdMmYyToIso, isCcPaymentMerchant, isCcTraspasoDeudaMerchant, isClpSection3FinancingChargeMerchant, isUsdSection3FinancingChargeMerchant } from "nw-tracker-contracts";

/**
 * One billing month of a card's stored snapshot (`cc_billing_month_metrics`, migration 320: one
 * row per metric and currency), pivoted: `facturado` and `saldo_total` per currency, the cupo in
 * pesos. The `_clp` / `_usd` fields are those maps' peso and dollar entries.
 */
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
  facturado_by_currency: Record<string, number>;
  saldo_total_by_currency: Record<string, number>;
  cupo_utilizado_by_currency: Record<string, number>;
};

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
  for (const [c, v] of Object.entries(b.saldo_total)) if (c !== "clp") put("saldo_total", c, v);
}

type RevolvingLineRow = {
  id: number;
  merchant: string | null;
  amount_clp: number | null;
  amount_usd: number | null;
  statement_currency: string;
  installment_flag: number;
  valor_cuota_mensual_clp: number | null;
  valor_cuota_mensual_usd: number | null;
  amount: number | null;
  currency: string;
  cuota_amount?: number | null;
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
 * expense lines) is the rate actually paid instead — `ccFacturacionForeignRate.ts`. Import
 * dedupe/matching keeps the raw statement-date FX (it only compares amounts).
 */
export function balanceUsdFxDateIso(accountId: number, statementDate: string): string | null {
  const meta = stmtPayByMetaByDate.get(accountId, statementDate) as
    | { pay_by: string | null; period_to: string | null }
    | undefined;
  const payByIso = resolveInstallmentPayByIso(
    {
      pay_by: meta?.pay_by ?? undefined,
      statement_date: statementDate,
      period_to: meta?.period_to ?? undefined,
    },
    () => ccDerivedPayByRuleForAccount(accountId)
  );
  return payByIso ? payByFxDateIso(payByIso) : parseDdMmYyToIso(statementDate);
}

function sumRevolvingLinesForAccountStatementDateClp(
  accountId: number,
  statementDate: string,
  opts?: { excludePayments?: boolean; excludeUsdDebtPaymentAbonos?: boolean }
): number {
  const fxDateIso = balanceUsdFxDateIso(accountId, statementDate);
  let sum = 0;
  for (const r of billedOneShotLines(accountId, statementDate)) {
    if (opts?.excludePayments && isCcPaymentMerchant(r.merchant)) continue;
    if (
      opts?.excludeUsdDebtPaymentAbonos &&
      isCcPaymentOrUsdDebtAbonoMerchant(r.merchant)
    ) {
      continue;
    }
    const clp = debtCcExpenseLineAmountClp(
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
 * the same test `ccSection3FinancingClpByDate` sums for the financing
 * cost (at the same FX date), so the flow-based P/L and the monthly sum agree by construction. Refunds (NOTA DE
 * CREDITO, negative amounts) match the section-3 merchant patterns but are negative
 * consumption, not cost, hence the positive-amount guard on both currencies.
 */
function isFinancingChargeLine(r: PostCloseLineRow): boolean {
  if (r.statement_currency === "usd") { // convention-ok: Santander's traspaso and header-payment legs are pesos or dollars (plan C3 leftover)
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
 * else posting — dedupe key, signed CLP), memoized in the account's `cc_billing_parts` cache
 * family — dropped with the card's billing detail by the change log. Daily owed-on-date evaluates
 * one window per session, so the scan must not re-run per date.
 *
 * `financing` marks section-3 bank charges (intereses, comisiones, impuestos) using the same
 * predicate as the financing-cost metric. They are owed like any other charge — the balance walk
 * ignores the flag — but `ccFinancingCostDaily.ts` takes them out of the derived flow so that a
 * card's P/L is exactly its cost of financing.
 */
export type PostCloseStreamEntry = {
  iso: string;
  key: string;
  /**
   * Debt-frame pesos (a dollar amount at its facturación's pay-by − 1): what the evidence showed it
   * cost — the financing P/L reads it. Values read {@link amount} in {@link currency} instead.
   */
  clp: number | null;
  /** The currency the evidence is stated in: a dollar line, payment, header leg or traspaso leg is `usd`; a line in any other currency, its own. */
  currency: string;
  /** Signed debt-positive amount in {@link currency} (dollars to the cent); null when unreadable. */
  amount: number | null;
  financing?: boolean;
  /**
   * `statement_date` (dd/mm/yyyy) of the statement row it sits on — a statement, an open bucket,
   * or the statement whose header carries the payment; null for an installment purchase event.
   * Which facturación that is, is `facturacionMonthByStatementDate`'s call.
   */
  statement_date: string | null;
};

/**
 * A dollar payment pays the facturación that closed before it, whose debt the month-end anchor
 * values at that facturación's debt fx: valued at its own statement's fx instead, the payment of a
 * large dollar debt read the month's fx move as owed (·0161 2021-11: 3.xxx,xx USD at 839 vs the debt
 * at 803, −1xx.xxx between the anchor and the walk). Same pairing as `facturacionPaidOn`: the latest
 * dollar statement closed strictly before the payment. Returns the statement_date (dd/mm/yyyy) of the
 * facturación a dollar payment dated `paymentIso` paid, or null when none closed before it.
 */
export function usdPaymentPaidStatementDateResolver(accountId: number): (paymentIso: string) => string | null {
  const usdCloses = (
    db
      .prepare(
        `SELECT DISTINCT statement_date FROM cc_statements
         WHERE account_id = ? AND currency = 'usd' AND source_kind NOT IN ('listing_open', 'listing_other')`
      )
      .all(accountId) as { statement_date: string }[]
  )
    .map((r) => ({ date: r.statement_date, iso: parseDdMmYyToIso(r.statement_date) }))
    .filter((r): r is { date: string; iso: string } => r.iso != null)
    .sort((a, b) => a.iso.localeCompare(b.iso));
  return (paymentIso: string): string | null => {
    let hit: string | null = null;
    for (const c of usdCloses) {
      if (c.iso < paymentIso) hit = c.date;
      else break;
    }
    return hit;
  };
}

export function normalizedPostCloseLines(accountId: number): PostCloseStreamEntry[] {
  return getAggregationCached(cacheKeyCcBillingPart(accountId, `postclose_lines`), () => {
    const rows = debtEventLines(accountId);

    const fxDateByStatementDate = new Map<string, string | null>();
    const fxDateFor = (statementDate: string): string | null => {
      if (!fxDateByStatementDate.has(statementDate)) {
        fxDateByStatementDate.set(statementDate, balanceUsdFxDateIso(accountId, statementDate));
      }
      return fxDateByStatementDate.get(statementDate) ?? null;
    };
    // A dollar payment is valued at the debt fx of the facturación it paid
    // (`usdPaymentPaidStatementDateResolver`).
    const paidFacturacionStatementDate = usdPaymentPaidStatementDateResolver(accountId);

    // A linked traspaso-de-deuda USD abono carries minus its CLP twin's booked pesos — the
    // pair is one debt reclassification and must net to exactly zero, never an fx estimate.
    // Unlinked traspaso legs (web-paste pastes, twin statement not imported) keep the fx
    // conversion below until the PDF import links the real pair.
    const traspasoClpByUsdLineId = ccTraspasoLinkedClpByForeignLineId(accountId, "usd");

    // clp stays null when FX/amount is unresolvable — the line still consumes its dedupe key
    // inside a window (same as the single-window loop did).
    const lines: PostCloseStreamEntry[] = [];
    // The lines come with their debt day (`debtEventLines`: superseded lines and contract summaries
    // out, a backdated posting at its statement's close).
    for (const r of rows) {
      const iso = r.iso;
      if (legacyAmountColumn(r.currency) == null) {
        // A line in another currency: its own amount, and its pesos at the debt side of its
        // facturación's debt-frame date (what the financing P/L reads).
        const amount = r.amount != null && Number.isFinite(r.amount) && r.amount !== 0 ? r.amount : null;
        const fxIso = fxDateFor(r.statement_date);
        const clp =
          amount != null && fxIso != null
            ? convertCurrency(amount, r.currency, "clp", fxIso, { side: amount < 0 ? "asset" : "debt" })
            : null;
        lines.push({
          iso,
          key: r.dedupe_key ?? `${iso}|${r.merchant}|${r.currency}|${r.amount}`,
          clp: clp != null ? Math.round(clp) : null,
          currency: r.currency,
          amount,
          ...(isFinancingChargeLine(r) ? { financing: true } : {}),
          statement_date: r.statement_date,
        });
        continue;
      }
      const key = r.dedupe_key ?? `${iso}|${r.merchant}|${r.amount_clp}|${r.amount_usd}`;
      const linkedTraspasoClp =
        r.statement_currency === "usd" ? traspasoClpByUsdLineId.get(r.id) : undefined; // convention-ok: Santander's traspaso and header-payment legs are pesos or dollars (plan C3 leftover)
      const usdPayment = (r.amount_usd ?? 0) < 0 && isCcPaymentOrUsdDebtAbonoMerchant(r.merchant);
      const paidStatementDate = usdPayment ? paidFacturacionStatementDate(iso) : null;
      const clp =
        linkedTraspasoClp != null
          ? -linkedTraspasoClp
          : effectiveCcExpenseLineAmountClp(
              { ...r, installment_flag: 0, valor_cuota_mensual_clp: null, valor_cuota_mensual_usd: null },
              fxDateFor(paidStatementDate ?? r.statement_date)
            );
      const usdNative = effectiveCcExpenseLineAmountUsd({
        ...r,
        installment_flag: 0,
        valor_cuota_mensual_clp: null,
        valor_cuota_mensual_usd: null,
      });
      const finiteClp = clp != null && Number.isFinite(clp) ? clp : null;
      lines.push({
        iso,
        key,
        clp: finiteClp,
        ...(usdNative != null
          ? { currency: "usd" as const, amount: usdNative }
          : { currency: "clp" as const, amount: finiteClp }),
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
        currency: "clp",
        amount: -amtAbs,
        statement_date: s.statement_date,
      });
    }

    // The dated legs of header payments a statement printed without a date (migration 213):
    // payments like the dated ones above, which the walk and the month-end anchors otherwise
    // never subtracted. A leg is the bank-debit remainder of its header, never a printed line.
    // A dollar leg (migration 218: an old international statement's header abono) is a dollar
    // payment like the lines above, valued at the debt fx of the facturación it paid.
    const legs = db
      .prepare(`SELECT statement_close_iso, currency, paid_on, amount FROM cc_header_payment_legs WHERE account_id = ?`)
      .all(accountId) as { statement_close_iso: string; currency: "clp" | "usd"; paid_on: string; amount: number }[]; // convention-ok: Santander's traspaso and header-payment legs are pesos or dollars (plan C3 leftover)
    for (const g of legs) {
      const statementDate = ddMmYyyyFromIso(g.statement_close_iso);
      let clp: number | null = g.amount;
      if (g.currency === "usd") { // convention-ok: Santander's traspaso and header-payment legs are pesos or dollars (plan C3 leftover)
        const fxIso = fxDateFor(paidFacturacionStatementDate(g.paid_on) ?? statementDate);
        const fx = fxIso ? fxMonthEndForBalanceUsd(fxIso)?.clp_per_usd : null;
        clp = fx != null && fx > 0 ? g.amount * fx : null;
      }
      lines.push({
        iso: g.paid_on,
        key: `hdr-leg|${g.statement_close_iso}|${g.currency === "usd" ? "usd|" : ""}${g.paid_on}|${g.amount}`, // convention-ok: Santander's traspaso and header-payment legs are pesos or dollars (plan C3 leftover)
        clp: clp != null ? -clp : null,
        currency: g.currency,
        amount: -g.amount,
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
): { iso: string; key: string; clp: number; currency: "clp"; amount: number; statement_date: null }[] {
  return getAggregationCached(
    cacheKeyCcBillingPart(accountId, `instpurchase_events`),
    () => {
      const purchases = planPurchaseEvents(accountId);
      const events: { iso: string; key: string; clp: number; currency: "clp"; amount: number; statement_date: null }[] = [];
      for (const pu of purchases) {
        const iso = normalizeTransactionDateIso(pu.purchase_date);
        if (!iso) continue;
        const amt = Math.round(pu.total_amount_clp);
        if (!Number.isFinite(amt) || amt === 0) continue;
        events.push({ iso, key: `inst-purchase|${pu.id}`, clp: amt, currency: "clp", amount: amt, statement_date: null });
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
function postCloseLiveBalanceAdjustmentsClp(
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
      const clp = statementFrameEntryClp(l);
      if (clp != null) sum += clp;
    }
    return sum;
  });
}

/**
 * An entry's pesos in the statement frame: its debt-frame `clp`, or — inside a uniform-rate split
 * pass (`withUniformDebtUsdRate`) — its native amount at that rate, so the cached stream (built at
 * the real rates) can serve the pass.
 */
function statementFrameEntryClp(e: PostCloseStreamEntry): number | null {
  const uniform = uniformDebtUsdRateInEffect();
  if (uniform == null) return e.clp;
  if (e.amount == null) return null;
  return e.currency === "usd" ? Math.round(e.amount * uniform) : e.amount; // convention-ok: Santander's traspaso and header-payment legs are pesos or dollars (plan C3 leftover)
}

/**
 * What a card owes per currency (docs/any-currency-plan.md, Phase C3): one entry per currency it
 * owes in — pesos always (first), any other currency once an anchor or a line names it — each to
 * that currency's smallest coin. A currency with no entry owes 0.
 */
export type CcOwedNative = Record<string, number>;

/** An owed of nothing: pesos 0. */
export function emptyCcOwed(): CcOwedNative {
  return { clp: 0 };
}

/** What `owed` owes in `currency` (0 when it has no entry). */
export function ccOwedIn(owed: Readonly<CcOwedNative>, currency: string): number {
  return owed[currency] ?? 0;
}

/** Adds `amount` of `currency` to `owed` in place. */
export function addToCcOwed(owed: CcOwedNative, currency: string, amount: number): void {
  owed[currency] = (owed[currency] ?? 0) + amount;
}

/** Each entry of `owed` rounded to its currency's smallest coin (pesos first, then in entry order). */
export function roundCcOwed(owed: Readonly<CcOwedNative>): CcOwedNative {
  const out: CcOwedNative = emptyCcOwed();
  for (const [c, v] of Object.entries(owed)) out[c] = roundToCurrency(v, c);
  return out;
}

/** The sum of two owed maps, each entry rounded (pesos first, then `a`'s currencies, then `b`'s). */
export function sumCcOwed(a: Readonly<CcOwedNative>, b: Readonly<CcOwedNative>): CcOwedNative {
  const out: CcOwedNative = emptyCcOwed();
  for (const c of new Set([...Object.keys(a), ...Object.keys(b)])) out[c] = roundToCurrency(ccOwedIn(a, c) + ccOwedIn(b, c), c);
  return out;
}

/**
 * The native change of what a card owes in `(fromIso, toIso]`, per currency: the same evidence and
 * dedupe as {@link postCloseLiveBalanceAdjustmentsClp}, each entry in the currency it is stated in.
 * `includeInstallmentPurchases` as there (the walk passes it).
 */
export function postCloseNativeAdjustment(
  accountId: number,
  fromIso: string,
  toIso: string,
  opts?: { includeInstallmentPurchases?: boolean }
): CcOwedNative {
  const out: CcOwedNative = emptyCcOwed();
  if (!fromIso || !toIso || fromIso >= toIso) return out;
  const lines: readonly PostCloseStreamEntry[] = opts?.includeInstallmentPurchases
    ? [...normalizedPostCloseLines(accountId), ...normalizedInstallmentPurchaseEvents(accountId)]
    : normalizedPostCloseLines(accountId);
  const seen = new Set<string>();
  for (const l of lines) {
    if (l.iso <= fromIso || l.iso > toIso) continue;
    if (seen.has(l.key)) continue;
    seen.add(l.key);
    if (l.amount == null) continue;
    addToCcOwed(out, l.currency, l.amount);
  }
  return roundCcOwed(out);
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
      const clp = statementFrameEntryClp(e);
      if (clp != null) sum += clp;
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
 * Open-cycle foreign charges billed so far, per currency, in that currency and in pesos — used to
 * split the open month's facturado into its peso part and one part per foreign currency. Reads the
 * same statement dates as {@link incrementalChargesClpForBillingMonth} and keeps the lines in
 * another currency than pesos, each in its own (`amount` + `currency`, migration 319; a dollar line
 * in a peso bucket is a dollar line). Payment lines (PAGO / MONTO CANCELADO / ABONO DE DIVISAS) are
 * EXCLUDED — same rule as the peso side (`facturadoClpFromOpenMonthStatementLines`): a payment in
 * the open cycle settles the *prior* facturación, so it must not reduce this cycle's billed amount
 * (the feed's divisas abono drove the open month to −US$xxx,xx on ·0781, 2026-08). Payments belong
 * to the balance roll-forward only. Non-payment negative lines (refunds) still net in. A line of
 * zero bills nothing (the corpus stores an absent amount as 0). The pesos are the debt frame's
 * (`debtCcExpenseLineAmountClp`: the facturación's pay-by − 1, or a split pass's uniform rate).
 */
export function openMonthForeignFacturado(
  accountId: number,
  billingMonth: string
): Map<string, { amount: number; clp: number }> {
  const out = new Map<string, { amount: number; clp: number }>();
  const addStatement = (statementDate: string) => {
    const fxDateIso = balanceUsdFxDateIso(accountId, statementDate);
    for (const r of billedOneShotLines(accountId, statementDate)) {
      if (isCcPaymentOrUsdDebtAbonoMerchant(r.merchant)) continue;
      if (isHomeCurrency(r.currency)) continue; // a peso line — not part of the foreign split
      const oneShot = { ...r, installment_flag: 0, valor_cuota_mensual_clp: null, valor_cuota_mensual_usd: null, cuota_amount: null };
      const native = cardLineNativeAmount(oneShot);
      if (!native) continue;
      const entry = out.get(native.currency) ?? { amount: 0, clp: 0 };
      entry.amount += native.amount;
      const c = debtCcExpenseLineAmountClp(oneShot, fxDateIso);
      if (c != null && Number.isFinite(c)) entry.clp += c;
      out.set(native.currency, entry);
    }
  };
  withCcOneShotScanCache(() => {
    for (const stmtDate of statementDatesForFacturacion(accountId, billingMonth)) addStatement(stmtDate);
  });
  return out;
}

/**
 * The credits of an open facturación (refunds, notas de crédito — negative one-shot lines that
 * are not payments, divisas abonos or traspasos de deuda), positive, per currency (pesos and
 * dollars always present, any other currency a line is in): what its facturado nets
 * ({@link openMonthForeignFacturado} for a foreign currency, the open-cycle charge sum for pesos)
 * that a card's still-owed reckoning applies to the previous facturación first, as the bank
 * does (`dashboardCcUpcomingPayments.ts`).
 */
export function openFacturacionCredits(accountId: number, billingMonth: string): Record<string, number> {
  const credits: Record<string, number> = { clp: 0, usd: 0 };
  withCcOneShotScanCache(() => {
    for (const stmtDate of statementDatesForFacturacion(accountId, billingMonth)) {
      for (const r of billedOneShotLines(accountId, stmtDate)) {
        if (isCcPaymentOrUsdDebtAbonoMerchant(r.merchant) || isCcTraspasoDeudaMerchant(r.merchant)) continue;
        const native = cardLineNativeAmount({ ...r, installment_flag: 0 });
        if (!native) continue;
        const amount = isHomeCurrency(native.currency) ? Math.round(native.amount) : native.amount;
        if (amount < 0) credits[native.currency] = (credits[native.currency] ?? 0) - amount;
      }
    }
  });
  return Object.fromEntries(Object.entries(credits).map(([c, v]) => [c, roundToCurrency(v, c)]));
}

function installmentCuotaDueForAccountStatementDateClp(
  accountId: number,
  statementDate: string
): number {
  const fxDateIso = balanceUsdFxDateIso(accountId, statementDate);
  const rows = linesOfClose(accountId, statementDate);

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
    const cuota = debtCcExpenseLineAmountClp(
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
  stmt: { id: number; currency: string; monto_facturado: number | null; source_kind: string; billing_month: string | null },
  fxDate: string
): { facturado_clp: number | null; facturado_usd: number | null } {
  const headerMonto = statementHeaderFacturado(stmt);
  if (stmt.currency === "usd") { // convention-ok: Santander's traspaso and header-payment legs are pesos or dollars (plan C3 leftover)
    // A dollar statement that prints no total (the Santander international JSON) bills what its
    // own lines bill: summing peso lines for it had left a facturación's dollars out of its total.
    const usd = headerMonto ?? foreignBilledFromStatementLines(stmt.id, "usd");
    const fx = debtFrameClpPerUsd(balanceUsdFxDateIso(accountId, statementDate));
    const clp = fx != null ? Math.round(usd * fx) : null;
    return { facturado_clp: clp, facturado_usd: usd };
  }
  if (headerMonto != null) {
    return {
      facturado_clp: Math.round(headerMonto),
      facturado_usd: null,
    };
  }
  const revolving = sumRevolvingChargesClpForStatementDate(accountId, statementDate);
  const cuota = installmentCuotaDueForAccountStatementDateClp(accountId, statementDate);
  let clp = revolving + cuota;
  if (clp <= 0) {
    if (!isListingSourceKind(stmt.source_kind)) {
      // The statement's own facturación (`billingMonthForCcStatement`, stamped by the loader).
      const billingMonth = stmt.billing_month;
      if (billingMonth) {
        clp = ledgerFacturadoClpForBillingMonth(accountId, billingMonth);
      }
    }
  }
  return { facturado_clp: clp > 0 ? clp : null, facturado_usd: null };
}

const updateBalanceFromDetalle = db.prepare(`
  UPDATE cc_billing_month_metrics SET amount = CASE metric WHEN 'cupo_utilizado' THEN ? ELSE ? END
  WHERE account_id = ? AND billing_month = ? AND currency = 'clp' AND metric IN ('cupo_utilizado', 'saldo_total')
`);

/**
 * Rebuilds one card's stored `cc_billing_month_metrics` snapshot: a row per statement slot, as
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
  const statements = listCcStatementsForAccount(accountId);
  const months = new Set<string>();
  let n = 0;

  db.prepare(`DELETE FROM cc_billing_month_metrics WHERE account_id = ?`).run(accountId);

  for (const [billingMonth, slot] of statementSlotsByBillingMonth(accountId)) {
    const primary = primaryStatementOfSlot(accountId, slot);
    if (!primary?.statement_date_iso) continue;
    const asOfIso = primary.statement_date_iso;
    const { facturado_clp, facturado_usd } = facturadoClpUsdForStatementSlot(accountId, slot);
    const saldo_total_usd =
      slot.get("usd")?.deuda_total != null && slot.get("usd")!.deuda_total! > 0 ? slot.get("usd")!.deuda_total! : 0;

    writeBalance({
      account_id: accountId,
      billing_month: billingMonth,
      as_of_date: asOfIso,
      as_of_kind: "statement",
      facturado: { clp: facturado_clp > 0 ? facturado_clp : null, usd: facturado_usd > 0 ? facturado_usd : null },
      saldo_total: { usd: saldo_total_usd > 0 ? saldo_total_usd : null },
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
    updateBalanceFromDetalle.run(row.cupo_statement_clp, row.balance_statement_clp, accountId, billingMonth);
  }

  return n;
}

export function listCcBillingMonthBalances(accountId: number): CcBillingMonthBalanceRow[] {
  const rows = db
    .prepare(
      `SELECT id, billing_month, as_of_date, as_of_kind, metric, currency, amount
       FROM cc_billing_month_metrics WHERE account_id = ? ORDER BY id`
    )
    .all(accountId) as {
    id: number;
    billing_month: string;
    as_of_date: string;
    as_of_kind: string;
    metric: string;
    currency: string;
    amount: number;
  }[];
  const byKey = new Map<string, CcBillingMonthBalanceRow>();
  for (const r of rows) {
    const key = `${r.billing_month}|${r.as_of_date}|${r.as_of_kind}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        id: r.id,
        account_id: accountId,
        billing_month: r.billing_month,
        as_of_date: r.as_of_date,
        as_of_kind: r.as_of_kind,
        facturado_clp: null,
        facturado_usd: null,
        cupo_utilizado_clp: 0,
        saldo_total_clp: 0,
        saldo_total_usd: null,
        facturado_by_currency: {},
        saldo_total_by_currency: {},
        cupo_utilizado_by_currency: {},
      };
      byKey.set(key, row);
    }
    if (r.metric === "facturado") row.facturado_by_currency[r.currency] = r.amount;
    else if (r.metric === "saldo_total") row.saldo_total_by_currency[r.currency] = r.amount;
    else if (r.metric === "cupo_utilizado") row.cupo_utilizado_by_currency[r.currency] = r.amount;
    else throw new Error(`Account ${accountId}: billing-month metric ${r.metric} has no reader`);
  }
  const out = [...byKey.values()];
  for (const row of out) {
    row.facturado_clp = row.facturado_by_currency.clp ?? null;
    row.facturado_usd = row.facturado_by_currency.usd ?? null;
    row.saldo_total_clp = row.saldo_total_by_currency.clp ?? 0;
    row.cupo_utilizado_clp = row.cupo_utilizado_by_currency.clp ?? 0;
    row.saldo_total_usd = row.saldo_total_by_currency.usd ?? null;
  }
  // The old table's order: month and as-of descending, ties by insertion.
  return out.sort(
    (a, b) => b.billing_month.localeCompare(a.billing_month) || b.as_of_date.localeCompare(a.as_of_date) || a.id - b.id
  );
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
}
