import {
  balanceUsdFxDateIso,
  incrementalChargesClpForBillingMonth,
  installmentPurchasesClpAfter,
  listCcBillingMonthBalances,
  facturadoFromStatement,
  openMonthForeignFacturado,
  payByFxDateIso,
  unbilledAtMonthEndAdjustmentsClp,
  foreignPaymentPaidStatementDateResolver,
  type CcBillingMonthBalanceRow,
  type CcOwedNative,
} from "./ccBillingBalances.js";
import { debtCardLineAmountClp, debtFrameClp, debtFrameClpPerUnit, debtFrameRates, REAL_DEBT_FRAME_RATES, type DebtFrameRates } from "./ccExpenseAmountClp.js";
import {
  accountHasStatementsIn,
  cardForeignCurrencies,
  facturacionForeignRatesForAccount,
  type FacturacionForeignRateSource,
} from "./ccFacturacionForeignRate.js";
import { currencyMinorDigits, isHomeCurrency } from "./displayUnits.js";
import { withCcOneShotScanCache, planCount } from "./cards/purchases.js";
import {
  primaryStatementOfSlot,
  statementSlotsByBillingMonth,
  type CcStatementSlotByCurrency,
} from "./ccBillingStatementSlots.js";
import { ccLedgerMonthEndIso, creditCardInstallmentPaymentsByBillingMonth, installmentRemainingClpByCalendarMonth, liveCreditCardOutstandingClp } from "./ccInstallmentLedgerDb.js";
import { cardStoppedBilling } from "./cards/lifecycle.js";
import { billingMonthForManualLedgerPurchase, closeDateForBillingMonth, pdfClosedBillingMonthsForAccount, provisionallyClosedBillingMonthsForAccount } from "./cards/facturacion.js";
import { feedBillingCloseForMonth, type CcCloseSource } from "./cards/facturacion.js";
import type { CcCuotaPurchaseKind } from "./ccCuotaPurchaseKinds.js";
import { facturacionMonthByStatementDate, statementDatesForFacturacion } from "./cards/facturacionByStatementDate.js";
import { parseOpenWebPasteBillingMonth } from "./cards/openWebPasteSource.js";
import { linesOfStatement, openCycleCuotaPurchaseLines } from "./cards/purchases.js";
import { isCardPaymentLine } from "./ccPaymentLines.js";
import { ymCompare } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { derivedPayByIso, resolveInstallmentPayByIso, statementLineDateIso } from "./ccInstallmentPayBy.js";
import { ccDerivedPayByRuleForAccount } from "./ccIssuerForAccount.js";
import { listCcStatementsForAccount, type CcStatementRow } from "./ccStatementsDb.js";
import type { CcInstallmentMonthRow } from "./cards/planTypes.js";
import { ddMmYyyyFromIso, parseDdMmYyToIso, addCalendarMonths } from "nw-tracker-contracts";
/**
 * A detalle row in the STATEMENT frame — what the billing-detail bundle builds and every internal
 * reader consumes: the month-end valuation anchors (`ccLedgerStatementClosingPointsClp`), the
 * stored `cc_billing_month_metrics` snapshot, the «Cupo» card and the historial's billing-frame
 * fallback. A closed month's billed cuotas ride inside its facturado and its cupo is the plan
 * remainder after its close; facturado + cupo = balance. The month frame the table shows
 * ({@link CcBillingDetailMonthRow}) is overlaid outside the bundle, so nothing the bundle build
 * reaches can read it — the daily walk that produces it reads this bundle.
 */
export type CcBillingDetailStatementRow = {
  billing_month: string;
  as_of_date: string;
  as_of_kind: "statement" | "manual";
  /** Closed-statement facturado only; null when not yet closed. */
  total_facturado_actual: number | null;
  /** Same as actual for balance math (no manual estimate). */
  total_facturado: number | null;
  /**
   * Statement frame: the plan remainder after this facturación's close, the live cupo for the
   * open month (`ccCupoFrame`). What the statement prints as «cupo utilizado en cuotas».
   */
  cupo_statement: number;
  /** Ledger cuota due in the pay-by month (~10th of month after close). */
  cuota_a_pagar_next_mes: number;
  /**
   * Statement frame: facturado + `cupo_statement`, plus — on a closed month — the activity
   * dated through its calendar month-end that a later facturación bills. The month-end anchor.
   */
  balance_statement: number;
  /** Plan-only future month (no statement or balance evidence yet). */
  projected?: boolean;
  /**
   * Closed at the bank, statement not imported yet (see `isProvisionallyClosedBillingMonth`):
   * facturado is the feed's SALDO INICIAL when the feed observed the close, else the app's
   * estimate. Statement-framed like a closed month so the next month's roll starts from it.
   */
  provisional?: boolean;
};

/**
 * The «Detalle por mes» row the card and group payloads carry (the client DTO): the statement
 * frame plus the MONTH frame — the historial chart's two lines on the month's last day (today for
 * the current month, the plan tail after it), overlaid from the same sampled map the chart is
 * drawn from (`overlayBillingDetailMonthLines` in `creditCardChartSeries.ts`), so the table's
 * «Deuda en cuotas» and «Balance total» equal the chart point of the same month by construction.
 * Billed cuotas leave the plan debt on their pay-by (~10th of the next month), so a closed month
 * reads one billed cycle above its statement cupo here (·0901 2026-10: 5,6 M statement frame,
 * 7,5 M on the 31st).
 */
export type CcBillingDetailMonthRow = CcBillingDetailStatementRow & {
  /** Month frame: «deuda en cuotas» (the plan-debt walk) on the month's last day; null when the lines have none. */
  cupo_en_cuotas: number | null;
  /** Month frame: «saldo total» (the owed walk) on the month's last day; null when the lines have none. */
  balance_total: number | null;
};

export type CcFacturacionRow = {
  billing_month: string;
  close_date: string;
  close_date_iso: string;
  pay_by: string | null;
  pay_by_iso: string | null;
  /** Where the pay-by comes from: the statement's printed PAGAR HASTA, or derived from the close
   * (~10th of the next month) while no statement prints it — open and provisional months, and a
   * statement without the field. Null with no pay-by at all. */
  pay_by_source: "statement" | "derived" | null;
  /** What it billed in the card's billing currency itself (`cardBillingCurrency`). */
  facturado: number | null;
  /**
   * What the facturación billed in each foreign currency the card bills in (`cardForeignCurrencies`),
   * with its pesos and the rate they show at (docs/any-currency-plan.md C3).
   */
  facturado_foreign: CcFacturadoForeign[];
  facturado_total: number | null;
  cuota_a_pagar: number | null;
  /**
   * «Deuda en cuotas» in the statement frame: the plan cuotas not yet billed after this
   * facturación's close plus the month's tagged cuota purchases of unknown count — what the
   * statement prints as «saldo capital cuotas». The same post-close rule on every row, the open
   * month included (never the live cupo, which still holds the cuotas the open close will bill);
   * null only on a card with no plan ledger.
   */
  deuda_en_cuotas: number | null;
  /** No imported PDF close yet — facturado = únicos + cuota a pagar. */
  is_open_month: boolean;
  /** Closed at the bank, statement pending (feed SALDO INICIAL or a passed announced close). */
  is_provisional_close: boolean;
  /** Where `close_date` comes from; `estimated` = config cycle, nothing published by the bank. */
  close_date_source: CcCloseSource;
  /** Provisional month with the bank's total: what the app had estimated for it (únicos + cuotas). */
  provisional_estimate_total: number | null;
};

/** A facturación's billing in one foreign currency. */
export type CcFacturadoForeign = {
  currency: string;
  /**
   * What it billed in the currency: null on a closed month with no statement in it; an open cycle
   * that has billed nothing in it yet reads 0.
   */
  amount: number | null;
  /** Its amount in the billing currency: at the rate it shows (`rate`) once rates apply, the debt frame (pay-by − 1) before. */
  billing_amount: number | null;
  /**
   * The rate the charges in this currency show at — `clp` and the expense lines: the rate actually
   * paid, today's while unpaid (`ccFacturacionForeignRate.ts`). Null on a card that never billed
   * in the currency, and on the rows before rates apply.
   */
  rate: number | null;
  rate_source: FacturacionForeignRateSource | null;
};

/** The row's entries, one per foreign currency the card bills in, from what each billed (absent: nothing). */
function facturadoForeignEntries(
  accountId: number,
  billed: ReadonlyMap<string, { amount: number | null; clp: number | null }>
): CcFacturadoForeign[] {
  return cardForeignCurrencies(accountId).map((currency) => {
    const b = billed.get(currency);
    return { currency, amount: b?.amount ?? null, billing_amount: b?.clp ?? null, rate: null, rate_source: null };
  });
}

/** The row's entry in `currency`, if the card bills in it. */
export function facturadoForeignIn(row: Pick<CcFacturacionRow, "facturado_foreign">, currency: string): CcFacturadoForeign | null {
  return row.facturado_foreign.find((f) => f.currency === currency) ?? null;
}

/**
 * A foreign amount valued as debt for a facturación paid by `payByIso` (the stored close of
 * pay-by − 1, or the rate of a split pass). Null when there is no pay-by or no rate on file.
 */
function foreignToClpAsDebt(amount: number, currency: string, payByIso: string | null, rates: DebtFrameRates | undefined): number | null {
  if (!Number.isFinite(amount) || !payByIso) return null;
  const rate = debtFrameClpPerUnit(currency, payByFxDateIso(payByIso), rates);
  return rate == null ? null : Math.round(amount * rate);
}

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
 *
 * One rule for every reader, through {@link ccCupoFrame}: the detalle, the stored
 * `cc_billing_month_metrics` snapshot (which copies the detalle's rows) and the month-end
 * valuation fallback. The last two used to carry their own copies keyed on the calendar month —
 * the double count above — one of them on the UTC month, which turns at 21:00 Chile.
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
  return cupoAfterCloseForBillingMonth(billingMonth, remainingAfterMonth, pendingCuotaPurchases);
}

/**
 * The post-close rule of {@link cupoEnCuotasForBillingMonth} applied to any billing month, the
 * open one included: the plan remainder after the month's close plus that month's tagged cuota
 * purchases of unknown count — the «saldo capital cuotas» a statement of that close prints.
 */
function cupoAfterCloseForBillingMonth(
  billingMonth: string,
  remainingAfterMonth: ReadonlyMap<string, number>,
  pendingCuotaPurchases: ReadonlyMap<string, number>
): number {
  return (remainingAfterMonth.get(billingMonth) ?? 0) + (pendingCuotaPurchases.get(billingMonth) ?? 0);
}

/** What decides a card's billing months — open, provisionally closed — and each month's cupo en cuotas. */
export type CcCupoFrame = {
  /** The card stopped billing (`cardStoppedBilling`): no provisional months. */
  inactive: boolean;
  /** The open facturación (`billingMonthForManualLedgerPurchase`, from the bank's close evidence). */
  openBillingMonth: string | null;
  /** Closed at the bank, statement not imported yet. */
  provisionalMonths: Set<string>;
  /** Cupo en cuotas of a billing month ({@link cupoEnCuotasForBillingMonth}). */
  cupoEnCuotasClp: (billingMonth: string) => number;
  /**
   * The cuotas left unbilled after a billing month's close ({@link cupoAfterCloseForBillingMonth}):
   * equal to `cupoEnCuotasClp` on a closed month, the post-close rule instead of the live figure
   * on the open one — the facturaciones' «deuda en cuotas» column.
   */
  cupoAfterCloseClp: (billingMonth: string) => number;
};

/**
 * The cupo frame of one card. `ledgerMonths` is the plan schedule by facturación, full history
 * (the detalle's cuota-a-pagar source): what a provisional close billed is read from it.
 */
export function ccCupoFrame(accountId: number, ledgerMonths: readonly CcInstallmentMonthRow[]): CcCupoFrame {
  const inactive = cardStoppedBilling(accountId);
  // Closed at the bank, statement pending: a row even without bucket lines, statement-framed.
  const provisionalMonths = inactive
    ? new Set<string>()
    : provisionallyClosedBillingMonthsForAccount(accountId);
  const openBillingMonth = billingMonthForManualLedgerPurchase(accountId);
  const cupoLive = liveCreditCardOutstandingClp(accountId) ?? 0;
  const remainingAfterMonth = installmentRemainingClpByCalendarMonth(accountId);
  const pendingCuotaPurchases = cuotaPurchaseLinesClpByBucketMonth(accountId);
  // Cuotas the bank billed at a close whose statement has not arrived (see the cupo rule).
  let provisionalBilledCuotasClp = 0;
  for (const bm of provisionalMonths) {
    if (openBillingMonth == null || bm < openBillingMonth) {
      provisionalBilledCuotasClp += cuotaAPagarNextMesClp(bm, ledgerMonths);
    }
  }
  return {
    inactive,
    openBillingMonth,
    provisionalMonths,
    cupoEnCuotasClp: (billingMonth) =>
      cupoEnCuotasForBillingMonth(
        billingMonth,
        cupoLive,
        openBillingMonth,
        remainingAfterMonth,
        pendingCuotaPurchases,
        provisionalBilledCuotasClp
      ),
    cupoAfterCloseClp: (billingMonth) =>
      cupoAfterCloseForBillingMonth(billingMonth, remainingAfterMonth, pendingCuotaPurchases),
  };
}

export type { CcStatementSlotByCurrency } from "./ccBillingStatementSlots.js";
export { statementSlotsByBillingMonth } from "./ccBillingStatementSlots.js";

/** What a slot's statements billed: the peso statement's pesos and one entry per foreign statement. */
type SlotFacturado = {
  /** The peso statement's facturado; null when the slot has none or it billed nothing. */
  clp: number | null;
  /** Each foreign statement: what it billed in its currency and those pesos in the debt frame. */
  foreign: Map<string, { amount: number; clp: number }>;
};

/**
 * Each statement of a slot through `facturadoFromStatement`. A foreign statement's pesos are the
 * debt frame of the FACTURACIÓN's pay-by (`payByIso`), else of the statement's own; an amount
 * with no rate on file either way throws — a total that left it out would read the month short.
 */
function slotFacturado(
  accountId: number,
  slot: CcStatementSlotByCurrency,
  payByIso: string | null,
  rates: DebtFrameRates | undefined
): SlotFacturado {
  const out: SlotFacturado = { clp: null, foreign: new Map() };
  for (const [currency, st] of slot) {
    const derived = facturadoFromStatement(accountId, st.statement_date, st, rates);
    if (isHomeCurrency(currency)) {
      out.clp = derived.clp;
      continue;
    }
    const amount = derived.amount ?? 0;
    const clp = foreignToClpAsDebt(amount, currency, payByIso, rates) ?? derived.clp;
    if (clp == null) {
      if (amount !== 0) {
        throw new Error(
          `Account ${accountId} statement ${st.statement_date}: no ${currency.toUpperCase()} debt-frame rate ` +
            `for its facturado (pay-by ${payByIso ?? "unknown"})`
        );
      }
      out.foreign.set(currency, { amount, clp: 0 });
      continue;
    }
    out.foreign.set(currency, { amount, clp });
  }
  return out;
}

/** What a billing-month statement slot billed in each currency a statement of it is in (0 when it billed none). */
export function facturadoByCurrencyForStatementSlot(accountId: number, slot: CcStatementSlotByCurrency): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [currency, st] of slot) {
    out[currency] = facturadoFromStatement(accountId, st.statement_date, st, REAL_DEBT_FRAME_RATES).amount ?? 0;
  }
  return out;
}

/** Every currency's facturado of a billing month's imported statements, in pesos (header or line-derived). */
function facturadoTotalClpForStatementSlot(
  accountId: number,
  slot: CcStatementSlotByCurrency,
  rates: DebtFrameRates | undefined
): number | null {
  const primary = primaryStatementOfSlot(accountId, slot);
  if (!primary) return null;
  const { pay_by_iso: payByIso } = resolveFacturacionPayBy(accountId, slot, primary);
  const billed = slotFacturado(accountId, slot, payByIso, rates);
  // A statement in credit bills a negative amount (`statementHeaderFacturado`): the total may be
  // 0 or below, and is still what the statements billed.
  if (billed.clp == null && billed.foreign.size === 0) return null;
  let total = billed.clp ?? 0;
  for (const f of billed.foreign.values()) total += f.clp;
  return total;
}


/**
 * Sum PAGO / ABONO / ABONO DE DIVISAS lines in a billing month, in CLP (DB stores payments as
 * negative). A divisas abono is a line in the foreign currency — it is valued through
 * `debtCardLineAmountClp` at `balanceUsdFxDateIso`, the exact helper + FX date the
 * open-cycle charge sums use, so the open-month balance roll (charges − payments) is unchanged
 * by classifying it as a payment instead of a negative charge.
 */
export function paymentAbonosClpForBillingMonth(
  accountId: number,
  billingMonth: string,
  rates?: DebtFrameRates
): number {
  let sum = 0;
  const dates = new Set(statementDatesForFacturacion(accountId, billingMonth));
  // A dollar payment cancels the dollar debt it paid at that debt's fx, as the owed walk values it
  // (`normalizedPostCloseLines`): at this statement's fx instead, the rolled balance read the
  // difference between the paid facturación's rate and today's as owed.
  const paidStatementDate = foreignPaymentPaidStatementDateResolver(accountId);
  for (const st of listCcStatementsForAccount(accountId)) {
    if (!dates.has(st.statement_date)) continue;
    const fxDateIso = balanceUsdFxDateIso(accountId, st.statement_date);
    const rows = linesOfStatement(st.id);
    for (const r of rows) {
      if (!isCardPaymentLine(r)) continue;
      const foreignPayment = !isHomeCurrency(r.currency) && (r.amount ?? 0) < 0;
      const paymentIso = foreignPayment ? statementLineDateIso(r) : null;
      const paidDate = paymentIso ? paidStatementDate(r.currency, paymentIso) : null;
      const lineFxDateIso = paidDate ? balanceUsdFxDateIso(accountId, paidDate) : fxDateIso;
      // Null = a payment line of zero; a foreign payment with no rate throws.
      const clp = debtCardLineAmountClp(
        { installment_flag: 0, amount: r.amount, currency: r.currency, cuota_amount: null },
        lineFxDateIso,
        rates,
        `Account ${accountId} statement ${st.statement_date} payment line ${r.id}`
      );
      if (clp == null) continue;
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
  billingMonth: string,
  rates?: DebtFrameRates
): number {
  // A cuota purchase the feed typed but whose plan is not known yet is not billed in its cycle
  // (cuota comercio: nothing; precio contado: one cuota of an unknown count) — `ccFeedCuotaPurchases.ts`.
  const pendingCuotaPurchases = cuotaPurchaseLinesClpByBucketMonth(accountId).get(billingMonth) ?? 0;
  const charges = incrementalChargesClpForBillingMonth(accountId, billingMonth, rates) - pendingCuotaPurchases;
  return charges > 0 ? Math.round(charges) : 0;
}

/** A feed-typed cuota purchase still waiting for its plan: the count is not known yet. */
export type CcPendingCuotaPurchase = {
  statement_line_id: number;
  merchant: string | null;
  /** Purchase date (ISO) — installment debt from this day, like a plan's contract. */
  purchase_date: string;
  /** Full principal in the card's billing currency, what the feed listed. */
  amount: number;
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
  const out: CcPendingCuotaPurchase[] = [];
  for (const r of openCycleCuotaPurchaseLines(accountId)) {
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
      amount: Math.abs(r.amount_clp ?? 0),
      kind: r.cuota_purchase_kind,
      billing_month: bm,
    });
  }
  return out;
}

/** Σ CLP of {@link pendingCuotaPurchaseLines} per open-bucket month. */
function cuotaPurchaseLinesClpByBucketMonth(accountId: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of pendingCuotaPurchaseLines(accountId)) {
    out.set(p.billing_month, (out.get(p.billing_month) ?? 0) + p.amount);
  }
  return out;
}

/**
 * Open-month facturado: what is billed in THIS facturación cycle — charges/únicos billed so
 * far plus the cuota a pagar — not the prior balance rolled forward, and not net of the prior
 * bill's PAGO. Shared by Facturaciones and Detalle por mes so both views report the same facturado.
 */
function openMonthFacturadoTotalClp(
  accountId: number,
  billingMonth: string,
  cuotaAPagarClp: number,
  rates: DebtFrameRates | undefined
): number {
  const uniquo = facturadoClpFromOpenMonthStatementLines(accountId, billingMonth, rates);
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
  /**
   * What it billed per foreign currency, in that currency and in pesos: the feed's SALDO INICIAL
   * in each currency it states one, else the open cycle's lines in each currency.
   */
  foreign: Map<string, { amount: number | null; clp: number | null }>;
  total_clp: number;
  /** The app's own estimate for the month (únicos billed so far + cuota a pagar). */
  estimate_total_clp: number;
};

/**
 * The open cycle's foreign lines of a month as facturado entries: each currency a line bills in,
 * its amount and its pesos (whole), left out when both are 0.
 */
function openCycleForeignFacturado(
  accountId: number,
  billingMonth: string,
  rates: DebtFrameRates | undefined
): Map<string, { amount: number; clp: number }> {
  const out = new Map<string, { amount: number; clp: number }>();
  for (const [currency, v] of openMonthForeignFacturado(accountId, billingMonth, rates)) {
    if (v.amount !== 0 || v.clp !== 0) out.set(currency, { amount: v.amount, clp: Math.round(v.clp) });
  }
  return out;
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
  cuotaAPagarClp: number,
  rates: DebtFrameRates | undefined
): ProvisionalFacturado {
  const close = closeDateForBillingMonth(accountId, billingMonth);
  const pay_by_iso = derivedPayByIso(close.close_iso, ccDerivedPayByRuleForAccount(accountId));
  const estimate_total_clp = openMonthFacturadoTotalClp(accountId, billingMonth, cuotaAPagarClp, rates);
  const base = {
    close_iso: close.close_iso,
    close_ddmmyyyy: close.close_ddmmyyyy,
    close_source: close.source,
    pay_by_iso,
    estimate_total_clp,
  };
  const feed = feedBillingCloseForMonth(accountId, billingMonth);
  if (!feed) {
    const foreign = openCycleForeignFacturado(accountId, billingMonth, rates);
    let foreignClp = 0;
    for (const v of foreign.values()) foreignClp += v.clp;
    return {
      ...base,
      source: "estimate",
      facturado_clp: estimate_total_clp - foreignClp,
      foreign,
      total_clp: estimate_total_clp,
    };
  }
  // The bank's figure per currency it stated one in; a currency the card bills in that the feed
  // did not state reads «unknown» (null), never 0.
  let facturado_clp = 0;
  let total_clp = 0;
  const foreign = new Map<string, { amount: number | null; clp: number | null }>(
    cardForeignCurrencies(accountId).map((c): [string, { amount: number | null; clp: number | null }] => [c, { amount: null, clp: null }])
  );
  for (const [currency, amount] of Object.entries(feed.saldo_inicial)) {
    if (isHomeCurrency(currency)) {
      facturado_clp = Math.round(amount);
      total_clp += facturado_clp;
      continue;
    }
    const clp = debtFrameClp(
      amount,
      currency,
      pay_by_iso ? payByFxDateIso(pay_by_iso) : null,
      rates,
      `Account ${accountId} ${billingMonth}: the feed-observed close's ${currency.toUpperCase()} SALDO INICIAL (pay-by ${pay_by_iso})`
    );
    foreign.set(currency, { amount, clp });
    total_clp += clp;
  }
  return { ...base, source: "feed", facturado_clp, foreign, total_clp };
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
  ledgerMonths: readonly CcInstallmentMonthRow[]
): number {
  // Plan months are statement/facturación months: the cuotas billed at this month's close
  // (payable ~10th of the next month) live at the billing month itself. The old +1 /
  // pay-by-month lookup read the NEXT cycle's cuotas — nearly equal for constant-cuota
  // plans, wrong at every plan start/end.
  const row = ledgerMonths.find((m) => m.month === billingMonth);
  return row && row.total > 0 ? row.total : 0;
}

export function buildBillingDetailByMonth(
  accountId: number,
  ledgerMonths: CcInstallmentMonthRow[] = [],
  rates?: DebtFrameRates
): CcBillingDetailStatementRow[] {
  // Memoize the account-level one-shot scans for this synchronous build (read-only).
  return withCcOneShotScanCache(() => buildBillingDetailByMonthInner(accountId, ledgerMonths, rates));
}

/** The uniform rates of the split passes: multiples of 100, so a currency counted to the cent converts to whole pesos. */
const SPLIT_RATES = [900, 1000, 1100] as const;

/**
 * Each month's statement-frame balance (`balance_statement`, the month-end anchor) split into
 * the pesos and each foreign currency it is made of (`cardForeignCurrencies`). The balance is
 * built from pesos and from foreign amounts converted at debt-frame rates, so it is affine in each
 * currency's uniform rate r_c: b = pesos + Σ amount_c · r_c. A base build with every currency at
 * 1000, and per currency two builds with that one at 900 and 1100, give every part; when a
 * currency's three are not on one line (a clamp or a branch that mixes the currencies) the split is
 * not defined and this throws.
 */
export function ccStatementOwedByCurrencyByMonth(
  accountId: number,
  ledgerMonths: CcInstallmentMonthRow[]
): Map<string, CcOwedNative> {
  const currencies = cardForeignCurrencies(accountId);
  const build = (rates: Map<string, number>) =>
    new Map(
      buildBillingDetailByMonth(accountId, ledgerMonths, debtFrameRates(rates)).map((row) => [row.billing_month, row.balance_statement])
    );
  const base = (over?: [string, number]) => {
    const rates = new Map(currencies.map((c) => [c, SPLIT_RATES[1] as number]));
    if (over) rates.set(over[0], over[1]);
    return rates;
  };
  const mid = build(base());
  const legs = currencies.map((c) => ({
    currency: c,
    lo: build(base([c, SPLIT_RATES[0]])),
    hi: build(base([c, SPLIT_RATES[2]])),
  }));
  const out = new Map<string, CcOwedNative>();
  for (const [month, bMid] of mid) {
    const owed: CcOwedNative = { clp: 0 };
    let pesos = bMid;
    for (const leg of legs) {
      const bLo = leg.lo.get(month);
      const bHi = leg.hi.get(month);
      if (bLo == null || bHi == null) {
        throw new Error(`Account ${accountId} ${month}: the statement frame has the month at one rate and not another`);
      }
      if (bHi - bMid !== bMid - bLo) {
        throw new Error(
          `Account ${accountId} ${month}: the statement-frame balance is not affine in the ${leg.currency.toUpperCase()} rate ` +
            `(${bLo} / ${bMid} / ${bHi} at ${SPLIT_RATES.join(" / ")}) — cannot split it by currency`
        );
      }
      const scale = 10 ** currencyMinorDigits(leg.currency);
      const amount = Math.round(((bHi - bLo) / (SPLIT_RATES[2] - SPLIT_RATES[0])) * scale) / scale;
      owed[leg.currency] = amount;
      pesos -= amount * SPLIT_RATES[1];
    }
    owed.clp = Math.round(pesos);
    out.set(month, owed);
  }
  return out;
}

function buildBillingDetailByMonthInner(
  accountId: number,
  ledgerMonths: CcInstallmentMonthRow[],
  rates: DebtFrameRates | undefined
): CcBillingDetailStatementRow[] {
  const balances = listCcBillingMonthBalances(accountId).filter(
    (r) => r.as_of_kind !== "month_end"
  );
  const slots = statementSlotsByBillingMonth(accountId);
  const pdfClosed = pdfClosedBillingMonthsForAccount(accountId);
  const frame = ccCupoFrame(accountId, ledgerMonths);
  const { inactive, provisionalMonths } = frame;
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
  // The open facturación is a row from the day the bank closes the previous one: its snapshot row
  // is written on the next card write (`recomputeCcBillingMonthBalances`) and its bucket when a
  // line lands, so the morning after a close neither exists yet — the month then read as a plan
  // projection, and «Balance total» fell back to the provisional month's statement frame.
  const openBillingMonth = inactive ? null : frame.openBillingMonth;
  if (openBillingMonth) {
    months.add(openBillingMonth);
  }

  const lastStatementBillingMonth =
    inactive && slots.size > 0
      ? [...slots.keys()].sort((a, b) => a.localeCompare(b)).at(-1) ?? null
      : null;

  const openBmRoll = frame.openBillingMonth;
  const out: CcBillingDetailStatementRow[] = [];
  for (const billingMonth of months) {
    const slot = slots.get(billingMonth);
    const primary = slot ? primaryStatementOfSlot(accountId, slot) : null;
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
    const isOpenMonth = billingMonth === openBillingMonth;
    if (!snap && !primary && !provisionalMonths.has(billingMonth) && !isOpenMonth) continue;

    const fromStatement = slot ? facturadoTotalClpForStatementSlot(accountId, slot, rates) : null;
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
        ? provisionalFacturado(accountId, billingMonth, cuotaNext, rates)
        : null;
    if (provisional) {
      // Closed at the bank: the billed total (the feed's, else the estimate) at the real close.
      totalFacturado = provisional.total_clp;
    } else if (!hasPdfClose && !inactive) {
      // Open month: facturado is what is billed this cycle (matches Facturaciones), not the
      // prior balance rolled forward.
      totalFacturado = openMonthFacturadoTotalClp(accountId, billingMonth, cuotaNext, rates);
    }

    // The open month is `manual` with or without its bucket or snapshot row; without either it is
    // as of today, the day the snapshot writer would stamp it.
    const kind: "statement" | "manual" = provisional
      ? "statement"
      : !hasPdfClose && (primary != null || isOpenMonth)
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
      (isOpenMonth ? chileCalendarTodayYmd() : `${billingMonth}-01`);

    const cupo = frame.cupoEnCuotasClp(billingMonth);
    const balanceTotal = billingDetailBalanceClp(totalFacturado, cupo);
    out.push({
      billing_month: billingMonth,
      as_of_date: asOfDate,
      as_of_kind: kind,
      total_facturado_actual: totalFacturado,
      total_facturado: totalFacturado,
      cupo_statement: cupo,
      cuota_a_pagar_next_mes: cuotaNext,
      balance_statement: balanceTotal,
      ...(provisional ? { provisional: true } : {}),
    });
  }

  // Roll the most-recently-closed month's balance into the open month.
  // Balance = the closed month's balance + (charges this cycle + cuota plans bought after its calendar
  // month-end − payments this cycle) — the same events the daily owed walk adds.
  // This means: before any PAGO row is imported, open month mirrors the closed balance.
  if (openBmRoll && !inactive) {
    const openIdx = out.findIndex((r) => r.billing_month === openBmRoll);
    if (openIdx >= 0) {
      const priorClosed = out
        .filter((r) => r.billing_month < openBmRoll && r.as_of_kind === "statement")
        .sort((a, b) => b.billing_month.localeCompare(a.billing_month))[0];
      if (priorClosed) {
        const netCharges =
          incrementalChargesClpForBillingMonth(accountId, openBmRoll, rates) +
          installmentPurchasesClpAfter(accountId, ccLedgerMonthEndIso(priorClosed.billing_month)) -
          paymentAbonosClpForBillingMonth(accountId, openBmRoll, rates);
        out[openIdx]!.balance_statement = Math.round(priorClosed.balance_statement + netCharges);
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
  const adjustments = unbilledAtMonthEndAdjustmentsClp(
    accountId,
    facturacionMonthByStatementDate(accountId),
    statementRows.map((row) => ({
      billingMonth: row.billing_month,
      monthEndIso: ccLedgerMonthEndIso(row.billing_month),
    })),
    rates
  );
  statementRows.forEach((row, i) => {
    const adj = adjustments[i]!;
    if (adj !== 0) row.balance_statement = Math.round(row.balance_statement + adj);
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
  existing: CcBillingDetailStatementRow[]
): CcBillingDetailStatementRow[] {
  if (planCount(accountId) === 0 || existing.length === 0) {
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

  const projected: CcBillingDetailStatementRow[] = [];
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
      total_facturado_actual: null,
      total_facturado: null,
      cupo_statement: cupo,
      cuota_a_pagar_next_mes: cuotaNext,
      balance_statement: billingDetailBalanceClp(null, cupo),
      projected: true,
    });
  }

  return projected.length > 0 ? [...existing, ...projected] : existing;
}

/**
 * Re-values each facturación's dollar side at the rate it shows — the rate actually paid, today's
 * while unpaid (`ccFacturacionUsdRate.ts`) — instead of the debt frame the builder uses (pay-by − 1,
 * which the detalle, the owed walk and the month-end anchors keep). `facturado_clp` is untouched,
 * so the total is its CLP side plus the re-valued dollars.
 */
function applyFacturacionForeignRates(accountId: number, rows: CcFacturacionRow[]): void {
  for (const currency of cardForeignCurrencies(accountId)) {
    if (!accountHasStatementsIn(accountId, currency)) continue;
    const rates = facturacionForeignRatesForAccount(accountId, currency, rows);
    for (const row of rows) {
      const rate = rates.get(row.billing_month);
      if (!rate) throw new Error(`Account ${accountId}: no ${currency.toUpperCase()} rate for facturación ${row.billing_month}`);
      const entry = facturadoForeignIn(row, currency)!;
      entry.rate = rate.clp_per_unit;
      entry.rate_source = rate.source;
      if (entry.amount == null) continue;
      entry.billing_amount = Math.round(entry.amount * rate.clp_per_unit);
      const total = (row.facturado ?? 0) + row.facturado_foreign.reduce((s, f) => s + (f.billing_amount ?? 0), 0);
      row.facturado_total = row.facturado_total == null && total <= 0 ? null : total;
    }
  }
}

/** Explicit PDF pay_by when present; else derived from the close by the issuer's rule (see ccInstallmentPayBy). */
function resolveFacturacionPayBy(
  accountId: number,
  slot: CcStatementSlotByCurrency,
  primary: CcStatementRow
): { pay_by: string | null; pay_by_iso: string | null; pay_by_source: CcFacturacionRow["pay_by_source"] } {
  for (const st of [primary, ...slot.values()]) {
    if (!st) continue;
    const explicit = String(st.pay_by ?? "").trim();
    if (explicit) {
      return {
        pay_by: explicit,
        pay_by_iso: parseDdMmYyToIso(explicit),
        pay_by_source: "statement",
      };
    }
  }
  const payByIso = resolveInstallmentPayByIso(
    {
      statement_date: primary.statement_date_iso ?? primary.statement_date,
      period_to: primary.period_to ?? undefined,
    },
    () => ccDerivedPayByRuleForAccount(accountId)
  );
  if (!payByIso) return { pay_by: null, pay_by_iso: null, pay_by_source: null };
  return { pay_by: ddMmYyyyFromIso(payByIso), pay_by_iso: payByIso, pay_by_source: "derived" };
}

export function buildFacturaciones(
  accountId: number,
  ledgerMonths: CcInstallmentMonthRow[]
): CcFacturacionRow[] {
  return withFacturacionForeignRates(accountId, buildFacturacionesWithoutForeignRates(accountId, ledgerMonths));
}

/**
 * The facturaciones without the rates their foreign charges show at (each `facturado_foreign`
 * entry's `rate_clp` / `rate_source` null, its `clp` and `facturado_total` in the debt frame):
 * everything but the part an unpaid facturación reads from today's live rate. The billing-detail
 * cache keeps it apart (`ccBillingDetailCache.ts`), so a tick that moves a rate re-applies only the rates.
 */
export function buildFacturacionesWithoutForeignRates(
  accountId: number,
  ledgerMonths: CcInstallmentMonthRow[]
): CcFacturacionRow[] {
  return withCcOneShotScanCache(() => buildFacturacionesInner(accountId, ledgerMonths));
}

/** Copies of `rows` with the rates their foreign charges show at applied (`applyFacturacionForeignRates`). */
export function withFacturacionForeignRates(accountId: number, rows: readonly CcFacturacionRow[]): CcFacturacionRow[] {
  const out = rows.map((r) => ({ ...r, facturado_foreign: r.facturado_foreign.map((f) => ({ ...f })) }));
  applyFacturacionForeignRates(accountId, out);
  return out;
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
      byMonth.set(billingMonth, derivedPayByIso(close.close_iso, ccDerivedPayByRuleForAccount(accountId)));
    }
    const iso = byMonth.get(billingMonth);
    if (!iso) {
      throw new Error(`Account ${accountId}: facturación ${billingMonth} has no resolvable pay-by date`);
    }
    return iso;
  };
}

/**
 * The rate a facturación's lines in `currency` show at: its row's entry `rate_clp`, so its expense
 * lines add up to the row. A month the table has no row for yet (the open month before any bucket
 * lands in it, while a stale bucket's leftovers already belong to it) gets the rate its open row
 * would carry. Throws on a card that never billed in the currency (it has no rate).
 */
export function facturacionForeignRateResolver(
  accountId: number,
  currency: string,
  facturaciones: readonly CcFacturacionRow[]
): (billingMonth: string) => number {
  const resolve = facturacionForeignRateWithSourceResolver(accountId, currency, facturaciones);
  return (billingMonth) => resolve(billingMonth).clp_per_unit;
}

/** {@link facturacionForeignRateResolver} with the rate's source (paid, live, pay_by), for a line's converted amount. */
export function facturacionForeignRateWithSourceResolver(
  accountId: number,
  currency: string,
  facturaciones: readonly CcFacturacionRow[]
): (billingMonth: string) => { clp_per_unit: number; source: FacturacionForeignRateSource } {
  const byMonth = new Map<string, { clp_per_unit: number | null; source: FacturacionForeignRateSource | null }>(
    facturaciones.map((f) => {
      const e = facturadoForeignIn(f, currency);
      return [f.billing_month, { clp_per_unit: e?.rate ?? null, source: e?.rate_source ?? null }];
    })
  );
  return (billingMonth) => {
    if (!byMonth.has(billingMonth)) {
      const close = closeDateForBillingMonth(accountId, billingMonth).close_iso;
      const rates = facturacionForeignRatesForAccount(accountId, currency, [
        ...facturaciones,
        {
          billing_month: billingMonth,
          close_date_iso: close,
          pay_by_iso: derivedPayByIso(close, ccDerivedPayByRuleForAccount(accountId)),
        },
      ]);
      const r = rates.get(billingMonth)!;
      byMonth.set(billingMonth, { clp_per_unit: r.clp_per_unit, source: r.source });
    }
    const rate = byMonth.get(billingMonth)!;
    if (rate.clp_per_unit == null || rate.source == null) {
      throw new Error(
        `Account ${accountId}: facturación ${billingMonth} has no ${currency.toUpperCase()} rate for its ${currency.toUpperCase()} lines`
      );
    }
    return { clp_per_unit: rate.clp_per_unit, source: rate.source };
  };
}

function buildFacturacionesInner(
  accountId: number,
  ledgerMonths: CcInstallmentMonthRow[]
): CcFacturacionRow[] {
  const byMonth = statementSlotsByBillingMonth(accountId);
  const pdfClosed = pdfClosedBillingMonthsForAccount(accountId);
  // The detalle's frame: a card that stopped billing has no statement pending, so a close it no
  // longer bills is not a provisional facturación (without that gate the retired ·0161 read
  // December 2025 as «provisoria» for good — its November statement announced that close), and
  // each facturación's «deuda en cuotas» is the frame's post-close rule.
  const frame = ccCupoFrame(accountId, ledgerMonths);
  const { provisionalMonths } = frame;
  const hasPlanLedger = planCount(accountId) > 0;
  const deudaEnCuotasClp = (billingMonth: string): number | null =>
    hasPlanLedger ? frame.cupoAfterCloseClp(billingMonth) : null;

  const out: CcFacturacionRow[] = [];
  for (const [billingMonth, slot] of byMonth) {
    const primary = primaryStatementOfSlot(accountId, slot);
    if (!primary) continue;

    const { pay_by, pay_by_iso: payByIso, pay_by_source } = resolveFacturacionPayBy(accountId, slot, primary);
    const billed = slotFacturado(accountId, slot, payByIso, REAL_DEBT_FRAME_RATES);
    const facturadoClp = billed.clp;
    const billedForeign = billed.foreign;
    const cuotaAPagarClp = cuotaAPagarNextMesClp(billingMonth, ledgerMonths);
    const cuotaAPagar = cuotaAPagarClp > 0 ? cuotaAPagarClp : null;
    const facturadoTotal = facturadoTotalClpForStatementSlot(accountId, slot, REAL_DEBT_FRAME_RATES);
    const hasPdfClose = pdfClosed.has(billingMonth);
    if (!hasPdfClose && provisionalMonths.has(billingMonth)) {
      out.push(
        provisionalFacturacionRow(accountId, billingMonth, cuotaAPagarClp, deudaEnCuotasClp(billingMonth))
      );
      continue;
    }
    if (!hasPdfClose) {
      // The open month's bucket: the row reads the month, not the bucket (see `openFacturacionRow`).
      out.push(
        openFacturacionRow(accountId, billingMonth, cuotaAPagarClp, deudaEnCuotasClp(billingMonth), billedForeign)
      );
      continue;
    }

    out.push({
      billing_month: billingMonth,
      close_date: primary.statement_date,
      close_date_iso: primary.statement_date_iso,
      pay_by,
      pay_by_iso: payByIso,
      pay_by_source,
      facturado: facturadoClp,
      facturado_foreign: facturadoForeignEntries(accountId, billedForeign),
      facturado_total: facturadoTotal,
      cuota_a_pagar: cuotaAPagar,
      deuda_en_cuotas: deudaEnCuotasClp(billingMonth),
      is_open_month: false,
      is_provisional_close: false,
      close_date_source: "statement",
      provisional_estimate_total: null,
    });
  }
  // A provisional month with no bucket lines still closed at the bank.
  for (const billingMonth of provisionalMonths) {
    if (byMonth.has(billingMonth)) continue;
    out.push(
      provisionalFacturacionRow(
        accountId,
        billingMonth,
        cuotaAPagarNextMesClp(billingMonth, ledgerMonths),
        deudaEnCuotasClp(billingMonth)
      )
    );
  }
  // The open facturación exists from the day the bank closes the previous one, lines or not: the
  // bucket is created only when a line lands in it (`repairMisplacedOpenWebPasteBuckets`), so until
  // then the month has no slot — and the summary card read no «facturación abierta» the morning
  // after a close. The card's billed cuotas are its facturado for now.
  const openBm = frame.openBillingMonth;
  if (openBm && !frame.inactive && !byMonth.has(openBm) && !pdfClosed.has(openBm)) {
    out.push(
      openFacturacionRow(accountId, openBm, cuotaAPagarNextMesClp(openBm, ledgerMonths), deudaEnCuotasClp(openBm), new Map())
    );
  }

  out.sort((a, b) => b.billing_month.localeCompare(a.billing_month));
  return out;
}

/**
 * The open month's facturación row, with or without a bucket. Its figures are the MONTH's, never
 * a slot's: «facturado» is what is billed in THIS cycle — únicos billed so far plus the cuota a
 * pagar (`openMonthFacturadoTotalClp`, the detalle's helper, so both views report the same
 * facturado), the dollar charges billed so far split out as the US$ bar — and both sums read every
 * statement date filed under the month (`statementDatesForFacturacion`: the bucket, a stale bucket's
 * leftovers), so a month with no bucket yet reads 0 únicos. An open month's bucket is keyed by the
 * config close (an identity, see `statementCloseDdMmYyyyForBillingMonth`); what the row shows is
 * the best published close — the previous statement's announced next period — and the pay-by
 * derived from that. `slotForeign` is the bucket's own header derivation per foreign currency, kept when the
 * open cycle has no line in that currency (the slot path's rule); empty without a bucket. A
 * foreign side of the open cycle is never «—»: a cycle that has billed nothing in a currency so
 * far has billed 0 of it (a null amount means a closed month with no statement in it), so both
 * of its fields read 0 until a line lands.
 */
function openFacturacionRow(
  accountId: number,
  billingMonth: string,
  cuotaAPagarClp: number,
  deudaEnCuotasClp: number | null,
  slotForeign: ReadonlyMap<string, { amount: number; clp: number }>
): CcFacturacionRow {
  const cuotaAPagar = cuotaAPagarClp > 0 ? cuotaAPagarClp : null;
  const facturadoTotal = openMonthFacturadoTotalClp(accountId, billingMonth, cuotaAPagar ?? 0, REAL_DEBT_FRAME_RATES);
  // What the open cycle bills per foreign currency: its lines in that currency (manually-entered
  // purchases too), split out of the total so each shows as its own stacked bar instead of being
  // lumped into facturado_clp; a currency no line has landed in yet bills 0 (or the bucket's own
  // header derivation in that currency — the slot path's rule).
  const lines = openCycleForeignFacturado(accountId, billingMonth, REAL_DEBT_FRAME_RATES);
  // Every currency counts in the split, the card's or not (a foreign bucket's own header too).
  const billed = new Map(
    [...new Set([...slotForeign.keys(), ...cardForeignCurrencies(accountId), ...lines.keys()])].map(
      (c): [string, { amount: number; clp: number }] => [c, lines.get(c) ?? slotForeign.get(c) ?? { amount: 0, clp: 0 }]
    )
  );
  let foreignClp = 0;
  for (const v of billed.values()) foreignClp += v.clp;
  const close = closeDateForBillingMonth(accountId, billingMonth);
  const payByIso = derivedPayByIso(close.close_iso, ccDerivedPayByRuleForAccount(accountId));
  return {
    billing_month: billingMonth,
    close_date: close.close_ddmmyyyy,
    close_date_iso: close.close_iso,
    pay_by: payByIso ? ddMmYyyyFromIso(payByIso) : null,
    pay_by_iso: payByIso,
    pay_by_source: payByIso ? "derived" : null,
    facturado: facturadoTotal - foreignClp,
    facturado_foreign: facturadoForeignEntries(accountId, billed),
    facturado_total: facturadoTotal,
    cuota_a_pagar: cuotaAPagar,
    deuda_en_cuotas: deudaEnCuotasClp,
    is_open_month: true,
    is_provisional_close: false,
    close_date_source: close.source,
    provisional_estimate_total: null,
  };
}

function provisionalFacturacionRow(
  accountId: number,
  billingMonth: string,
  cuotaAPagarClp: number,
  deudaEnCuotasClp: number | null
): CcFacturacionRow {
  const pv = provisionalFacturado(accountId, billingMonth, cuotaAPagarClp, REAL_DEBT_FRAME_RATES);
  return {
    billing_month: billingMonth,
    close_date: pv.close_ddmmyyyy,
    close_date_iso: pv.close_iso,
    pay_by: pv.pay_by_iso ? ddMmYyyyFromIso(pv.pay_by_iso) : null,
    pay_by_iso: pv.pay_by_iso,
    pay_by_source: pv.pay_by_iso ? "derived" : null,
    facturado: pv.facturado_clp,
    facturado_foreign: facturadoForeignEntries(accountId, pv.foreign),
    facturado_total: pv.total_clp,
    cuota_a_pagar: cuotaAPagarClp > 0 ? cuotaAPagarClp : null,
    deuda_en_cuotas: deudaEnCuotasClp,
    is_open_month: false,
    is_provisional_close: true,
    close_date_source: pv.close_source,
    provisional_estimate_total: pv.source === "feed" ? pv.estimate_total_clp : null,
  };
}
