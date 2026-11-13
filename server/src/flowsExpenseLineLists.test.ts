import { describe, expect, it } from "vitest";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { buildFlowsExpenseLines, type FlowCcExpenseLineRow } from "./flowsExpenses.js";
import {
  cachedFlowsExpenseLinesList,
  cachedFlowsExpensesFinancingCandidates,
  cachedFlowsExpensesSummary,
  ExpenseLinesRequestError,
  financedAccountsFromLines,
  financingCandidatesFromLines,
  flowLinesForFacturacionMonth,
  pageOfExpenseLinesList,
  parseExpenseLinesPage,
  parseExpenseLinesSelector,
  sortLargestFirst,
  UNCATEGORIZED_DEFAULT_PAGE_SIZE,
  selectExpenseLines,
} from "./flowsExpenseLineLists.js";

function rejects(query: Record<string, unknown>, status: 400 | 404 = 400): void {
  let err: unknown;
  try {
    parseExpenseLinesSelector(query);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ExpenseLinesRequestError);
  expect((err as ExpenseLinesRequestError).status).toBe(status);
}

describe("parseExpenseLinesSelector", () => {
  it("reads each selector", () => {
    expect(parseExpenseLinesSelector({ month: "2026-03" })).toEqual({ kind: "month", period_month: "2026-03", include_pre_tax: false });
    expect(parseExpenseLinesSelector({ month: "2026-03", include_pre_tax: "1" })).toEqual({
      kind: "month",
      period_month: "2026-03",
      include_pre_tax: true,
    });
    expect(parseExpenseLinesSelector({ account_id: "32", billing_month: "2026-09" })).toEqual({
      kind: "facturacion",
      account_id: 32,
      billing_month: "2026-09",
    });
    expect(parseExpenseLinesSelector({ list: "uncategorized" })).toEqual({ kind: "uncategorized", include_pre_tax: false });
    expect(parseExpenseLinesSelector({ list: "deposit_matched", include_pre_tax: "0" })).toEqual({
      kind: "deposit_matched",
      include_pre_tax: false,
    });
    expect(parseExpenseLinesSelector({ big_group: " viaje " })).toEqual({ kind: "big_group", slug: "viaje", include_pre_tax: false });
  });

  it("refuses no selector, two selectors and malformed values", () => {
    rejects({});
    rejects({ unit: "clp" });
    rejects({ month: "2026-03", list: "uncategorized" });
    rejects({ month: "2026-13" });
    rejects({ month: "2026-3" });
    rejects({ month: ["2026-03", "2026-04"] });
    rejects({ account_id: "32" });
    rejects({ billing_month: "2026-09" });
    rejects({ account_id: "x", billing_month: "2026-09" });
    rejects({ account_id: "0", billing_month: "2026-09" });
    rejects({ account_id: "32", billing_month: "2026-09-01" });
    rejects({ account_id: "32", billing_month: "2026-09", include_pre_tax: "1" });
    rejects({ list: "everything" });
    rejects({ big_group: "  " });
    rejects({ list: "uncategorized", include_pre_tax: "yes" });
  });
});

describe("selectExpenseLines over the synthetic person's lines", () => {
  const lines = buildFlowsExpenseLines();

  it("month: the lines of that period month, pre-tax only when asked", () => {
    const preTaxMonth = lines.find((l) => l.pre_tax === true && l.period_month)?.period_month;
    expect(preTaxMonth).toBeTruthy();
    const net = selectExpenseLines(lines, { kind: "month", period_month: preTaxMonth!, include_pre_tax: false });
    const all = selectExpenseLines(lines, { kind: "month", period_month: preTaxMonth!, include_pre_tax: true });
    expect(net.length).toBeGreaterThan(0);
    expect(all.every((l) => l.period_month === preTaxMonth)).toBe(true);
    expect(net.some((l) => l.pre_tax)).toBe(false);
    expect(all.some((l) => l.pre_tax)).toBe(true);
    expect(all.length).toBe(lines.filter((l) => l.period_month === preTaxMonth).length);
    expect(net.length).toBe(all.filter((l) => !l.pre_tax).length);
  });

  it("uncategorized, deposit_matched and big_group pick by their fields", () => {
    const unc = selectExpenseLines(lines, { kind: "uncategorized", include_pre_tax: true });
    expect(unc.length).toBe(lines.filter((l) => l.pending_classification === true).length);
    const dep = selectExpenseLines(lines, { kind: "deposit_matched", include_pre_tax: true });
    expect(dep.length).toBe(
      lines.filter((l) => (l.deposit_match?.length ?? 0) > 0 || (l.expense_deposit_links?.length ?? 0) > 0).length
    );
    const none = selectExpenseLines(lines, { kind: "big_group", slug: "vitest-no-such-group", include_pre_tax: true });
    expect(none).toEqual([]);
  });

  it("facturación: a card that is not a master, or a month it has not billed, is a 404", () => {
    const masters = listCreditCardMasterAccountIds();
    const notCard = Math.max(0, ...masters) + 100_000;
    expect(() => cachedFlowsExpenseLinesList("clp", { kind: "facturacion", account_id: notCard, billing_month: "2026-01" })).toThrow(
      ExpenseLinesRequestError
    );
    expect(() =>
      cachedFlowsExpenseLinesList("clp", { kind: "facturacion", account_id: masters[0]!, billing_month: "1990-01" })
    ).toThrow(ExpenseLinesRequestError);
  });

  it("facturación: lists the card's lines billed in it, never a purchase total", () => {
    const masters = listCreditCardMasterAccountIds();
    let checked = 0;
    for (const accountId of masters) {
      for (const row of billingDetailCacheForAccount(accountId).facturaciones) {
        const picked = selectExpenseLines(lines, { kind: "facturacion", account_id: accountId, billing_month: row.billing_month });
        expect(picked.every((l) => l.account_id === accountId && l.billing_month === row.billing_month)).toBe(true);
        expect(picked.some((l) => l.line_role === "installment_purchase_total")).toBe(false);
        if (!row.is_open_month && !row.is_provisional_close) expect(picked.every((l) => l.statement_line_id > 0)).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

/** A finished line for the pure rules: only the fields they read, money in pesos. */
function line(partial: Partial<FlowCcExpenseLineRow> & { statement_line_id: number; pesos?: number }): FlowCcExpenseLineRow {
  const { pesos = 1000, ...rest } = partial;
  return {
    source: "cc",
    account_id: 1,
    billing_month: "2026-05",
    purchase_month: "2026-04",
    line_role: "purchase",
    merchant: "SHOP",
    purchase_key: "k",
    origin_label: "4242",
    amount: { value: pesos, currency: "clp" },
    values: { clp: { value: pesos, rate_source: "native" } },
    ...rest,
  } as unknown as FlowCcExpenseLineRow;
}

const closed = (billing_month: string) => ({ billing_month, is_open_month: false, is_provisional_close: false });
const open = (billing_month: string) => ({ billing_month, is_open_month: true, is_provisional_close: false });
const provisional = (billing_month: string) => ({ billing_month, is_open_month: false, is_provisional_close: true });
const ids = (lines: readonly FlowCcExpenseLineRow[]) => lines.map((ln) => ln.statement_line_id).sort((a, b) => a - b);

describe("flowLinesForFacturacionMonth", () => {
  it("lists a closed month's statement lines only — no ledger fill, no purchase totals", () => {
    const flows = [
      line({ statement_line_id: 100, billing_month: "2026-05" }),
      line({ statement_line_id: -2_000_000_001, line_role: "installment_cuota", billing_month: "2026-05", pesos: 5000 }),
      line({ statement_line_id: -500, line_role: "installment_purchase_total", billing_month: "2026-05", pesos: 50_000 }),
      line({ statement_line_id: 101, billing_month: "2026-06" }),
    ];
    expect(ids(flowLinesForFacturacionMonth(flows, 1, closed("2026-05")))).toEqual([100]);
  });

  it("lists an open (or provisionally closed) month's bucket lines with its plan cuotas", () => {
    const flows = [
      line({ statement_line_id: 200, billing_month: "2026-07", pesos: 50_000 }),
      line({ statement_line_id: -2_000_000_042, line_role: "installment_cuota", billing_month: "2026-07", pesos: 18_660 }),
      line({ statement_line_id: -2_000_000_043, line_role: "installment_cuota", billing_month: "2026-08", pesos: 18_660 }),
    ];
    expect(ids(flowLinesForFacturacionMonth(flows, 1, open("2026-07")))).toEqual([-2_000_000_042, 200]);
    expect(ids(flowLinesForFacturacionMonth(flows, 1, provisional("2026-07")))).toEqual([-2_000_000_042, 200]);
  });

  it("never lists another facturación's bucket lines", () => {
    const flows = [
      line({ statement_line_id: 300, billing_month: "2026-09", merchant: "PAYU *UBER EA" }),
      line({ statement_line_id: 301, billing_month: "2026-09", merchant: "USD STATEMENT LINE" }),
      line({ statement_line_id: 400, billing_month: "2026-10", merchant: "OCTOBER FEED ROW" }),
    ];
    expect(ids(flowLinesForFacturacionMonth(flows, 1, open("2026-10")))).toEqual([400]);
    expect(ids(flowLinesForFacturacionMonth(flows, 1, provisional("2026-09")))).toEqual([300, 301]);
  });

  it("excludes other cards' lines", () => {
    const flows = [
      line({ statement_line_id: 500, billing_month: "2026-07" }),
      line({ statement_line_id: 501, billing_month: "2026-07", account_id: 2 }),
    ];
    expect(ids(flowLinesForFacturacionMonth(flows, 1, open("2026-07")))).toEqual([500]);
  });

  it("open month excludes facturado-financing split_only slices, keeps `excluded` plan cuotas", () => {
    const flows = [
      line({ statement_line_id: -3_000_160_000, line_role: "installment_cuota", billing_month: "2026-08", pesos: 400_000 }),
      line({
        statement_line_id: -1_000_000_001,
        line_role: "installment_cuota",
        billing_month: "2026-08",
        pesos: 112_727,
        gastos_scope: "split_only",
      }),
      line({
        statement_line_id: -3_000_161_000,
        line_role: "installment_cuota",
        billing_month: "2026-08",
        pesos: 422_345,
        gastos_scope: "excluded",
      }),
    ];
    expect(ids(flowLinesForFacturacionMonth(flows, 1, open("2026-08")))).toEqual([-3_000_161_000, -3_000_160_000]);
  });
});

describe("financingCandidatesFromLines", () => {
  const total = (partial: Partial<FlowCcExpenseLineRow> & { statement_line_id: number; pesos?: number }) =>
    line({
      line_role: "installment_purchase_total",
      purchase_month: "2025-01",
      billing_month: "2025-01",
      merchant: "STREAMING CO",
      purchase_key: "installment-h:1:2025-01-05:12:50000:STREAMING CO",
      pesos: 50_000,
      ...partial,
    });

  it("lists identical twin plans once, with their count and combined principal, newest month first", () => {
    const twins = [-1, -2, -3].map((id) => total({ statement_line_id: id }));
    const single = total({
      statement_line_id: -4,
      purchase_month: "2025-03",
      pesos: 90_000,
      merchant: "FURNITURE",
      purchase_key: "installment-h:1:2025-03-10:3:90000:FURNITURE",
    });
    const cuota = total({ statement_line_id: 7, line_role: "installment_cuota", pesos: 4_167 });
    const purchase = total({ statement_line_id: 8, line_role: "purchase", purchase_key: "line-pr:x" });

    const candidates = financingCandidatesFromLines([...twins, single, cuota, purchase]);
    expect(candidates.map((c) => [c.merchant, c.purchase_count, c.amount_clp])).toEqual([
      ["FURNITURE", 1, 90_000],
      ["STREAMING CO", 3, 150_000],
    ]);
    expect(new Set(candidates.map((c) => c.key)).size).toBe(candidates.length);
  });

  it("keeps the same purchase key on two cards apart — a link names the account too", () => {
    const candidates = financingCandidatesFromLines([
      total({ statement_line_id: -1, account_id: 1 }),
      total({ statement_line_id: -2, account_id: 2 }),
    ]);
    expect(candidates.map((c) => [c.account_id, c.purchase_count])).toEqual([
      [1, 1],
      [2, 1],
    ]);
  });
});

describe("financedAccountsFromLines", () => {
  it("cards with purchase lines, in line order; months of their positive purchases, newest first", () => {
    const accounts = financedAccountsFromLines([
      line({ statement_line_id: 1, account_id: 3, origin_label: "0101", billing_month: "2026-01" }),
      line({ statement_line_id: 2, account_id: 2, origin_label: "0781", billing_month: "2026-02", pesos: -500 }),
      line({ statement_line_id: 3, account_id: 3, origin_label: "other", billing_month: "2026-03" }),
      line({ statement_line_id: 4, account_id: 3, billing_month: "2026-04", line_role: "installment_cuota" }),
    ]);
    expect(accounts).toEqual([
      { account_id: 3, label: "0101", billing_months: ["2026-03", "2026-01"] },
      { account_id: 2, label: "0781", billing_months: [] },
    ]);
  });
});

describe("cached expense list payloads", () => {
  it("serve what the line list gives, in the requested unit", () => {
    clearAggregationCache();
    const lines = buildFlowsExpenseLines();
    const unc = cachedFlowsExpenseLinesList("usd", { kind: "uncategorized", include_pre_tax: false });
    expect(unc.unit).toBe("usd");
    expect(unc.selector).toEqual({ kind: "uncategorized", include_pre_tax: false });
    expect(unc.lines.length).toBe(lines.filter((l) => l.pending_classification === true && !l.pre_tax).length);
    expect(unc.categories.length).toBeGreaterThan(0);
    expect(cachedFlowsExpenseLinesList("usd", { kind: "uncategorized", include_pre_tax: false })).toBe(unc);

    const summary = cachedFlowsExpensesSummary("clp");
    expect(summary.active_big_group_slugs).toEqual(
      [...new Set(lines.flatMap((l) => (l.big_group_slug ? [l.big_group_slug] : [])))].sort()
    );

    const fin = cachedFlowsExpensesFinancingCandidates("clp");
    expect(fin.candidates.length).toBe(
      new Set(lines.filter((l) => l.line_role === "installment_purchase_total").map((l) => `${l.account_id}|${l.purchase_key}`)).size
    );
    const months = fin.candidates.map((c) => c.purchase_month);
    expect(months).toEqual([...months].sort().reverse());
    for (const acc of fin.financed_accounts) {
      expect(acc.billing_months).toEqual([...acc.billing_months].sort().reverse());
    }
    expect(fin.financed_accounts.map((a) => a.account_id)).toEqual([
      ...new Set(lines.filter((l) => l.line_role === "purchase").map((l) => l.account_id)),
    ]);
  });
});

describe("paging the uncategorized list", () => {
  const unc = { kind: "uncategorized", include_pre_tax: false } as const;
  const pageRejects = (query: Record<string, unknown>, selector: Parameters<typeof parseExpenseLinesPage>[1]) => {
    let err: unknown;
    try {
      parseExpenseLinesPage(query, selector);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExpenseLinesRequestError);
    expect((err as ExpenseLinesRequestError).status).toBe(400);
  };

  it("pages only list=uncategorized, with defaults, and refuses bad values", () => {
    expect(parseExpenseLinesPage({}, unc)).toEqual({ page: 1, pageSize: UNCATEGORIZED_DEFAULT_PAGE_SIZE });
    expect(parseExpenseLinesPage({ page: "3", page_size: "25" }, unc)).toEqual({ page: 3, pageSize: 25 });
    expect(parseExpenseLinesPage({}, { kind: "month", period_month: "2026-03", include_pre_tax: false })).toBeNull();
    pageRejects({ page: "2" }, { kind: "month", period_month: "2026-03", include_pre_tax: false });
    pageRejects({ page_size: "10" }, { kind: "deposit_matched", include_pre_tax: false });
    pageRejects({ page: "0" }, unc);
    pageRejects({ page: "x" }, unc);
    pageRejects({ page_size: "101" }, unc);
    pageRejects({ page: ["1", "2"] }, unc);
  });

  it("orders largest in pesos first, then newest", () => {
    const row = (value_clp: number, occurred_on: string) => ({ value_clp, occurred_on });
    expect(
      sortLargestFirst([row(10, "2026-01-01"), row(50, "2026-01-01"), row(10, "2026-03-01"), row(30, "2026-02-01")])
    ).toEqual([row(50, "2026-01-01"), row(30, "2026-02-01"), row(10, "2026-03-01"), row(10, "2026-01-01")]);
  });

  it("slices pages of the cached list, clamps past the end and leaves the list as it was", () => {
    clearAggregationCache();
    const base = cachedFlowsExpenseLinesList("clp", { kind: "month", period_month: "2026-01", include_pre_tax: true });
    const lines = buildFlowsExpenseLines().slice(0, 5) as unknown as typeof base.lines;
    const list = { ...base, selector: unc, lines };
    const p1 = pageOfExpenseLinesList(list, { page: 1, pageSize: 2 });
    const p2 = pageOfExpenseLinesList(list, { page: 2, pageSize: 2 });
    expect(p1.lines).toEqual(lines.slice(0, 2));
    expect(p2.lines).toEqual(lines.slice(2, 4));
    expect(p1.page).toEqual({ page: 1, page_size: 2, total: 5 });
    const last = pageOfExpenseLinesList(list, { page: 99, pageSize: 2 });
    expect(last.page).toEqual({ page: 3, page_size: 2, total: 5 });
    expect(last.lines).toEqual(lines.slice(4));
    expect(pageOfExpenseLinesList({ ...list, lines: [] }, { page: 4, pageSize: 2 }).page).toEqual({ page: 1, page_size: 2, total: 0 });
    expect(list.lines).toBe(lines);
    expect("page" in list).toBe(false);
  });
});
