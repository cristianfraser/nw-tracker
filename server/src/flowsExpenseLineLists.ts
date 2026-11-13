/**
 * The Expenses page's expense lines, server-filtered: one list per request (`GET
 * /api/flows/expenses/lines`), the page's summary (`GET /api/flows/expenses/summary`) and the
 * facturado-financing manager's pickers (`GET /api/flows/expenses/financing-candidates`). All of
 * them read the one cached full line list (`cachedFlowsExpenseLines`) and are cached beside it in
 * the flows-inputs family, so writes and live-rate changes drop them as they drop the lines.
 * Lines are filtered before they go through `toWireExpenseLines`, so only what is sent is converted.
 */
import type {
  FinancedAccountDto,
  FinancingCandidateDto,
  FlowsExpenseLinesPage,
  FlowsExpenseLinesResponse,
  FlowsExpenseLinesSelector,
  FlowsExpensesFinancingCandidatesResponse,
  FlowsExpensesSummaryResponse,
} from "nw-tracker-contracts/dto/flows";
import { buildAdditionalCardsSummary } from "./additionalCardReimbursements.js";
import { cacheKeyFlowsInputs } from "./cacheFamilies.js";
import { getAggregationCached } from "./cacheRegistry.js";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import { listCcExpenseBigGroups } from "./ccExpenseBigGroups.js";
import { listCcExpenseCategories } from "./ccExpenseCategories.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import type { FlowCcExpenseLineRow } from "./flowsExpenses.js";
import { cachedFlowsExpenseLines, syncFlowsInputsWithLiveUsdRates } from "./flowsMortgageCarrying.js";
import { lineAmount, linePesos } from "./lineMoney.js";
import { toWireExpenseLines } from "./wireExpenseLine.js";

/** A request the selector cannot serve: 400 for a malformed one, 404 for a card or facturación that is not there. */
export class ExpenseLinesRequestError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string
  ) {
    super(message);
  }
}

const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const POSITIVE_INT_RE = /^[1-9]\d*$/;

function singleParam(query: Record<string, unknown>, name: string): string | undefined {
  const v = query[name];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new ExpenseLinesRequestError(400, `${name} must be given once`);
  return v;
}

function yearMonthParam(name: string, raw: string): string {
  if (!YEAR_MONTH_RE.test(raw)) throw new ExpenseLinesRequestError(400, `${name} must be YYYY-MM, got ${raw}`);
  return raw;
}

/**
 * The selector of `GET /api/flows/expenses/lines`: exactly one of `month=YYYY-MM`,
 * `account_id=<id>&billing_month=YYYY-MM` (both), `list=uncategorized|deposit_matched`,
 * `big_group=<slug>`; `include_pre_tax` is `0` or `1` (absent = 0) and refused with a facturación,
 * which has no pre-tax lines. Anything else is a 400.
 */
export function parseExpenseLinesSelector(query: Record<string, unknown>): FlowsExpenseLinesSelector {
  const month = singleParam(query, "month");
  const accountIdRaw = singleParam(query, "account_id");
  const billingMonth = singleParam(query, "billing_month");
  const list = singleParam(query, "list");
  const bigGroup = singleParam(query, "big_group");
  const preTaxRaw = singleParam(query, "include_pre_tax");

  if ((accountIdRaw === undefined) !== (billingMonth === undefined)) {
    throw new ExpenseLinesRequestError(400, "account_id and billing_month go together");
  }
  const given = [
    month !== undefined ? "month" : null,
    accountIdRaw !== undefined ? "account_id+billing_month" : null,
    list !== undefined ? "list" : null,
    bigGroup !== undefined ? "big_group" : null,
  ].filter((s): s is string => s !== null);
  if (given.length !== 1) {
    throw new ExpenseLinesRequestError(
      400,
      given.length === 0
        ? "one selector required: month, account_id+billing_month, list or big_group"
        : `exactly one selector allowed, got ${given.join(", ")}`
    );
  }
  if (preTaxRaw !== undefined && preTaxRaw !== "0" && preTaxRaw !== "1") {
    throw new ExpenseLinesRequestError(400, `include_pre_tax must be 0 or 1, got ${preTaxRaw}`);
  }
  const includePreTax = preTaxRaw === "1";

  if (month !== undefined) return { kind: "month", period_month: yearMonthParam("month", month), include_pre_tax: includePreTax };
  if (accountIdRaw !== undefined && billingMonth !== undefined) {
    if (preTaxRaw !== undefined) throw new ExpenseLinesRequestError(400, "include_pre_tax does not apply to a facturación");
    if (!POSITIVE_INT_RE.test(accountIdRaw)) {
      throw new ExpenseLinesRequestError(400, `account_id must be a positive integer, got ${accountIdRaw}`);
    }
    return { kind: "facturacion", account_id: Number(accountIdRaw), billing_month: yearMonthParam("billing_month", billingMonth) };
  }
  if (list !== undefined) {
    if (list !== "uncategorized" && list !== "deposit_matched") {
      throw new ExpenseLinesRequestError(400, `list must be uncategorized or deposit_matched, got ${list}`);
    }
    return { kind: list, include_pre_tax: includePreTax };
  }
  const slug = String(bigGroup).trim();
  if (!slug) throw new ExpenseLinesRequestError(400, "big_group must not be empty");
  return { kind: "big_group", slug, include_pre_tax: includePreTax };
}

/** The paged list's page size when the request names none, and its ceiling. */
export const UNCATEGORIZED_DEFAULT_PAGE_SIZE = 10;
const UNCATEGORIZED_MAX_PAGE_SIZE = 100;

function positiveIntParam(query: Record<string, unknown>, name: string): number | undefined {
  const raw = singleParam(query, name);
  if (raw === undefined) return undefined;
  if (!POSITIVE_INT_RE.test(raw)) throw new ExpenseLinesRequestError(400, `${name} must be a positive integer, got ${raw}`);
  return Number(raw);
}

/**
 * The page a request asks for: `list=uncategorized` is always paged (`page`, `page_size`, default
 * 1 and {@link UNCATEGORIZED_DEFAULT_PAGE_SIZE}, at most 100); any other selector takes no paging
 * params (null), and naming one is a 400.
 */
export function parseExpenseLinesPage(
  query: Record<string, unknown>,
  selector: FlowsExpenseLinesSelector
): { page: number; pageSize: number } | null {
  const page = positiveIntParam(query, "page");
  const pageSize = positiveIntParam(query, "page_size");
  if (selector.kind !== "uncategorized") {
    if (page !== undefined || pageSize !== undefined) {
      throw new ExpenseLinesRequestError(400, `paging applies only to list=uncategorized, not ${selector.kind}`);
    }
    return null;
  }
  if (pageSize !== undefined && pageSize > UNCATEGORIZED_MAX_PAGE_SIZE) {
    throw new ExpenseLinesRequestError(400, `page_size must be at most ${UNCATEGORIZED_MAX_PAGE_SIZE}, got ${pageSize}`);
  }
  return { page: page ?? 1, pageSize: pageSize ?? UNCATEGORIZED_DEFAULT_PAGE_SIZE };
}

/** The uncategorized list's order: largest in pesos first, then newest (sorts in place). */
export function sortLargestFirst<T extends { value_clp: number; occurred_on: string }>(lines: T[]): T[] {
  return lines.sort((a, b) => b.value_clp - a.value_clp || b.occurred_on.localeCompare(a.occurred_on));
}

/** One page of a cached list (the page clamped to the last one). */
export function pageOfExpenseLinesList(
  list: FlowsExpenseLinesResponse,
  request: { page: number; pageSize: number }
): FlowsExpenseLinesResponse {
  const total = list.lines.length;
  const lastPage = Math.max(1, Math.ceil(total / request.pageSize));
  const page = Math.min(request.page, lastPage);
  const start = (page - 1) * request.pageSize;
  const info: FlowsExpenseLinesPage = { page, page_size: request.pageSize, total };
  return { ...list, lines: list.lines.slice(start, start + request.pageSize), page: info };
}

type FacturacionFlags = { billing_month: string; is_open_month: boolean; is_provisional_close: boolean };

/**
 * Facturación modal lines: this card's expense rows whose `billing_month` — stamped by the line
 * builders with the rule its facturado sums use — is the facturación. A closed facturación lists its
 * statements' own lines (`statement_line_id > 0`); an open or provisionally closed one has no
 * statement cuota lines yet, so the ledger's cuotas for the month stand in — not the
 * facturado-financing `split_only` slices, which are Expenses-tab display derivations carrying the
 * FINANCED card's id on the financing card's months (scope `excluded` stays visible: the financing
 * card's own plan cuotas are real rows). Synthetic installment purchase totals never belong to a
 * facturación.
 */
export function flowLinesForFacturacionMonth<
  L extends Pick<FlowCcExpenseLineRow, "account_id" | "billing_month" | "line_role" | "statement_line_id" | "gastos_scope">,
>(lines: readonly L[], accountId: number, row: FacturacionFlags): L[] {
  const statementLinesOnly = !row.is_open_month && !row.is_provisional_close;
  return lines.filter((ln) => {
    if (ln.account_id !== accountId || ln.billing_month !== row.billing_month) return false;
    if (ln.line_role === "installment_purchase_total") return false;
    if (ln.statement_line_id > 0) return true;
    return !statementLinesOnly && ln.line_role === "installment_cuota" && ln.gastos_scope !== "split_only";
  });
}

function facturacionRow(accountId: number, billingMonth: string): FacturacionFlags {
  if (!listCreditCardMasterAccountIds().includes(accountId)) {
    throw new ExpenseLinesRequestError(404, `account ${accountId} is not a credit-card master`);
  }
  const row = billingDetailCacheForAccount(accountId).facturaciones.find((f) => f.billing_month === billingMonth);
  if (!row) throw new ExpenseLinesRequestError(404, `card ${accountId} has no facturación ${billingMonth}`);
  return row;
}

/** The lines a selector picks, in pipeline order (throws {@link ExpenseLinesRequestError} for a missing card / facturación). */
export function selectExpenseLines(
  lines: readonly FlowCcExpenseLineRow[],
  selector: FlowsExpenseLinesSelector
): FlowCcExpenseLineRow[] {
  if (selector.kind === "facturacion") {
    return flowLinesForFacturacionMonth(lines, selector.account_id, facturacionRow(selector.account_id, selector.billing_month));
  }
  const keep = (ln: FlowCcExpenseLineRow): boolean => {
    switch (selector.kind) {
      case "month":
        return ln.period_month === selector.period_month;
      case "uncategorized":
        return ln.pending_classification === true;
      case "deposit_matched":
        return (ln.deposit_match?.length ?? 0) > 0 || (ln.expense_deposit_links?.length ?? 0) > 0;
      case "big_group":
        return ln.big_group_slug === selector.slug;
    }
  };
  return lines.filter((ln) => (selector.include_pre_tax || ln.pre_tax !== true) && keep(ln));
}

function selectorCacheKey(selector: FlowsExpenseLinesSelector): string {
  switch (selector.kind) {
    case "facturacion":
      return `facturacion|${selector.account_id}|${selector.billing_month}`;
    case "month":
      return `month|${selector.period_month}|${selector.include_pre_tax ? 1 : 0}`;
    case "big_group":
      return `big_group|${selector.slug}|${selector.include_pre_tax ? 1 : 0}`;
    default:
      return `${selector.kind}|${selector.include_pre_tax ? 1 : 0}`;
  }
}

/** `GET /api/flows/expenses/lines`, cached per unit and selector. */
export function cachedFlowsExpenseLinesList(unit: string, selector: FlowsExpenseLinesSelector): FlowsExpenseLinesResponse {
  syncFlowsInputsWithLiveUsdRates();
  // Resolve the facturación before the cache, so a missing one is never cached as a value.
  if (selector.kind === "facturacion") facturacionRow(selector.account_id, selector.billing_month);
  return getAggregationCached(cacheKeyFlowsInputs(`expense_lines|${unit}|${selectorCacheKey(selector)}`), () => {
    const lines = toWireExpenseLines(selectExpenseLines(cachedFlowsExpenseLines(), selector), unit);
    // The paged list is ordered here, once, so every page reads the same order.
    if (selector.kind === "uncategorized") sortLargestFirst(lines);
    return {
      unit,
      selector,
      lines,
      categories: listCcExpenseCategories(),
      big_groups: listCcExpenseBigGroups(),
    };
  });
}

/** `GET /api/flows/expenses/summary`, cached per unit. */
export function cachedFlowsExpensesSummary(unit: string): FlowsExpensesSummaryResponse {
  syncFlowsInputsWithLiveUsdRates();
  return getAggregationCached(cacheKeyFlowsInputs(`expenses_summary|${unit}`), () => {
    const lines = cachedFlowsExpenseLines();
    return {
      unit,
      categories: listCcExpenseCategories(),
      big_groups: listCcExpenseBigGroups(),
      active_big_group_slugs: [...new Set(lines.flatMap((l) => (l.big_group_slug ? [l.big_group_slug] : [])))].sort(),
      additional_cards: buildAdditionalCardsSummary(lines, unit),
    };
  });
}

/**
 * Installment purchases a facturado can be financed with, one row per purchase key, newest
 * purchase month first. A financing link stores `{ account_id, purchase_key }` and covers every
 * plan carrying that key, so identical same-statement twins (one «Total» line each) are a single
 * target, shown with their count and combined principal (in pesos: a financing pays a peso facturado).
 */
export function financingCandidatesFromLines(lines: readonly FlowCcExpenseLineRow[]): FinancingCandidateDto[] {
  const byKey = new Map<string, FinancingCandidateDto>();
  for (const ln of lines) {
    if (ln.line_role !== "installment_purchase_total") continue;
    const key = `${ln.account_id}|${ln.purchase_key}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.purchase_count += 1;
      existing.amount_clp += linePesos(ln);
      continue;
    }
    byKey.set(key, {
      key,
      account_id: ln.account_id,
      purchase_key: ln.purchase_key,
      merchant: ln.merchant ?? "",
      purchase_count: 1,
      amount_clp: linePesos(ln),
      purchase_month: ln.purchase_month,
      origin_label: ln.origin_label,
    });
  }
  return [...byKey.values()].sort((a, b) => b.purchase_month.localeCompare(a.purchase_month));
}

/**
 * Cards whose facturado can be financed: every account with a one-shot purchase line, in line
 * order, labelled by its first line's `origin_label`; its facturaciones are the billing months of
 * its positive purchase lines, newest first.
 */
export function financedAccountsFromLines(lines: readonly FlowCcExpenseLineRow[]): FinancedAccountDto[] {
  const byId = new Map<number, { label: string; months: Set<string> }>();
  for (const ln of lines) {
    if (ln.line_role !== "purchase") continue;
    let acc = byId.get(ln.account_id);
    if (!acc) {
      acc = { label: ln.origin_label, months: new Set() };
      byId.set(ln.account_id, acc);
    }
    if (lineAmount(ln).value > 0) acc.months.add(ln.billing_month);
  }
  return [...byId.entries()].map(([account_id, { label, months }]) => ({
    account_id,
    label,
    billing_months: [...months].sort().reverse(),
  }));
}

/** `GET /api/flows/expenses/financing-candidates`, cached per unit. */
export function cachedFlowsExpensesFinancingCandidates(unit: string): FlowsExpensesFinancingCandidatesResponse {
  syncFlowsInputsWithLiveUsdRates();
  return getAggregationCached(cacheKeyFlowsInputs(`financing_candidates|${unit}`), () => {
    const lines = cachedFlowsExpenseLines();
    return { unit, financed_accounts: financedAccountsFromLines(lines), candidates: financingCandidatesFromLines(lines) };
  });
}
