/**
 * The card purchases module, read side (docs/untangle-plan.md F10, the views of
 * `docs/untangle-audit-line-readers.md`). A card purchase is one of: a plain one-shot line, a line
 * with a plan overlay (the line the plan was bought with, which the plan supersedes), or a plan
 * with no line (a statement-owned plan, or a plan whose line is gone). The rule «a line that has a
 * plan counts once» lives here only: {@link supersededOneShotLineIds} is what every reader that
 * sums one-shot lines leaves out, and {@link oneShotLinesSupersededByPlans} what the write side
 * removes when it settles a line into its plan.
 *
 * Views (the audit's numbering): 1 debt events ({@link debtEventLines}, {@link planPurchaseEvents}),
 * 2 billed and open-cycle lines ({@link billedOneShotLines}, {@link linesOfClose},
 * {@link linesOfStatement}, {@link openCycleCuotaPurchaseLines}), 3 expense evidence
 * ({@link expenseEvidenceLines}), 4 plans ({@link planRows}, {@link ledgerPlans},
 * {@link ledgerPlanCuotas}, {@link planPrintedCuotaLines}, {@link lineForPayment} — the plan ↔ line
 * join on `parser_row_id` stays inside), 5 payment evidence ({@link clpPaymentLines},
 * {@link usdDebtAbonoLines}, {@link traspasoUsdLegs}), 6 is a filter on 1 and 3 by kind, 7 the
 * search the matchers of other domains run ({@link findLines}). {@link effectivePurchases} returns
 * each purchase once. Readers that own rows (writers, import identity, re-key movers) still read the
 * tables; the guard test (`purchasesRawTableGuard.test.ts`) lists them.
 *
 * Import rule: this module imports only leaf modules (no card ledger, no expense pipeline), so the
 * card domain can depend on it without growing the import cycle.
 */
import type { Database } from "better-sqlite3";
import type { CcCuotaPurchaseKind } from "../ccCuotaPurchaseKinds.js";
import { db } from "../db.js";
import { effectiveCcExpenseLineAmountClp } from "../ccExpenseAmountClp.js";
import {
  isInstallmentContractSummaryMerchant,
  merchantStemForInstallmentDedupe,
} from "../ccInstallmentLineDedupe.js";
import { isCcPaymentMerchant } from "../ccPaymentLines.js";
import { statementLineDateIso } from "../ccInstallmentPayBy.js";
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


// =============================================================================================
// The views (docs/untangle-audit-line-readers.md «Views the module must offer»). Each returns
// flow-shaped rows plus the ids a reader links by; the domain math (fx, facturación, pairing)
// stays with the reader. Queries keep the shape and order their readers relied on.
// =============================================================================================

/** A statement line with its statement's context, as the views return it. */
export type CardLine = {
  line_id: number;
  statement_id: number;
  account_id: number;
  /** The statement's close (dd/mm/yyyy) — a statement, an open bucket or an older paste. */
  statement_date: string;
  statement_currency: string;
  source_pdf: string;
  source_kind: string;
  merchant: string | null;
  transaction_date: string | null;
  posting_date: string | null;
  amount_clp: number | null;
  amount_usd: number | null;
  amount_orig: number | null;
  orig_currency: string | null;
  installment_flag: number;
  nro_cuota_current: number | null;
  nro_cuota_total: number | null;
  valor_cuota_mensual_clp: number | null;
  valor_cuota_mensual_usd: number | null;
  cuota_purchase_kind: string | null;
  /** The stored line kind (`cards/lineKinds.ts`, migration 276). */
  kind: string | null;
  origin_card_last4: string | null;
  dedupe_key: string | null;
  parser_row_id: string | null;
  raw_line: string | null;
};

const CARD_LINE_COLUMNS = `l.id AS line_id, s.id AS statement_id, s.account_id, s.statement_date,
  s.currency AS statement_currency, s.source_pdf, s.source_kind, l.merchant, l.transaction_date,
  l.posting_date, l.amount_clp, l.amount_usd, l.amount_orig, l.orig_currency, l.installment_flag,
  l.nro_cuota_current, l.nro_cuota_total, l.valor_cuota_mensual_clp, l.valor_cuota_mensual_usd,
  l.cuota_purchase_kind, l.kind, l.origin_card_last4, l.dedupe_key, l.parser_row_id, l.raw_line`;

// ---------------------------------------------------------------------------------------------
// View 7 — the merchant / amount search for the matchers of other domains
// ---------------------------------------------------------------------------------------------

/** What {@link findLines} filters on; every field narrows, none set means every line. */
export type FindLinesQuery = {
  accountId?: number;
  /** Exact stored peso amount. */
  amountClp?: number;
  /** Sign of the stored peso amount: `positive` > 0, `negative` < 0, `present` not null. */
  amountClpSign?: "positive" | "negative" | "present";
  installmentFlag?: 0 | 1;
  /** Lines carrying a feed cuota-purchase tag (`cuota_purchase_kind`). */
  cuotaPurchaseTagged?: true;
  /** `UPPER(merchant) LIKE <prefix>%`, any of them. */
  merchantPrefixes?: readonly string[];
  /** A caller's SQL prefilter over the merchant column (e.g. the lender patterns); a superset. */
  merchantSql?: (column: string) => { sql: string; params: readonly (string | number)[] };
  /** Leave these lines out. */
  excludeLineIds?: ReadonlySet<number>;
  /**
   * `statement`: by statement, then line (the default with `accountId` — one card's lines as its
   * statements list them); `line`: by line id (the default otherwise); `newest_statement`: newest
   * statement first, then newest line.
   */
  order?: "statement" | "line" | "newest_statement";
  limit?: number;
};

/**
 * Card lines by merchant, amount and card: the search the receipt, mortgage, grocery, App Store and
 * tax matchers run, each pairing the result by its own rule. Read-only; rows come with their
 * statement and account so a match can link back by `line_id`.
 */
export function findLines(q: FindLinesQuery = {}): CardLine[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.accountId != null) {
    where.push("s.account_id = ?");
    params.push(q.accountId);
  }
  if (q.amountClp != null) {
    where.push("l.amount_clp = ?");
    params.push(q.amountClp);
  }
  if (q.amountClpSign === "positive") where.push("l.amount_clp > 0");
  if (q.amountClpSign === "negative") where.push("l.amount_clp < 0");
  if (q.amountClpSign === "present") where.push("l.amount_clp IS NOT NULL");
  if (q.installmentFlag != null) {
    where.push("l.installment_flag = ?");
    params.push(q.installmentFlag);
  }
  if (q.cuotaPurchaseTagged) where.push("l.cuota_purchase_kind IS NOT NULL");
  if (q.merchantPrefixes && q.merchantPrefixes.length > 0) {
    where.push(`(${q.merchantPrefixes.map(() => "upper(l.merchant) LIKE ?").join(" OR ")})`);
    params.push(...q.merchantPrefixes.map((p) => `${p.toUpperCase()}%`));
  }
  if (q.merchantSql) {
    const pre = q.merchantSql("l.merchant");
    where.push(`l.merchant IS NOT NULL AND ${pre.sql}`);
    params.push(...pre.params);
  }
  const order = { statement: "s.id, l.id", line: "l.id", newest_statement: "s.id DESC, l.id DESC" }[
    q.order ?? (q.accountId != null ? "statement" : "line")
  ];
  const rows = db
    .prepare(
      `SELECT ${CARD_LINE_COLUMNS}
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY ${order}`
    )
    .all(...params) as CardLine[];
  const kept = q.excludeLineIds ? rows.filter((r) => !q.excludeLineIds!.has(r.line_id)) : rows;
  return q.limit != null ? kept.slice(0, q.limit) : kept;
}

/** The card account a statement line sits on; throws for an unknown line. */
export function accountIdForLine(lineId: number): number {
  const row = db
    .prepare(`SELECT s.account_id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE l.id = ?`)
    .get(lineId) as { account_id: number } | undefined;
  if (!row) throw new Error(`card line ${lineId} not found`);
  return row.account_id;
}

/**
 * The additional plastics (of `last4s`) the account's latest real statement prints as line origins
 * (bank listings are not statements). Several share the latest close when the statement lists
 * more than one; none when no statement printed one.
 */
export function latestStatementOriginPlastics(
  accountId: number,
  last4s: readonly string[],
  dbHandle: Database = db
): string[] {
  const rows = dbHandle
    .prepare(
      `WITH dated AS (
         SELECT l.origin_card_last4 AS origin,
                substr(s.statement_date, 7, 4) || '-' || substr(s.statement_date, 4, 2) || '-' ||
                  substr(s.statement_date, 1, 2) AS close_iso
         FROM cc_statement_lines l
         JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ?
           AND s.source_kind NOT IN ('listing_open', 'listing_other')
           AND l.origin_card_last4 IN (SELECT value FROM json_each(?))
       )
       SELECT DISTINCT origin FROM dated WHERE close_iso = (SELECT MAX(close_iso) FROM dated)`
    )
    .all(accountId, JSON.stringify(last4s)) as { origin: string }[];
  return rows.map((r) => r.origin);
}

// ---------------------------------------------------------------------------------------------
// View 5 — payment evidence
// ---------------------------------------------------------------------------------------------

/** A card line that pays the card, with the statement it sits on (pairing links by `line_id`). */
export type CardPaymentLine = {
  line_id: number;
  statement_id: number;
  source_pdf: string;
  account_id: number;
  account_name: string;
  transaction_date: string | null;
  merchant: string | null;
  /** Signed as stored: negative (a payment lowers what is owed); pesos or dollars per the view. */
  amount: number;
};

const stmtClpPaymentLines = db.prepare(
  `SELECT l.id AS line_id, s.id AS statement_id, s.source_pdf, s.account_id, a.name AS account_name,
          l.transaction_date, l.amount_clp AS amount, l.merchant
   FROM cc_statement_lines l
   JOIN cc_statements s ON s.id = l.statement_id
   JOIN accounts a ON a.id = s.account_id
   WHERE s.currency = 'clp' AND l.installment_flag = 0 AND l.amount_clp < 0
     AND (@account_id IS NULL OR s.account_id = @account_id)`
);

/**
 * The peso payment lines of one card or of all of them: one-shot credits on peso statements (the
 * open bucket included) that name a payment (`isCcPaymentMerchant`: PAGO, MONTO CANCELADO, ABONO).
 * The cuota retirement and the payment-mirror evidence read the same list.
 */
export function clpPaymentLines(accountId?: number): CardPaymentLine[] {
  return (stmtClpPaymentLines.all({ account_id: accountId ?? null }) as CardPaymentLine[]).filter((r) =>
    isCcPaymentMerchant(r.merchant)
  );
}

// Matched by the LINE's currency (amount_usd set), not the statement's — the open web-paste bucket
// is a CLP statement that carries the USD lines too, and an abono must be pairable the day the feed
// delivers it. Traspaso-linked abonos are not payments: they reclassify USD debt onto the CLP side
// of the same card, no cash moved.
const stmtUsdAbonoLines = db.prepare(
  `SELECT l.id AS line_id, s.id AS statement_id, s.source_pdf, s.account_id, a.name AS account_name,
          l.transaction_date, l.amount_usd AS amount, l.merchant
   FROM cc_statement_lines l
   JOIN cc_statements s ON s.id = l.statement_id
   JOIN accounts a ON a.id = s.account_id
   WHERE l.installment_flag = 0 AND l.amount_usd < 0
     AND UPPER(l.merchant) LIKE '%ABONO DE DIVISAS%'
     AND l.id NOT IN (SELECT usd_line_id FROM cc_traspaso_deuda_links)
     AND (@account_id IS NULL OR s.account_id = @account_id)`
);

/** The ABONO DE DIVISAS lines (dollar debt paid with bought dollars), traspaso legs left out. */
export function usdDebtAbonoLines(accountId?: number): CardPaymentLine[] {
  return stmtUsdAbonoLines.all({ account_id: accountId ?? null }) as CardPaymentLine[];
}

const stmtTraspasoUsdLegs = db.prepare(
  `SELECT t.id AS link_id, l.transaction_date, t.amount_clp AS clp, t.amount_usd AS usd
   FROM cc_traspaso_deuda_links t
   INNER JOIN cc_statement_lines l ON l.id = t.usd_line_id
   WHERE t.account_id = ?`
);

/** Each traspaso de deuda of the card: the dollar leg's date and the pesos the bank moved it at. */
export function traspasoUsdLegs(
  accountId: number
): { link_id: number; transaction_date: string | null; clp: number; usd: number }[] {
  return stmtTraspasoUsdLegs.all(accountId) as { link_id: number; transaction_date: string | null; clp: number; usd: number }[];
}

// ---------------------------------------------------------------------------------------------
// View 4 — plan rows (the schedule itself is `ccInstallmentLedgerDb`'s, on the plan ↔ line join)
// ---------------------------------------------------------------------------------------------

/** A plan as stored (`cc_installment_purchases`). */
export type CardPlanRow = {
  id: number;
  account_id: number;
  canonical_row_id: string;
  purchase_date: string;
  total_amount_clp: number;
  cuotas_totales: number;
  merchant: string | null;
  twin_index: number;
  source: string;
  first_due_month: string | null;
};

const PLAN_COLUMNS = `id, account_id, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales,
  merchant, twin_index, source, first_due_month`;

/** The plans of these cards (by card, then id), or of every card (by id). */
export function planRows(accountIds?: readonly number[]): CardPlanRow[] {
  if (accountIds == null) {
    return db.prepare(`SELECT ${PLAN_COLUMNS} FROM cc_installment_purchases ORDER BY id`).all() as CardPlanRow[];
  }
  if (accountIds.length === 0) return [];
  return db
    .prepare(
      `SELECT ${PLAN_COLUMNS} FROM cc_installment_purchases
       WHERE account_id IN (${accountIds.map(() => "?").join(",")}) ORDER BY account_id, id`
    )
    .all(...accountIds) as CardPlanRow[];
}

/** One plan by id; throws when it does not exist. */
export function planRow(planId: number): CardPlanRow {
  const row = db.prepare(`SELECT ${PLAN_COLUMNS} FROM cc_installment_purchases WHERE id = ?`).get(planId) as
    | CardPlanRow
    | undefined;
  if (!row) throw new Error(`cc_installment_purchases ${planId} not found`);
  return row;
}

/** A plan's stored cuota (`cc_installment_payments`) with the plan it belongs to. */
export type CardPlanCuota = {
  payment_id: number;
  account_id: number;
  pay_by_date: string;
  statement_date: string | null;
  statement_period_month: string | null;
  amount_clp: number;
  cuota_current: number | null;
  cuota_total: number | null;
  purchase_date: string;
  merchant: string | null;
  total_amount_clp: number;
};

/** The billed cuotas (positive amount) of these cards' plans, by pay-by then id. */
export function planCuotas(accountIds: readonly number[]): CardPlanCuota[] {
  if (accountIds.length === 0) return [];
  return db
    .prepare(
      `SELECT p.id AS payment_id, pr.account_id, p.pay_by_date, p.statement_date, p.statement_period_month,
              p.amount_clp, p.cuota_current, p.cuota_total,
              pr.purchase_date, pr.merchant, pr.total_amount_clp
       FROM cc_installment_payments p
       JOIN cc_installment_purchases pr ON pr.id = p.purchase_id
       WHERE pr.account_id IN (${accountIds.map(() => "?").join(",")})
         AND p.amount_clp > 0
       ORDER BY p.pay_by_date, p.id`
    )
    .all(...accountIds) as CardPlanCuota[];
}

/**
 * The statement line behind a stored cuota: the one the parser read it from (`parser_row_id`).
 * on the plan's card. Copies of one statement share the parser's row id; the lowest line id is returned. Null for a
 * cuota no line carries (a manual plan's synthetic row, a line re-imported under another id).
 */
export function lineForPayment(paymentId: number): CardLine | null {
  return (
    (db
      .prepare(
        `SELECT ${CARD_LINE_COLUMNS}
         FROM cc_installment_payments p
         JOIN cc_installment_purchases pr ON pr.id = p.purchase_id
         JOIN cc_statement_lines l ON l.parser_row_id IS NOT NULL AND l.parser_row_id != ''
           AND l.parser_row_id = p.parser_row_id
         JOIN cc_statements s ON s.id = l.statement_id AND s.account_id = pr.account_id
         WHERE p.id = ?
         ORDER BY l.id
         LIMIT 1`
      )
      .get(paymentId) as CardLine | undefined) ?? null
  );
}

// ---------------------------------------------------------------------------------------------
// View 1 — debt events (the lines and plans the owed walk, the anchors and the financing cost read)
// ---------------------------------------------------------------------------------------------

/** A one-shot line as a debt event: its stored amounts, statement context and the day it counts. */
export type DebtEventLine = {
  id: number;
  merchant: string | null;
  amount_clp: number | null;
  amount_usd: number | null;
  statement_currency: string;
  installment_flag: number;
  valor_cuota_mensual_clp: number | null;
  valor_cuota_mensual_usd: number | null;
  transaction_date: string | null;
  posting_date: string | null;
  statement_date: string;
  dedupe_key: string | null;
  /** The day the line moves the debt (ISO): its date, or its statement's close when backdated. */
  iso: string;
};

/** Two calendar months before a close: a line dated on or before it, billed at that close, is backdated. */
function backdatedPostingCutoffIso(closeIso: string): string {
  const ym = addCalendarMonths(closeIso.slice(0, 7), -2);
  const lastDay = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
  return `${ym}-${String(Math.min(Number(closeIso.slice(8, 10)), lastDay)).padStart(2, "0")}`;
}

/**
 * The card's one-shot lines as debt events, every source (statements and listings): a line its
 * plan supersedes counts once, through the plan (left out here); a contract-summary row
 * («03 CUOTAS COMERC») is no purchase; an undated line has no day. A line dated two cycles or
 * more before the statement that billed it is a backdated posting (a nota de crédito carries the
 * original purchase's date — ·0161's −4xx.xxx dated 22/02/2018 on the June statement): it entered
 * the debt in that statement's cycle, so it counts on that close; dated at the purchase, the walk
 * had counted it months before any anchor did.
 */
export function debtEventLines(accountId: number): DebtEventLine[] {
  const rows = db
    .prepare(
      `SELECT l.id, l.merchant, l.amount_clp, l.amount_usd, s.currency AS statement_currency,
              l.installment_flag, l.valor_cuota_mensual_clp, l.valor_cuota_mensual_usd,
              l.transaction_date, l.posting_date, s.statement_date, l.dedupe_key
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ? AND l.installment_flag = 0`
    )
    .all(accountId) as Omit<DebtEventLine, "iso">[];
  const superseded = supersededOneShotLineIds(accountId);
  const out: DebtEventLine[] = [];
  for (const r of rows) {
    if (superseded.has(r.id)) continue;
    if (isInstallmentContractSummaryMerchant(r.merchant)) continue;
    // Transaction date, else posting date: a line printing only its posting date used to drop out here.
    let iso = statementLineDateIso(r);
    if (!iso) continue;
    const closeIso = parseDdMmYyToIso(r.statement_date);
    if (closeIso && iso <= backdatedPostingCutoffIso(closeIso)) iso = closeIso;
    out.push({ ...r, iso });
  }
  return out;
}

/** The card's plans as debt events: the whole contract on its purchase day (cupo is consumed then). */
export function planPurchaseEvents(accountId: number): { id: number; purchase_date: string; total_amount_clp: number }[] {
  return planRows([accountId])
    .filter((p) => p.purchase_date != null && p.total_amount_clp != null)
    .map((p) => ({ id: p.id, purchase_date: p.purchase_date, total_amount_clp: p.total_amount_clp }));
}

// ---------------------------------------------------------------------------------------------
// View 2 — billed and open-cycle lines
// ---------------------------------------------------------------------------------------------

/** A statement line as the facturado sums read it. */
export type BilledLine = {
  id: number;
  merchant: string | null;
  amount_clp: number | null;
  amount_usd: number | null;
  statement_currency: string;
  installment_flag: number;
  valor_cuota_mensual_clp: number | null;
  valor_cuota_mensual_usd: number | null;
};

/**
 * The one-shot lines a statement (or bucket) of this close bills: every line of that date on the
 * card, flag 0, without the ones a plan supersedes (the plan bills them) and without contract
 * summaries.
 */
export function billedOneShotLines(accountId: number, statementDate: string): BilledLine[] {
  const rows = db
    .prepare(
      `SELECT l.id, l.merchant, l.amount_clp, l.amount_usd, s.currency AS statement_currency,
              l.installment_flag, l.valor_cuota_mensual_clp, l.valor_cuota_mensual_usd
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ? AND s.statement_date = ? AND l.installment_flag = 0`
    )
    .all(accountId, statementDate) as BilledLine[];
  const superseded = supersededOneShotLineIds(accountId);
  return rows.filter((r) => !superseded.has(r.id) && !isInstallmentContractSummaryMerchant(r.merchant));
}

/** Every line (cuotas included) of the card's statements of this close, as stored. */
export function linesOfClose(accountId: number, statementDate: string): BilledLine[] {
  return db
    .prepare(
      `SELECT l.id, l.merchant, l.installment_flag, l.amount_clp, l.amount_usd,
              s.currency AS statement_currency,
              l.valor_cuota_mensual_clp, l.valor_cuota_mensual_usd
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ? AND s.statement_date = ?`
    )
    .all(accountId, statementDate) as BilledLine[];
}

/** A statement row's own lines, with their stored kind. */
export function linesOfStatement(
  statementId: number
): { id: number; kind: string | null; merchant: string | null; amount_clp: number | null; amount_usd: number | null }[] {
  return db
    .prepare(`SELECT id, kind, merchant, amount_clp, amount_usd FROM cc_statement_lines WHERE statement_id = ?`)
    .all(statementId) as { id: number; kind: string | null; merchant: string | null; amount_clp: number | null; amount_usd: number | null }[];
}

/** A feed-typed cuota purchase in the open bucket, still waiting for its plan (count unknown). */
export type OpenCycleCuotaPurchaseLine = {
  id: number;
  merchant: string | null;
  transaction_date: string | null;
  posting_date: string | null;
  amount_clp: number | null;
  cuota_purchase_kind: CcCuotaPurchaseKind;
  source_pdf: string;
};

/**
 * The open bucket's lines the feed typed as cuota purchases (`cuota_purchase_kind`), without the
 * ones a plan already supersedes — the plan carries those.
 */
export function openCycleCuotaPurchaseLines(accountId: number): OpenCycleCuotaPurchaseLine[] {
  const rows = db
    .prepare(
      `SELECT l.id, l.merchant, l.transaction_date, l.posting_date, l.amount_clp, l.cuota_purchase_kind,
              s.source_pdf
       FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ? AND s.source_kind = 'listing_open'
         AND l.cuota_purchase_kind IS NOT NULL
       ORDER BY l.id`
    )
    .all(accountId) as OpenCycleCuotaPurchaseLine[];
  if (rows.length === 0) return [];
  const superseded = supersededOneShotLineIds(accountId);
  return rows.filter((r) => !superseded.has(r.id));
}

// ---------------------------------------------------------------------------------------------
// View 3 — expense evidence (the card side of the expense lines)
// ---------------------------------------------------------------------------------------------

/**
 * A card line as the expense-line builder reads it: the evidence of an expense, with the statement
 * it sits on and its stored kind. The builder (`buildCcExpenseLines`) turns these and the plan
 * views into `FlowCcExpenseLineRowDraft`s — the one expense shape the checking builder emits too,
 * with no plan overlay.
 */
export type CardExpenseEvidenceLine = {
  statement_line_id: number;
  statement_id: number;
  account_id: number;
  statement_date: string;
  source_pdf: string;
  source_kind: string;
  statement_currency: string;
  primary_card_last4: string | null;
  origin_card_last4: string | null;
  transaction_date: string | null;
  posting_date: string | null;
  parser_row_id: string | null;
  amount_clp: number | null;
  amount_usd: number | null;
  amount_orig: number | null;
  orig_currency: string | null;
  merchant: string | null;
  installment_flag: number;
  nro_cuota_current: number | null;
  nro_cuota_total: number | null;
  valor_cuota_mensual_clp: number | null;
  valor_cuota_mensual_usd: number | null;
  cuota_purchase_kind: CcCuotaPurchaseKind | null;
  kind: string | null;
};

/**
 * The card lines of these accounts that carry an amount (pesos, dollars or a cuota), newest
 * statement first. Lines a plan supersedes are included: the builder marks them, the Total view
 * shows the plan's total in their place.
 */
export function expenseEvidenceLines(accountIds: readonly number[]): CardExpenseEvidenceLine[] {
  if (accountIds.length === 0) return [];
  return db
    .prepare(
      `SELECT l.id AS statement_line_id, s.id AS statement_id, s.account_id, s.statement_date, s.source_pdf, s.source_kind,
              s.currency AS statement_currency, s.card_last4 AS primary_card_last4,
              l.transaction_date, l.posting_date, l.origin_card_last4, l.parser_row_id,
              l.amount_clp, l.amount_usd, l.amount_orig, l.orig_currency, l.merchant, l.installment_flag,
              l.nro_cuota_current, l.nro_cuota_total,
              l.valor_cuota_mensual_clp, l.valor_cuota_mensual_usd, l.cuota_purchase_kind, l.kind
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id IN (${accountIds.map(() => "?").join(",")})
         AND (
           l.amount_clp IS NOT NULL
           OR (l.amount_usd IS NOT NULL AND l.amount_usd != 0)
           OR (l.installment_flag = 1 AND l.valor_cuota_mensual_clp IS NOT NULL AND l.valor_cuota_mensual_clp != 0)
           OR (l.installment_flag = 1 AND l.valor_cuota_mensual_usd IS NOT NULL AND l.valor_cuota_mensual_usd != 0)
         )
       ORDER BY s.statement_date DESC, l.id DESC`
    )
    .all(...accountIds) as CardExpenseEvidenceLine[];
}

// ---------------------------------------------------------------------------------------------
// View 4 — the plan ledger: plans, their stored cuotas and the line behind each (private join)
// ---------------------------------------------------------------------------------------------

/** A plan as the schedule reads it. */
export type LedgerPlan = {
  id: number;
  canonical_row_id: string;
  card_group: string;
  purchase_date: string;
  total_amount_clp: number;
  cuotas_totales: number;
  merchant: string | null;
  description_merged: string | null;
  matched_baseline_purchase_id: string | null;
  source: string;
  /** Evidence-backed first-cuota month (YYYY-MM); NULL = derive it (migration 163). */
  first_due_month: string | null;
  /** Occurrence among same-identity twin purchases, 0-based (migration 187). */
  twin_index: number;
};

/** A plan's stored cuota with the period of the statement whose line it was read from. */
export type LedgerPlanCuota = {
  id: number;
  purchase_id: number;
  pay_by_date: string;
  statement_date: string | null;
  statement_period_month: string | null;
  /** `period_to` of the statement whose line carries this cuota (joined by `parser_row_id`). */
  period_to_join: string | null;
  source_pdf: string | null;
  amount_clp: number;
  cuota_current: number | null;
  cuota_total: number | null;
};

/** The card's plans in purchase order. */
export function ledgerPlans(accountId: number): LedgerPlan[] {
  return db
    .prepare(
      `SELECT id, canonical_row_id, card_group, purchase_date, total_amount_clp, cuotas_totales,
              merchant, description_merged, matched_baseline_purchase_id, source, first_due_month,
              twin_index
       FROM cc_installment_purchases
       WHERE account_id = ?
       ORDER BY purchase_date, id`
    )
    .all(accountId) as LedgerPlan[];
}

/** How many plans the card has (every source). */
export function planCount(accountId: number): number {
  const r = db.prepare(`SELECT COUNT(*) AS c FROM cc_installment_purchases WHERE account_id = ?`).get(accountId) as {
    c: number;
  };
  return Number(r.c);
}

/**
 * The card plans' stored cuotas by pay-by, each with the period of the statement its line sits on
 * (the line found through `parser_row_id`, on the same card).
 */
export function ledgerPlanCuotas(accountId: number): LedgerPlanCuota[] {
  return db
    .prepare(
      `SELECT p.id, p.purchase_id, p.pay_by_date, p.statement_date, p.statement_period_month,
              p.source_pdf, p.amount_clp, p.cuota_current, p.cuota_total, s.period_to AS period_to_join
       FROM cc_installment_payments p
       JOIN cc_installment_purchases pr ON pr.id = p.purchase_id
       LEFT JOIN cc_statement_lines l ON l.parser_row_id IS NOT NULL AND l.parser_row_id != ''
         AND l.parser_row_id = p.parser_row_id
       LEFT JOIN cc_statements s ON s.id = l.statement_id AND s.account_id = pr.account_id
       WHERE pr.account_id = ?
       ORDER BY p.pay_by_date, p.id`
    )
    .all(accountId) as LedgerPlanCuota[];
}

/**
 * Each priced plan's printed cuota lines (the lines behind its stored cuotas): the principal the
 * statement prints for the plan and its printed rate. The interest of a plan reads them.
 */
export function planPrintedCuotaLines(
  accountId: number
): { purchase_id: number; purchase_date: string; total_amount_clp: number; principal_clp: number | null; rate_text: string | null }[] {
  return db
    .prepare(
      `SELECT ip.id AS purchase_id, ip.purchase_date, ip.total_amount_clp,
              l.amount_clp AS principal_clp, l.interest_rate_text AS rate_text
       FROM cc_installment_purchases ip
       JOIN cc_installment_payments p ON p.purchase_id = ip.id
       JOIN cc_statement_lines l ON l.parser_row_id = p.parser_row_id
       WHERE ip.account_id = ? AND ip.total_amount_clp IS NOT NULL
       ORDER BY ip.id`
    )
    .all(accountId) as {
    purchase_id: number;
    purchase_date: string;
    total_amount_clp: number;
    principal_clp: number | null;
    rate_text: string | null;
  }[];
}

/** The card's one-shot credits (negative pesos) with their statement's period: nota candidates. */
export function oneShotCreditLines(
  accountId: number
): { merchant: string | null; amount_clp: number; occurred: string | null; stmt_period_to: string | null; stmt_statement_date: string | null }[] {
  return db
    .prepare(
      `SELECT l.merchant, l.amount_clp, COALESCE(l.transaction_date, l.posting_date) AS occurred,
              s.period_to AS stmt_period_to, s.statement_date AS stmt_statement_date
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ?
         AND l.installment_flag = 0
         AND l.amount_clp < 0`
    )
    .all(accountId) as {
    merchant: string | null;
    amount_clp: number;
    occurred: string | null;
    stmt_period_to: string | null;
    stmt_statement_date: string | null;
  }[];
}

// ---------------------------------------------------------------------------------------------
// The purchases themselves
// ---------------------------------------------------------------------------------------------

/**
 * A card purchase: a plain one-shot line, a line with the plan it was bought in (the plan carries
 * the purchase, the line is its evidence), or a plan no line carries (a statement-owned plan, or one
 * whose line was converted away).
 */
export type EffectivePurchase =
  | { shape: "line"; line: CardOneShotLine }
  | { shape: "line_with_plan"; line: CardOneShotLine; plan: CardPlanForMatching }
  | { shape: "plan"; plan: CardPlanForMatching };

/**
 * The card's purchases, each once: every positive one-shot line (with its plan when one supersedes
 * it), then the plans no line carries.
 */
export function effectivePurchases(accountId: number): EffectivePurchase[] {
  const superseded = oneShotLinesSupersededByPlans(accountId);
  const out: EffectivePurchase[] = [];
  const plansWithLine = new Set<number>();
  for (const line of listOneShotLinesForAccount(accountId)) {
    const plan = superseded.get(line.statement_line_id);
    if (plan) {
      plansWithLine.add(plan.id);
      out.push({ shape: "line_with_plan", line, plan });
    } else {
      out.push({ shape: "line", line });
    }
  }
  for (const plan of listPlansForLineMatching(accountId)) {
    if (!plansWithLine.has(plan.id)) out.push({ shape: "plan", plan });
  }
  return out;
}
