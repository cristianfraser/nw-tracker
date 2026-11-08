/**
 * The card purchases module, read side (docs/untangle-plan.md F10, the views of
 * `docs/untangle-audit-line-readers.md`). A card purchase is one of: a plain one-shot line, a line
 * with a plan overlay (the line the plan was bought with, which the plan supersedes), or a plan
 * with no line (a statement-owned plan, or a plan whose line is gone). The rule «a line that has a
 * plan counts once» lives here only: {@link supersededOneShotLineIds} is what every reader that
 * sums one-shot lines leaves out, and {@link oneShotLinesSupersededByPlans} what the write side
 * removes when it settles a line into its plan.
 *
 * Views delivered so far: the plans matched against lines ({@link listPlansForLineMatching}), the
 * one-shot lines ({@link listOneShotLinesForAccount}), the plan ↔ line identity
 * ({@link planMatchesOneShotLine}, {@link findPlanForOneShotLine}, {@link findOneShotLinesOfPlan})
 * and the superseded set. The rest of the views (debt events, open-cycle and billed lines, expense
 * lines, payment evidence, `findLines`) still live in their readers; the guard test
 * (`purchasesRawTableGuard.test.ts`) lists them.
 *
 * Import rule: this module imports only leaf modules (no card ledger, no expense pipeline), so the
 * card domain can depend on it without growing the import cycle.
 */
import { db } from "../db.js";
import { effectiveCcExpenseLineAmountClp } from "../ccExpenseAmountClp.js";
import {
  isInstallmentContractSummaryMerchant,
  merchantStemForInstallmentDedupe,
} from "../ccInstallmentLineDedupe.js";
import { amountIsPrincipalOrOneCuota, installmentMerchantStemsMatch } from "../matching/installmentAmount.js";
import { addCalendarMonths, normalizeMerchantText, parseDdMmYyToIso, parseYearMonth, stripBciTerminalSuffix } from "nw-tracker-contracts";
import { paymentStatementMonthYm } from "./statementMonth.js";
import { billingMonthContainingPurchase, lastPdfBillingMonthForAccount } from "./facturacion.js";

/** A plan as the line matchers read it (`cc_installment_purchases`). */
export type CardPlanForMatching = {
  id: number;
  purchase_date: string;
  total_amount_clp: number;
  cuotas_totales: number;
  merchant: string | null;
  twin_index: number;
};

/** A one-shot statement line (`installment_flag = 0`) with a positive peso amount. */
export type CardOneShotLine = {
  statement_line_id: number;
  merchant: string | null;
  transaction_date: string | null;
  posting_date: string | null;
  amount_clp: number;
  purchase_date_iso: string | null;
};

// ---------------------------------------------------------------------------------------------
// Plan identity
// ---------------------------------------------------------------------------------------------

/**
 * A plan's identity fingerprint: purchase date, total, count, merchant stem and twin index. Twin
 * purchases (identical, same day, each in cuotas) differ only in `twin_index` (migration 187).
 */
export function installmentPurchaseLedgerDedupeKey(pr: {
  purchase_date: string;
  total_amount_clp: number;
  cuotas_totales: number;
  merchant: string | null;
  twin_index: number;
}): string {
  return [
    pr.purchase_date,
    String(pr.total_amount_clp),
    String(pr.cuotas_totales),
    merchantStemForInstallmentDedupe(pr.merchant),
    String(pr.twin_index),
  ].join("\t");
}

/**
 * One plan per identity fingerprint: a contract-summary row («03 CUOTAS COMERC») gives way to the
 * plan of the same purchase under its real merchant; between two of the same standing the newer
 * id stays.
 */
export function dedupeInstallmentPurchaseLedgerRows<
  T extends {
    id: number;
    purchase_date: string;
    total_amount_clp: number;
    cuotas_totales: number;
    merchant: string | null;
    twin_index: number;
  },
>(purchases: readonly T[]): T[] {
  const byKey = new Map<string, T>();
  for (const pr of purchases) {
    const key = installmentPurchaseLedgerDedupeKey(pr);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, pr);
      continue;
    }
    const prevSummary = isInstallmentContractSummaryMerchant(prev.merchant);
    const curSummary = isInstallmentContractSummaryMerchant(pr.merchant);
    if (prevSummary && !curSummary) {
      byKey.set(key, pr);
      continue;
    }
    if (!prevSummary && curSummary) continue;
    if (pr.id > prev.id) byKey.set(key, pr);
  }
  return [...byKey.values()];
}

/** The account's plans, one per identity, as the line matchers read them. */
export function listPlansForLineMatching(accountId: number): CardPlanForMatching[] {
  const rows = db
    .prepare(
      `SELECT id, purchase_date, total_amount_clp, cuotas_totales, merchant, twin_index
       FROM cc_installment_purchases WHERE account_id = ?`
    )
    .all(accountId) as CardPlanForMatching[];
  return dedupeInstallmentPurchaseLedgerRows(rows);
}

// ---------------------------------------------------------------------------------------------
// Merchant identity across sources
// ---------------------------------------------------------------------------------------------

/**
 * Strip BCI Lider merchant suffixes before cross-source comparison: the statement appends « (T)»
 * («ENTEL HOGAR (T)»), the web table «,CITY» («ENTEL HOGAR,SANTIAGO»). Applied to every card's
 * merchants, as it always was (a Santander paste merchant ends «, SANTIAGO» too).
 */
function normalizeBciMerchantForDedupe(merchant: string | null | undefined): string {
  return stripBciTerminalSuffix(normalizeMerchantText(merchant))
    .replace(/,\s*[A-ZÁÉÍÓÚÑ ]+$/i, "")
    .trim();
}

/** Web-paste «EXPRESS PLAZA L» vs PDF «RECAUDACION EX PLAZA LYON» (same Lyon parking charge). */
export function plazaLyonMerchantsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const ua = normalizeMerchantText(a);
  const ub = normalizeMerchantText(b);
  if (!ua || !ub) return false;
  const plazaA = ua.includes("PLAZA") && (ua.includes("LYON") || ua.endsWith("PLAZA L"));
  const plazaB = ub.includes("PLAZA") && (ub.includes("LYON") || ub.endsWith("PLAZA L"));
  if (!plazaA || !plazaB) return false;
  return ua.includes("RECAUDACION") || ub.includes("RECAUDACION") || ua.includes("EXPRESS") || ub.includes("EXPRESS");
}

/** Whether two sources' merchants name the same purchase (exact, the Lyon alias, BCI suffixes, stems). */
export function merchantsMatchForCrossDedupe(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeMerchantText(a);
  const nb = normalizeMerchantText(b);
  if (na && nb && na === nb) return true;
  if (plazaLyonMerchantsMatch(a, b)) return true;
  const ba = normalizeBciMerchantForDedupe(a);
  const bb = normalizeBciMerchantForDedupe(b);
  if (ba && bb && ba === bb) return true;
  return installmentMerchantStemsMatch(a, b);
}

// ---------------------------------------------------------------------------------------------
// Plan ↔ one-shot line
// ---------------------------------------------------------------------------------------------

/** A line's purchase day: its transaction date, else its posting date (dd/mm/yyyy → ISO). */
export function purchaseDateIsoFromLine(transaction_date: string | null, posting_date: string | null): string | null {
  return parseDdMmYyToIso(transaction_date ?? "") ?? parseDdMmYyToIso(posting_date ?? "");
}

/**
 * A one-shot line represents a plan's purchase when its amount is the full principal or a single
 * cuota (the bank lists the purchase at its total, then re-lists the cuota that will post), the
 * merchants match and, when the line has a date, it is the plan's purchase date.
 */
export function planMatchesOneShotLine(
  plan: CardPlanForMatching,
  merchant: string | null,
  purchaseDateIso: string | null,
  amountClp: number
): boolean {
  if (!amountIsPrincipalOrOneCuota(plan.total_amount_clp, plan.cuotas_totales, amountClp)) return false;
  if (!merchantsMatchForCrossDedupe(plan.merchant, merchant)) return false;
  if (purchaseDateIso && plan.purchase_date !== purchaseDateIso) return false;
  return true;
}

/** The account's plan a one-shot line of these facts belongs to, if any. */
export function findPlanForOneShotLine(
  accountId: number,
  merchant: string | null,
  purchaseDateIso: string | null,
  amountClp: number
): CardPlanForMatching | null {
  const abs = Math.abs(Math.trunc(amountClp));
  if (abs <= 0) return null;
  for (const p of listPlansForLineMatching(accountId)) {
    if (planMatchesOneShotLine(p, merchant, purchaseDateIso, abs)) return p;
  }
  return null;
}

/**
 * Read-scope memo for the account-level line scan and the superseded set. Only active inside
 * {@link withCcOneShotScanCache} (synchronous read-only builds like detalle por mes, which ask once
 * per billing month). Import and write flows never enter the scope, so their decisions re-read.
 */
let oneShotScanCache: {
  lines: Map<number, CardOneShotLine[]>;
  superseded: Map<number, Set<number>>;
} | null = null;

export function withCcOneShotScanCache<T>(fn: () => T): T {
  if (oneShotScanCache) return fn();
  oneShotScanCache = { lines: new Map(), superseded: new Map() };
  try {
    return fn();
  } finally {
    oneShotScanCache = null;
  }
}

/** The account's one-shot lines with a positive peso amount (dollars at the statement day's rate). */
export function listOneShotLinesForAccount(accountId: number): CardOneShotLine[] {
  const cached = oneShotScanCache?.lines.get(accountId);
  if (cached) return cached;
  const out = listOneShotLinesForAccountUncached(accountId);
  oneShotScanCache?.lines.set(accountId, out);
  return out;
}

function listOneShotLinesForAccountUncached(accountId: number): CardOneShotLine[] {
  const rows = db
    .prepare(
      `SELECT l.id AS statement_line_id, l.merchant, l.transaction_date, l.posting_date,
              l.amount_clp, l.amount_usd, s.statement_date, s.currency AS statement_currency
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ? AND l.installment_flag = 0`
    )
    .all(accountId) as {
    statement_line_id: number;
    merchant: string | null;
    transaction_date: string | null;
    posting_date: string | null;
    amount_clp: number | null;
    amount_usd: number | null;
    statement_date: string;
    statement_currency: string;
  }[];

  const out: CardOneShotLine[] = [];
  for (const r of rows) {
    const amount = effectiveCcExpenseLineAmountClp(
      {
        installment_flag: 0,
        amount_clp: r.amount_clp,
        amount_usd: r.amount_usd,
        valor_cuota_mensual_clp: null,
        valor_cuota_mensual_usd: null,
        statement_currency: r.statement_currency,
      },
      parseDdMmYyToIso(r.statement_date)
    );
    if (amount == null || amount <= 0) continue;
    out.push({
      statement_line_id: r.statement_line_id,
      merchant: r.merchant,
      transaction_date: r.transaction_date,
      posting_date: r.posting_date,
      amount_clp: amount,
      purchase_date_iso: purchaseDateIsoFromLine(r.transaction_date, r.posting_date),
    });
  }
  return out;
}

/** The one-shot lines of a plan's purchase on its account. */
export function findOneShotLinesOfPlan(accountId: number, plan: CardPlanForMatching): number[] {
  const ids: number[] = [];
  for (const line of listOneShotLinesForAccount(accountId)) {
    if (planMatchesOneShotLine(plan, line.merchant, line.purchase_date_iso, line.amount_clp)) {
      ids.push(line.statement_line_id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------------------------
// «A line that has a plan counts once»
// ---------------------------------------------------------------------------------------------

/** Each one-shot line a plan supersedes, with that plan (the first one that matches). */
export function oneShotLinesSupersededByPlans(accountId: number): Map<number, CardPlanForMatching> {
  const superseded = new Map<number, CardPlanForMatching>();
  const plans = listPlansForLineMatching(accountId);
  if (plans.length === 0) return superseded;
  for (const line of listOneShotLinesForAccount(accountId)) {
    for (const p of plans) {
      if (planMatchesOneShotLine(p, line.merchant, line.purchase_date_iso, line.amount_clp)) {
        superseded.set(line.statement_line_id, p);
        break;
      }
    }
  }
  return superseded;
}

/** The one-shot lines a reader that sums lines leaves out: their plan counts the purchase. */
export function supersededOneShotLineIds(accountId: number): Set<number> {
  const cached = oneShotScanCache?.superseded.get(accountId);
  if (cached) return cached;
  const out = new Set(oneShotLinesSupersededByPlans(accountId).keys());
  oneShotScanCache?.superseded.set(accountId, out);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Plan schedule anchor
// ---------------------------------------------------------------------------------------------

/** What the first-cuota rule reads of a plan. */
export type PlanFirstDueInput = {
  id: number;
  purchase_date: string;
  merchant: string | null;
  source: string;
  /** Evidence-backed first-cuota month (YYYY-MM); NULL = derive it (migration 163). */
  first_due_month: string | null;
};

/** What the first-cuota rule reads of a plan's payment rows. */
export type PlanPaymentMonthInput = {
  pay_by_date: string;
  statement_date: string | null;
  statement_period_month: string | null;
  period_to_join: string | null;
  amount_clp: number;
  cuota_current: number | null;
};

function ymCompare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

const paymentBillingMonth = (p: PlanPaymentMonthInput): string | null => paymentStatementMonthYm(p);

/**
 * A plan's first-cuota month (YYYY-MM), the anchor of its whole schedule: the month of its printed
 * cuota 1 (else the lowest printed cuota), else the statement after its last 00/N preamble, else —
 * for a manual plan — the stored pin or the purchase's own cycle, advanced past every facturación
 * already closed without billing it, else the stored pin, else the purchase month. A plan with
 * none of these (no readable purchase date) throws, naming the plan; it used to read «1970-01».
 */
export function purchaseFirstDueYm(
  pr: PlanFirstDueInput,
  payList: readonly PlanPaymentMonthInput[],
  accountId?: number
): string {
  const cuota1 = payList.find((p) => p.cuota_current === 1);
  if (cuota1) {
    const ym = paymentBillingMonth(cuota1);
    if (ym) return ym;
  }
  const withCuota = payList
    .filter((p) => p.cuota_current != null && p.cuota_current > 0)
    .sort((a, b) => a.cuota_current! - b.cuota_current!);
  if (withCuota.length > 0) {
    const ym = paymentBillingMonth(withCuota[0]!);
    if (ym) return ym;
  }

  const preambleOnly = payList.filter(
    (p) => p.amount_clp > 0 && (p.cuota_current == null || p.cuota_current <= 0)
  );
  if (withCuota.length === 0 && preambleOnly.length > 0) {
    // Cuota 1 bills the statement after the latest 00/N preamble, so the anchor is the
    // preamble's STATEMENT month + 1. Anchoring on the pay-by month (already the next
    // calendar month) pushed these plans one facturación late in every schedule consumer
    // until real cuota-01 evidence arrived and silently shifted them back.
    let lastStmtYm: string | null = null;
    for (const p of preambleOnly) {
      const ym = paymentBillingMonth(p);
      if (ym && (lastStmtYm == null || ymCompare(ym, lastStmtYm) > 0)) lastStmtYm = ym;
    }
    if (lastStmtYm) return addCalendarMonths(lastStmtYm, 1);
  }

  // Evidence-backed first-cuota month (set by the web-paste importer when a pasted
  // no-facturado line pins a manual plan's real first cycle). Ranks below any statement
  // cuota evidence above, so a later PDF cuota-01 line always overrides it — but above the
  // manual same-cycle guess below, which is only a heuristic for the yet-unbilled case.
  const storedFirstDue = parseYearMonth(String(pr.first_due_month ?? "").slice(0, 7));

  if (pr.source === "manual" && accountId != null) {
    // Default guess: the first cuota bills at the close of the facturación the purchase
    // falls into (Lider always bills cuota 1 same-cycle; Santander usually does, sometimes
    // deferring it behind a cuota-00 preamble). The next statement's evidence replaces the
    // guess either way: a cuota-01 line pins the real month, a cuota-00 preamble moves the
    // anchor to statement + 1. Date-based (not "the open month at read time") so the guess
    // does not drift forward as cycles roll while the statement is pending. The cycle is the
    // bank's (`billingMonthContainingPurchase`): a ·0901 purchase on the 22nd belongs to the
    // facturación that closes on the 24th, not to the next one as the config's 20th made it.
    const base = storedFirstDue ?? billingMonthContainingPurchase(accountId, pr.purchase_date);
    if (base) {
      // A manual plan with no statement evidence cannot first-bill inside an already
      // fully-imported facturación — that statement exists and did not bill it (reaching
      // this branch means no cuota line matched). Advance to the first month whose
      // statement is still pending. Statement-driven (last closed + 1, never the calendar),
      // so a lagging import queue keeps the date-based guess and nothing drifts; with
      // statements current this is the open month, and each later close without evidence
      // rolls the leftover forward with it.
      const lastClosed = lastPdfBillingMonthForAccount(accountId);
      const firstPending = lastClosed ? addCalendarMonths(lastClosed, 1) : null;
      return firstPending && ymCompare(firstPending, base) > 0 ? firstPending : base;
    }
  }
  if (storedFirstDue) return storedFirstDue;
  const purchaseMonth = parseYearMonth(pr.purchase_date.slice(0, 7));
  if (!purchaseMonth) {
    throw new Error(
      `Plan ${pr.id} (${pr.merchant ?? "?"}): no first cuota month — no printed cuota, no stored first month and an unreadable purchase date ${JSON.stringify(pr.purchase_date)}`
    );
  }
  return purchaseMonth;
}

