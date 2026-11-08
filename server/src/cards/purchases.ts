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
import { normalizeMerchantText, parseDdMmYyToIso, stripBciTerminalSuffix } from "nw-tracker-contracts";

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
