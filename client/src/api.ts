import { isHomeCurrency } from "nw-tracker-contracts/dto/apiConstants";
import i18n from "./i18n";
import type { DisplayUnit } from "./queries/keys";
import { attachLiveInputs, LIVE_INPUTS_HEADER, parseLiveInputs, type LiveQuoteMoves } from "./liveInputs";

const base = () => import.meta.env.VITE_API_URL ?? "";

const API_HINT =
  "Start the API in another terminal: cd server && npm run dev (port 3001).";

/**
 * The hosted demo serves reads plus a few counted edits (server: `demoReadOnlyMiddleware`,
 * `demoWriteQuotaMiddleware`). Turn its sentinels — 403 `demo_read_only` for a closed edit, 429
 * `demo_write_limit` once a visitor's daily edits are spent — into a sentence instead of letting
 * the raw JSON body surface as the error. Translated at call time — never cache the result (the
 * language can change at runtime).
 */
function demoReadOnlyMessage(status: number, body: string): string | null {
  if (status === 403 && body.includes("demo_read_only")) return i18n.t("demo.readOnly");
  if (status === 429 && body.includes("demo_write_limit")) return i18n.t("demo.writable.limitReached");
  return null;
}

/**
 * Route errors reach the client as `{ "error": "<message>" }` (server terminal error
 * middleware and most explicit 4xx answers). Surface the message itself, not the JSON text;
 * any other body shape is shown as-is.
 */
export function apiErrorMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed != null && typeof parsed === "object") {
      const error = (parsed as { error?: unknown }).error;
      if (typeof error === "string" && error.trim() !== "") return error;
    }
  } catch {
    /* not JSON: the body is the message */
  }
  return body;
}

function isProbablyHtml(body: string) {
  const t = body.trimStart();
  return t.startsWith("<!") || t.startsWith("<html") || t.startsWith("<");
}

/**
 * The one request path: fetch, then one error rule for every route — the demo's read-only answer
 * as a sentence, an HTML page as the "start the API" hint, a JSON `{ error }` as its message.
 */
async function request(path: string, init: RequestInit): Promise<{ res: Response; text: string }> {
  const url = `${base()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin", ...init });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${API_HINT} (${msg})`, { cause: e });
  }
  const text = await res.text();
  if (!res.ok) {
    const trimmed = text.trim();
    const readOnly = demoReadOnlyMessage(res.status, trimmed);
    if (readOnly) throw new Error(readOnly);
    if (isProbablyHtml(text)) throw new Error(`${API_HINT} (HTTP ${res.status})`);
    throw new Error(trimmed ? apiErrorMessage(trimmed) : res.statusText);
  }
  return { res, text };
}

async function jForm<T>(path: string, form: FormData, method = "POST"): Promise<T> {
  const { text } = await request(path, { method, body: form });
  const trimmed = text.trim();
  if (trimmed === "") return undefined as T;
  return JSON.parse(trimmed) as T;
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const { res, text } = await request(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const trimmed = text.trim();
  if (res.status === 204 || trimmed === "") {
    return undefined as T;
  }

  const ct = res.headers.get("content-type") ?? "";
  if (isProbablyHtml(text) || (ct.includes("text/html") && !ct.includes("json"))) {
    throw new Error(API_HINT);
  }

  let parsed: T;
  try {
    parsed = JSON.parse(text) as T;
  } catch {
    throw new Error(
      `${API_HINT} Response was not JSON (starts with: ${trimmed.slice(0, 60).replace(/\s+/g, " ")}…)`
    );
  }
  return attachLiveInputs(parsed, parseLiveInputs(res.headers.get(LIVE_INPUTS_HEADER)));
}

export const api = {
  sidebarNav: () => j<import("./types").SidebarNavResponse>("/api/meta/sidebar-nav"),
  panelNetWorthTree: () =>
    j<{ net_worth: import("./types").NavTreeNodeDto | null }>("/api/meta/panel-net-worth-tree"),
  accountsAll: () => j<{ accounts: import("./types").AccountListRow[] }>("/api/accounts"),
  createAccount: (body: import("./panelAccounts/panelAccountFormTypes").PanelAccountCreateBody) =>
    j<{
      account_id: number;
      asset_group_id: number;
      created_leaf_bucket: boolean;
      ticker: string | null;
    }>("/api/accounts", { method: "POST", body: JSON.stringify(body) }),
  deleteAccount: (id: number) => j<{ ok: boolean; deleted: number }>(`/api/accounts/${id}`, { method: "DELETE" }),
  updateAccount: (id: number, body: { name?: string; bucket_slug?: string }) =>
    j<{
      account_id: number;
      name: string;
      asset_group_id: number;
      bucket_slug: string;
      created_leaf_bucket: boolean;
    }>(`/api/accounts/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  updateAccountColor: (id: number, color_rgb: string | null) =>
    j<{ color_rgb: string | null; color: string }>(`/api/accounts/${id}/color`, {
      method: "PATCH",
      body: JSON.stringify({ color_rgb }),
    }),
  updateAccountExcludeFromGroupTotals: (id: number, exclude_from_group_totals: boolean) =>
    j<{ exclude_from_group_totals: 0 | 1 }>(`/api/accounts/${id}/exclude-from-group-totals`, {
      method: "PATCH",
      body: JSON.stringify({ exclude_from_group_totals }),
    }),
  updatePortfolioGroupColor: (slug: string, color_rgb: string | null) =>
    j<{ color_rgb: string | null; color: string }>(`/api/portfolio-groups/${slug}/color`, {
      method: "PATCH",
      body: JSON.stringify({ color_rgb }),
    }),
  updateLiabilityGroupColor: (slug: string, color_rgb: string | null) =>
    j<{ color_rgb: string | null; color: string }>(`/api/liability-groups/${slug}/color`, {
      method: "PATCH",
      body: JSON.stringify({ color_rgb }),
    }),
  ratesInstruments: () => j<import("./types").RatesInstrumentsResponse>("/api/meta/rates-instruments"),
  currencies: () => j<import("./types").CurrenciesResponse>("/api/currencies"),
  dashboardNavSnapshot: (unit: DisplayUnit) => {
    const q = new URLSearchParams();
    if (!isHomeCurrency(unit)) q.set("unit", unit);
    const qs = q.toString();
    return j<import("./types").DashboardNavSnapshotResponse>(
      `/api/dashboard/nav-snapshot${qs ? `?${qs}` : ""}`
    );
  },
  /** `root`: the page's nav node slug; the payload covers that page's strip only. */
  dashboardNavContext: (unit: DisplayUnit, root: string) => {
    const q = new URLSearchParams();
    if (!isHomeCurrency(unit)) q.set("unit", unit);
    q.set("root", root);
    return j<import("./types").DashboardNavContextResponse>(`/api/dashboard/nav-context?${q}`);
  },
  dashboardPageBundle: (unit: DisplayUnit) => {
    const q = new URLSearchParams();
    if (!isHomeCurrency(unit)) q.set("unit", unit);
    const qs = q.toString();
    return j<import("./types").DashboardPageBundleResponse>(`/api/dashboard/page-bundle${qs ? `?${qs}` : ""}`);
  },
  dashboardOverviewDaily: (unit: DisplayUnit, days: number) => {
    const q = new URLSearchParams();
    if (!isHomeCurrency(unit)) q.set("unit", unit);
    q.set("days", String(days));
    return j<import("./types").DashboardOverviewDailyResponse>(
      `/api/dashboard/overview-daily?${q.toString()}`
    );
  },
  inversionesPerfDaily: (unit: DisplayUnit, days: number) => {
    const q = new URLSearchParams();
    if (!isHomeCurrency(unit)) q.set("unit", unit);
    q.set("days", String(days));
    return j<import("./types").InversionesPerfDailyResponse>(
      `/api/dashboard/inversiones-perf-daily?${q.toString()}`
    );
  },
  dailySeries: (
    unit: DisplayUnit,
    scope: { portfolioGroup?: string; accountId?: number },
    days: number,
    opts?: { perfLevels?: boolean }
  ) => {
    const q = new URLSearchParams();
    if (!isHomeCurrency(unit)) q.set("unit", unit);
    if (scope.portfolioGroup) q.set("portfolio_group", scope.portfolioGroup);
    if (scope.accountId != null) q.set("account_id", String(scope.accountId));
    q.set("days", String(days));
    if (opts?.perfLevels) q.set("perf_levels", "1");
    return j<import("./types").DailySeriesResponse>(`/api/daily-series?${q.toString()}`);
  },
  valuationTimeseries: (
    unit: DisplayUnit,
    opts?: { portfolio_group?: string; group?: string; subgroup?: string }
  ) => {
    const q = new URLSearchParams();
    if (!isHomeCurrency(unit)) q.set("unit", unit);
    if (opts?.portfolio_group) q.set("portfolio_group", opts.portfolio_group);
    if (opts?.group) q.set("group", opts.group);
    if (opts?.subgroup) q.set("subgroup", opts.subgroup);
    const qs = q.toString();
    return j<import("./types").ValuationTimeseriesResponse>(
      `/api/dashboard/valuation-timeseries${qs ? `?${qs}` : ""}`
    );
  },
  accountsByPortfolioGroup: (portfolioGroup: string, unit: DisplayUnit = "clp") => {
    const q = new URLSearchParams();
    q.set("portfolio_group", portfolioGroup);
    if (!isHomeCurrency(unit)) q.set("unit", unit);
    const qs = q.toString();
    return j<{ accounts: import("./types").AccountListRow[] }>(`/api/accounts?${qs}`);
  },
  portfolioGroupCcLedger: (slug: string) =>
    j<import("./types").PortfolioGroupCcLedgerResponse>(
      `/api/portfolio-groups/${encodeURIComponent(slug)}/cc-ledger`
    ),
  portfolioGroupMortgageLedger: (slug: string, loanAccountId: number | null) =>
    j<import("./types").PortfolioGroupMortgageLedgerResponse>(
      `/api/portfolio-groups/${encodeURIComponent(slug)}/mortgage-ledger${
        loanAccountId != null ? `?account_id=${loanAccountId}` : ""
      }`
    ),
  creditCardConfig: (id: string | number) =>
    j<{ config: import("./types").CreditCardAccountConfigDto }>(
      `/api/accounts/${id}/credit-card-config`
    ),
  patchCreditCardConfig: (
    id: string | number,
    body: import("./types").CreditCardConfigPatchBody
  ) =>
    j<{ config: import("./types").CreditCardAccountConfigDto }>(
      `/api/accounts/${id}/credit-card-config`,
      { method: "PATCH", body: JSON.stringify(body) }
    ),
  deleteCcPurchase: (id: string | number, purchaseId: number) =>
    j<{ ok: boolean }>(`/api/accounts/${id}/cc-purchases/${purchaseId}`, { method: "DELETE" }),
  updateCcPurchaseCuotas: (id: number, purchaseId: number, cuotas_totales: number) =>
    j<{ ok: boolean }>(`/api/accounts/${id}/cc-purchases/${purchaseId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cuotas_totales }),
    }),
  deleteCcStatementLine: (id: string | number, lineId: number) =>
    j<{ ok: boolean }>(`/api/accounts/${id}/cc-statement-lines/${lineId}`, { method: "DELETE" }),
  annulCcPurchase: (id: string | number, lineId: number, annulledOn: string) =>
    j<{ ok: boolean; annulled_purchase_id: number }>(`/api/accounts/${id}/annulled-purchases`, {
      method: "POST",
      body: JSON.stringify({ line_id: lineId, annulled_on: annulledOn }),
      headers: { "Content-Type": "application/json" },
    }),
  undoCcAnnulledPurchase: (id: string | number, annulId: number) =>
    j<{ ok: boolean }>(`/api/accounts/${id}/annulled-purchases/${annulId}`, { method: "DELETE" }),
  makeStatementLineInstallment: (id: string | number, lineId: number, cuotas_totales: number) =>
    j<{ ok: boolean; purchase_id: number }>(
      `/api/accounts/${id}/cc-statement-lines/${lineId}/make-installment`,
      { method: "POST", body: JSON.stringify({ cuotas_totales }), headers: { "Content-Type": "application/json" } }
    ),
  accountMonthlyPerformance: (id: string | number, unit: DisplayUnit) => {
    const q = !isHomeCurrency(unit) ? `?unit=${encodeURIComponent(unit)}` : "";
    return j<import("./types").AccountMonthlyPerformanceResponse>(
      `/api/accounts/${id}/performance-monthly${q}`
    );
  },
  putCheckingLedgerAnchor: (
    id: string | number,
    body: { amount_clp: number; occurred_on: string } | { clear: true }
  ) =>
    j<{
      ledger_anchor: import("./types").CheckingLedgerAnchorDto | null;
      cartola_derived_anchor: import("./types").CartolaDerivedAnchorDto | null;
    }>(`/api/accounts/${id}/checking-ledger-anchor`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  accountImportSpecs: (id: string | number) =>
    j<{
      account_id: number;
      category_slug: string | null;
      document_imports: { type: string; labelKey: string; accept: string }[];
      supports_cc_web_paste: boolean;
      supports_cc_statement_pdf: boolean;
      supports_checking_recent_xlsx: boolean;
      supports_checking_cartola_xlsx: boolean;
      supports_cuenta_vista_web_paste: boolean;
    }>(`/api/accounts/${id}/import-specs`),
  importCcWebPaste: (id: string | number, text: string) =>
    j<Record<string, unknown>>(`/api/accounts/${id}/imports/cc-web-paste`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  importCuentaVistaWebPaste: (id: string | number, text: string) =>
    j<Record<string, unknown>>(`/api/accounts/${id}/imports/cuenta-vista-web-paste`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  importCcStatementPdf: (
    id: string | number,
    files: Record<string, File | undefined>
  ) => {
    const form = new FormData();
    if (files.clp) form.append("clp", files.clp);
    if (files.usd) form.append("usd", files.usd);
    return jForm<Record<string, unknown>>(`/api/accounts/${id}/imports/cc-statement-pdf`, form);
  },
  importCheckingRecentXlsx: (id: string | number, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return jForm<Record<string, unknown>>(
      `/api/accounts/${id}/imports/checking-recent-xlsx`,
      form
    );
  },
  importCheckingCartolaXlsx: (id: string | number, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return jForm<Record<string, unknown>>(
      `/api/accounts/${id}/imports/checking-cartola-xlsx`,
      form
    );
  },
  importAccountDocument: (id: string | number, type: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    form.append("type", type);
    return jForm<Record<string, unknown>>(`/api/accounts/${id}/imports/document`, form);
  },
  groupConsolidatedTables: (slug: string, unit: DisplayUnit, subgroup?: string) => {
    const q = new URLSearchParams();
    if (!isHomeCurrency(unit)) q.set("unit", unit);
    if (subgroup) q.set("subgroup", subgroup);
    const qs = q.toString();
    return j<import("./types").GroupConsolidatedTablesResponse>(
      `/api/groups/${encodeURIComponent(slug)}/consolidated-tables${qs ? `?${qs}` : ""}`
    );
  },
  groupPeriodReturns: (slug: string, unit: DisplayUnit) =>
    j<import("./types").GroupPeriodReturnsResponse>(
      `/api/groups/${encodeURIComponent(slug)}/period-returns${!isHomeCurrency(unit) ? `?unit=${encodeURIComponent(unit)}` : ""}`
    ),
  latestMovements: (limit: number, unit: DisplayUnit) =>
    j<import("./types").LatestMovementsResponse>(
      `/api/dashboard/latest-movements?${new URLSearchParams({ limit: String(limit), unit }).toString()}`
    ),
  groupConsolidatedMonthly: (
    slug: string,
    unit: DisplayUnit,
    opts: { page?: number; pageSize?: number; period?: "month" | "year"; installmentMode?: "split" | "total" }
  ) => {
    const q = new URLSearchParams();
    if (!isHomeCurrency(unit)) q.set("unit", unit);
    if (opts.period === "year") q.set("period", "year");
    if (opts.installmentMode) q.set("installment_mode", opts.installmentMode);
    if (opts.page) q.set("page", String(opts.page));
    if (opts.pageSize) q.set("page_size", String(opts.pageSize));
    const qs = q.toString();
    return j<import("./types").GroupConsolidatedMonthlyPageResponse>(
      `/api/groups/${encodeURIComponent(slug)}/consolidated-monthly${qs ? `?${qs}` : ""}`
    );
  },
  accountDetailBundle: (
    id: string | number,
    unit: DisplayUnit,
    opts?: { granularity?: "monthly" | "daily" }
  ) => {
    const q = new URLSearchParams();
    if (!isHomeCurrency(unit)) q.set("unit", unit);
    if (opts?.granularity === "daily") q.set("granularity", "daily");
    const qs = q.toString();
    return j<import("./types").AccountDetailBundleResponse>(
      `/api/accounts/${id}/detail-bundle${qs ? `?${qs}` : ""}`
    );
  },
  groupFlows: (
    slug: string,
    opts: {
      page?: number;
      pageSize?: number;
      year?: string;
      type?: string;
      account_id?: number;
      bucket?: string;
      q?: string;
      date_from?: string;
      date_to?: string;
      amount_min?: number;
      amount_max?: number;
      amount_exact?: number;
      amount_currency?: string;
      exclude_spending?: boolean;
    }
  ) => {
    const qu = new URLSearchParams();
    if (opts.page) qu.set("page", String(opts.page));
    if (opts.pageSize) qu.set("page_size", String(opts.pageSize));
    if (opts.year) qu.set("year", opts.year);
    if (opts.type) qu.set("type", opts.type);
    if (opts.exclude_spending) qu.set("exclude_spending", "1");
    if (opts.account_id != null) qu.set("account_id", String(opts.account_id));
    if (opts.bucket) qu.set("bucket", opts.bucket);
    if (opts.q) qu.set("q", opts.q);
    for (const key of ["date_from", "date_to"] as const) {
      if (opts[key]) qu.set(key, opts[key]!);
    }
    for (const key of ["amount_min", "amount_max", "amount_exact"] as const) {
      if (opts[key] != null) qu.set(key, String(opts[key]));
    }
    if (opts.amount_currency) qu.set("amount_currency", opts.amount_currency);
    const qs = qu.toString();
    return j<import("./types").FlowsPageResponse>(
      `/api/groups/${encodeURIComponent(slug)}/flows${qs ? `?${qs}` : ""}`
    );
  },
  accountFlows: (
    id: string | number,
    opts: {
      page?: number;
      pageSize?: number;
      year?: string;
      type?: string;
      q?: string;
      personal_only?: boolean;
      date_from?: string;
      date_to?: string;
      amount_min?: number;
      amount_max?: number;
      amount_exact?: number;
      amount_currency?: string;
    }
  ) => {
    const qu = new URLSearchParams();
    if (opts.page) qu.set("page", String(opts.page));
    if (opts.pageSize) qu.set("page_size", String(opts.pageSize));
    if (opts.year) qu.set("year", opts.year);
    if (opts.type) qu.set("type", opts.type);
    if (opts.q) qu.set("q", opts.q);
    if (opts.personal_only) qu.set("personal_only", "1");
    for (const key of ["date_from", "date_to"] as const) {
      if (opts[key]) qu.set(key, opts[key]!);
    }
    for (const key of ["amount_min", "amount_max", "amount_exact"] as const) {
      if (opts[key] != null) qu.set(key, String(opts[key]));
    }
    if (opts.amount_currency) qu.set("amount_currency", opts.amount_currency);
    const qs = qu.toString();
    return j<import("./types").FlowsPageResponse>(
      `/api/accounts/${id}/flows${qs ? `?${qs}` : ""}`
    );
  },
  groupMonthlyPerformance: (slug: string, unit: DisplayUnit, subgroup?: string) => {
    const q = new URLSearchParams();
    if (!isHomeCurrency(unit)) q.set("unit", unit);
    if (subgroup) q.set("subgroup", subgroup);
    const qs = q.toString();
    return j<import("./types").GroupMonthlyPerformanceResponse>(
      `/api/groups/${encodeURIComponent(slug)}/performance-monthly${qs ? `?${qs}` : ""}`
    );
  },
  createAccountMovement: (id: string | number, body: Record<string, unknown>) =>
    j<{ id: number; units_delta: number | null; flow_kind?: string }>(
      `/api/accounts/${id}/movements`,
      { method: "POST", body: JSON.stringify(body) }
    ),
  previewMortgagePayment: (id: string | number, body: Record<string, unknown>) =>
    j<import("./types").MortgagePaymentPreviewResponse>(
      `/api/accounts/${id}/mortgage-payments/preview`,
      { method: "POST", body: JSON.stringify(body) }
    ),
  commitMortgagePayment: (id: string | number, body: Record<string, unknown>) =>
    j<import("./types").MortgagePaymentCommitResponse>(`/api/accounts/${id}/mortgage-payments`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  accountValuations: (id: string | number) =>
    j<{ valuations: { id: number; as_of_date: string; value: number; currency: string }[] }>(
      `/api/accounts/${id}/valuations`
    ),
  createAccountValuation: (
    id: string | number,
    body: { as_of_date: string; value_clp: number }
  ) =>
    j<{ ok: true }>(`/api/accounts/${id}/valuations`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  income: (unit: DisplayUnit) =>
    j<import("./types").FlowsIncomeResponse>(`/api/income?unit=${unit}`),
  patchWorkEarning: (
    id: number,
    body: {
      earning_type?: import("./types").PayrollEarningType;
      movement_id?: number | null;
    }
  ) =>
    j<import("./types").FlowWorkEarningRow>(`/api/work-earnings/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  patchIncomeMovement: (
    movementId: number,
    body: {
      income_kind?: import("./types").IncomeKind;
      rent_place_slug?: string;
      excluded?: boolean;
      force_include?: boolean;
      note?: string | null;
    }
  ) =>
    j<{
      movement_id: number;
      excluded: boolean;
      force_include: boolean;
      income_kind: import("./types").IncomeKind | null;
      note: string | null;
    }>(`/api/income/movements/${movementId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  forceIncludeIncomeMovement: (movementId: number) =>
    j<{ ok: true; movement_id: number; force_include: true }>(
      `/api/income/movements/${movementId}/force-include`,
      { method: "POST" }
    ),
  markIncomeRefund: (movementId: number, categorySlug?: string) =>
    j<{ ok: true; movement_id: number }>(`/api/income/movements/${movementId}/refund`, {
      method: "POST",
      body: JSON.stringify(categorySlug ? { category_slug: categorySlug } : {}),
    }),
  unmarkIncomeRefund: (movementId: number) =>
    j<{ ok: true; movement_id: number }>(`/api/income/movements/${movementId}/refund`, { method: "DELETE" }),
  restoreIncomeMovement: (movementId: number) =>
    j<{ ok: true; movement_id: number }>(
      `/api/income/movements/${movementId}/restore`,
      { method: "POST" }
    ),
  flowsDeposits: (unit: DisplayUnit) =>
    j<import("./types").FlowsDepositsResponse>(`/api/flows/deposits?unit=${encodeURIComponent(unit)}`),
  flowsPl: (unit: DisplayUnit, days?: number) => {
    const q = new URLSearchParams({ unit });
    if (days != null) q.set("days", String(days));
    return j<import("./types").FlowsPlResponse>(`/api/flows/pl?${q.toString()}`);
  },
  flowsOverview: (unit: DisplayUnit, installmentMode: "split" | "total", days?: number) => {
    const q = new URLSearchParams({ unit, installment_mode: installmentMode });
    if (days != null) q.set("days", String(days));
    return j<import("./types").FlowsOverviewResponse>(`/api/flows/overview?${q.toString()}`);
  },
  flowsDepositsReconciliation: (unit: DisplayUnit) =>
    j<import("./types").DepositsReconciliationPayload>(
      `/api/flows/deposits/reconciliation?unit=${encodeURIComponent(unit)}`
    ),
  flowsRealEstateExpenses: () =>
    j<import("./types").RealEstateExpensesResponse>("/api/flows/expenses/real-estate"),
  realEstateExpenseLinkCandidates: (expenseEntryId: number) =>
    j<{ candidates: import("./types").RealEstateLinkCandidateDto[] }>(
      `/api/flows/expenses/real-estate/candidates?expense_entry_id=${expenseEntryId}`
    ),
  linkRealEstateExpense: (body: { expense_entry_id: number; purchase_key: string }) =>
    j<import("./types").RealEstateExpenseLinkDto>("/api/flows/expenses/real-estate/links", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  unmatchRealEstateExpense: (expenseEntryId: number) =>
    j<void>(`/api/flows/expenses/real-estate/links/${expenseEntryId}`, { method: "DELETE" }),
  realEstateUnlinkedPurchases: (params: {
    q?: string;
    place?: string;
    kind?: string;
    category?: string;
  }) => {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v) usp.set(k, v);
    }
    return j<{ purchases: import("./types").RealEstateUnlinkedPurchaseDto[] }>(
      `/api/flows/expenses/real-estate/unlinked-purchases?${usp.toString()}`
    );
  },
  createRealEstatePlace: (body: {
    slug: string;
    label: string;
    active_from?: string | null;
    active_to?: string | null;
    property_account_id?: number | null;
    dfl2?: boolean;
    dfl2_built_m2?: number | null;
    dfl2_reception_year?: number | null;
  }) =>
    j<import("./types").RealEstatePlaceDto>("/api/flows/expenses/real-estate/places", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  setRealEstatePlaceDfl2: (
    slug: string,
    body: { dfl2: boolean; dfl2_built_m2: number | null; dfl2_reception_year: number | null }
  ) =>
    j<import("./types").RealEstatePlaceDto>(
      `/api/flows/expenses/real-estate/places/${encodeURIComponent(slug)}/dfl2`,
      { method: "PATCH", body: JSON.stringify(body) }
    ),
  incomeRentPlaces: () => j<import("./types").IncomeRentPlacesResponse>("/api/income/rent-places"),
  realEstatePropertyAccounts: () =>
    j<{ accounts: { id: number; name: string }[] }>(
      "/api/flows/expenses/real-estate/property-accounts"
    ),
  assignRealEstatePurchase: (body: {
    purchase_key: string;
    account_slug: import("./types").ExpenseApartmentSlug;
    kind: string;
    bill_month?: string;
  }) =>
    j<{ expense_entry_id: number }>("/api/flows/expenses/real-estate/assign", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateRealEstateMonthsCovered: (expenseEntryId: number, body: { months_covered: number }) =>
    j<void>(`/api/flows/expenses/real-estate/entries/${expenseEntryId}/months-covered`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  updateRealEstateBillMonth: (expenseEntryId: number, body: { bill_month: string }) =>
    j<void>(`/api/flows/expenses/real-estate/entries/${expenseEntryId}/bill-month`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  updateRealEstateConsumption: (
    expenseEntryId: number,
    body: { kwh: number | null; m3: number | null }
  ) =>
    j<void>(`/api/flows/expenses/real-estate/entries/${expenseEntryId}/consumption`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteRealEstateExpenseEntry: (expenseEntryId: number) =>
    j<void>(`/api/flows/expenses/real-estate/entries/${expenseEntryId}`, { method: "DELETE" }),
  /** Expense lines of one selector (a month, a facturación, a list, a big group), in `unit`. */
  flowsExpenseLines: (
    unit: DisplayUnit,
    selector: import("./types").FlowsExpenseLinesSelector,
    page?: { page: number; pageSize: number }
  ) => {
    const q = new URLSearchParams({ unit });
    switch (selector.kind) {
      case "month":
        q.set("month", selector.period_month);
        break;
      case "facturacion":
        q.set("account_id", String(selector.account_id));
        q.set("billing_month", selector.billing_month);
        break;
      case "uncategorized":
      case "deposit_matched":
        q.set("list", selector.kind);
        break;
      case "big_group":
        q.set("big_group", selector.slug);
        break;
    }
    if (selector.kind !== "facturacion" && selector.include_pre_tax) q.set("include_pre_tax", "1");
    if (page) {
      q.set("page", String(page.page));
      q.set("page_size", String(page.pageSize));
    }
    return j<import("./types").FlowsExpenseLinesResponse>(`/api/flows/expenses/lines?${q.toString()}`);
  },
  flowsExpensesSummary: (unit: DisplayUnit) =>
    j<import("./types").FlowsExpensesSummaryResponse>(
      `/api/flows/expenses/summary?unit=${encodeURIComponent(unit)}`
    ),
  flowsExpensesFinancingCandidates: (unit: DisplayUnit) =>
    j<import("./types").FlowsExpensesFinancingCandidatesResponse>(
      `/api/flows/expenses/financing-candidates?unit=${encodeURIComponent(unit)}`
    ),
  flowsExpensesGastos: (unit: DisplayUnit, excludedBigGroups: readonly string[], includePreTax: boolean) => {
    const q = new URLSearchParams({ unit });
    if (includePreTax) q.set("include_pre_tax", "1");
    if (excludedBigGroups.length > 0) q.set("exclude_big_groups", [...excludedBigGroups].sort().join(","));
    return j<import("./types").FlowsExpensesGastosResponse>(
      `/api/flows/expenses/gastos?${q.toString()}`
    );
  },
  assignCcExpenseLineCategory: (
    lineId: number,
    body: {
      unique: boolean;
      category_slug?: string;
      clear_category?: boolean;
      source?: import("./types").FlowCcExpenseLineSource;
      rule_link?: { kind: "receipt" | "app" | "recipient"; key: string } | null;
    }
  ) =>
    j<{ category_slug: string; unique: boolean; merchant_key: string; purchase_key: string }>(
      `/api/flows/expenses/lines/${lineId}/category`,
      { method: "PATCH", body: JSON.stringify(body) }
    ),
  patchCcExpensePurchaseNote: (body: {
    account_id: number;
    purchase_key?: string;
    statement_line_id?: number;
    notes: string;
  }) =>
    j<{ account_id: number; purchase_key: string; notes: string }>(
      "/api/flows/expenses/purchase-notes",
      { method: "PATCH", body: JSON.stringify(body) }
    ),
  expenseLinePieces: (source: "cc" | "checking", lineId: number) =>
    j<import("./types").ExpenseLinePieces>(
      `/api/flows/expenses/line-pieces?source=${source}&line_id=${lineId}`
    ),
  putExpenseLinePieces: (body: {
    source: "cc" | "checking";
    line_id: number;
    pieces: import("./types").ExpenseLinePiece[];
  }) =>
    j<import("./types").ExpenseLinePieces>("/api/flows/expenses/line-pieces", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  createManualExpense: (body: import("./types").ManualExpenseInput) =>
    j<{ id: number }>("/api/flows/expenses/manual", { method: "POST", body: JSON.stringify(body) }),
  updateManualExpense: (id: number, body: import("./types").ManualExpenseInput) =>
    j<{ ok: boolean }>(`/api/flows/expenses/manual/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteManualExpense: (id: number) =>
    j<void>(`/api/flows/expenses/manual/${id}`, { method: "DELETE" }),
  postVendorBranchChoice: (body: { key: string; display: string }) =>
    j<{ ok: boolean }>("/api/flows/expenses/vendor-branch-choice", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  putCcExpensePurchaseBigGroup: (body: { purchase_key: string; group_slug: string | null }) =>
    j<{ purchase_key: string; group_slug: string | null }>(
      "/api/flows/expenses/purchase-big-group",
      { method: "PUT", body: JSON.stringify(body) }
    ),
  createCcExpenseBigGroup: (label: string) =>
    j<import("./types").CcExpenseBigGroupDto>(
      "/api/flows/expenses/big-groups",
      { method: "POST", body: JSON.stringify({ label }) }
    ),
  renameCcExpenseBigGroup: (slug: string, label: string) =>
    j<import("./types").CcExpenseBigGroupDto>(
      `/api/flows/expenses/big-groups/${encodeURIComponent(slug)}`,
      { method: "PATCH", body: JSON.stringify({ label }) }
    ),
  deleteCcExpenseBigGroup: (slug: string) =>
    j<void>(
      `/api/flows/expenses/big-groups/${encodeURIComponent(slug)}`,
      { method: "DELETE" }
    ),
  ccFacturadoFinancingLinks: () =>
    j<{ links: import("./types").CcFacturadoFinancingLink[] }>(
      "/api/flows/expenses/financing-links"
    ),
  upsertCcFacturadoFinancingLink: (body: {
    financed_account_id: number;
    financed_billing_month: string;
    financing: { account_id: number; purchase_key: string }[];
  }) =>
    j<{ ok: boolean; id: number }>("/api/flows/expenses/financing-links", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  deleteCcFacturadoFinancingLink: (id: number) =>
    j<void>(`/api/flows/expenses/financing-links/${id}`, { method: "DELETE" }),
  // Equity closes and fund cuotas come back in the display unit; the rate series are facts.
  marketSeries: (unit: DisplayUnit) =>
    j<import("./types").MarketSeriesResponse>(
      !isHomeCurrency(unit) ? `/api/market-series?unit=${encodeURIComponent(unit)}` : "/api/market-series"
    ),
  mortgageUfReminder: () =>
    j<import("./types").MortgageUfReminder>("/api/reminders/mortgage-uf"),
  fxBidAskGaps: () => j<{ gaps: import("./types").FxBidAskGapRow[] }>("/api/fx/bid-ask/gaps"),
  upsertFxBidAsk: (date: string, buy_clp_per_usd: number, sell_clp_per_usd: number) =>
    j<{ ok: boolean }>("/api/fx/bid-ask", {
      method: "POST",
      body: JSON.stringify({ date, buy_clp_per_usd, sell_clp_per_usd }),
    }),
  liveQuotesStamp: (since: string | null) =>
    j<{ stamp: string | null; moves: LiveQuoteMoves | null; client_build: string | null }>(
      since == null ? "/api/live-quotes/stamp" : `/api/live-quotes/stamp?since=${encodeURIComponent(since)}`
    ),
  // Values come back in the display unit (server-side conversion); CLP is the default.
  marketTicker: (unit: DisplayUnit) =>
    j<import("./types").MarketTickerResponse>(
      !isHomeCurrency(unit) ? `/api/market-ticker?unit=${encodeURIComponent(unit)}` : "/api/market-ticker"
    ),
  watchlist: (unit: DisplayUnit) =>
    j<import("./types").WatchlistResponse>(!isHomeCurrency(unit) ? `/api/watchlist?unit=${encodeURIComponent(unit)}` : "/api/watchlist"),
  patchWatchlistRow: (id: number, body: { show_in_marquee?: number; sort_order?: number }) =>
    j<import("./types").WatchlistRow>(`/api/watchlist/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  searchWatchlistSymbols: (q: string) =>
    j<{ results: import("./types").WatchlistSymbolSearchResult[] }>(
      `/api/watchlist/search?q=${encodeURIComponent(q)}`
    ),
  addWatchlistTicker: (ticker: string) =>
    j<import("./types").WatchlistRow>("/api/watchlist", {
      method: "POST",
      body: JSON.stringify({ ticker }),
    }),
  deleteWatchlistRow: (id: number) =>
    j<{ ok: boolean }>(`/api/watchlist/${id}`, { method: "DELETE" }),
  messagesUnreadCount: () => j<{ count: number }>("/api/messages/unread-count"),
  messages: (kind: "notification" | "log") =>
    j<{ messages: AppMessageRow[] }>(`/api/messages?kind=${kind}`),
  usageReport: (days: import("./types").UsageReportWindow) =>
    j<import("./types").UsageReport>(`/api/usage/report?days=${days}`),
  usageEndpointTrend: (
    series: import("./types").UsageEndpointSeries,
    days: import("./types").UsageReportWindow
  ) =>
    j<import("./types").UsageEndpointTrend>(
      `/api/usage/endpoint-trend?${new URLSearchParams({ ...series, days: String(days) })}`
    ),
  markMessagesRead: () => j<{ marked: number }>("/api/messages/mark-read", { method: "POST" }),
  syncStatus: () => j<import("./types").SyncStatusResponse>("/api/sync/status"),
  syncForceStale: (source: import("./types").SyncSourceId) =>
    j<import("./types").SyncStatusResponse>("/api/sync/force-stale", {
      method: "POST",
      body: JSON.stringify({ source }),
    }),
  ingestRunsStatus: () => j<import("./types").IngestRunsStatusResponse>("/api/import-sync/ingest-runs"),
  startIngestRun: (kind: import("./types").IngestRunKind) =>
    j<import("./types").IngestRunsStatusResponse>("/api/import-sync/ingest-runs", {
      method: "POST",
      body: JSON.stringify({ kind }),
    }),
  jobQueue: () => j<import("./types").JobQueueResponse>("/api/import-sync/jobs"),
  cancelJob: (id: number) => j<import("./types").JobQueueResponse>(`/api/import-sync/jobs/${id}/cancel`, { method: "POST" }),
  retryJob: (id: number) => j<import("./types").JobQueueResponse>(`/api/import-sync/jobs/${id}/retry`, { method: "POST" }),
  importSyncDocumentCoverage: () =>
    j<import("./types").ImportSyncDocumentCoverageResponse>(
      "/api/import-sync/document-coverage"
    ),
  genericUniqueMerchants: () =>
    j<import("./types").GenericUniqueMerchantsResponse>(
      "/api/import-sync/generic-unique-merchants"
    ),
  createGenericUniqueMerchant: (merchant: string) =>
    j<import("./types").GenericUniqueMerchantMutationResponse>(
      "/api/import-sync/generic-unique-merchants",
      { method: "POST", body: JSON.stringify({ merchant }) }
    ),
  updateGenericUniqueMerchant: (id: number, merchant: string) =>
    j<import("./types").GenericUniqueMerchantMutationResponse>(
      `/api/import-sync/generic-unique-merchants/${id}`,
      { method: "PATCH", body: JSON.stringify({ merchant }) }
    ),
  deleteGenericUniqueMerchant: (id: number) =>
    j<void>(`/api/import-sync/generic-unique-merchants/${id}`, { method: "DELETE" }),
  projections: (unit: DisplayUnit, overrides: import("./projectionsOverrides").ProjectionOverrides) => {
    const qs = new URLSearchParams();
    if (!isHomeCurrency(unit)) qs.set("unit", unit);
    for (const [k, v] of Object.entries(overrides)) {
      if (v != null) qs.set(k, String(v));
    }
    const q = qs.toString();
    return j<import("./types").ProjectionsResponse>(`/api/projections${q ? `?${q}` : ""}`);
  },
  wealthPercentile: (unit: DisplayUnit) =>
    j<import("./types").WealthPercentileResponse>(
      !isHomeCurrency(unit) ? `/api/wealth-percentile?unit=${encodeURIComponent(unit)}` : "/api/wealth-percentile"
    ),
  benchmarks: () =>
    j<{ benchmarks: import("./types").BenchmarkOption[] }>("/api/benchmarks"),
  mortgagePrepaymentComparison: (accountId: number, benchmark: string, unit: DisplayUnit) =>
    j<import("./types").MortgagePrepaymentComparison | null>(
      `/api/mortgage-prepayment-comparison?${new URLSearchParams({
        account_id: String(accountId),
        benchmark,
        unit,
      }).toString()}`
    ),
  benchmarkComparison: (
    scope: { accountId: number } | { portfolioGroup: string },
    benchmark: string,
    unit: DisplayUnit
  ) => {
    const qs = new URLSearchParams({ benchmark, unit });
    if ("accountId" in scope) qs.set("account_id", String(scope.accountId));
    else qs.set("portfolio_group", scope.portfolioGroup);
    return j<import("./types").BenchmarkComparisonPayload | null>(
      `/api/benchmark-comparison?${qs.toString()}`
    );
  },
  taxResidency: () => j<{ periods: import("./types").TaxResidencyPeriodDto[] }>("/api/tax-residency"),
  declareTaxResidency: (body: { jurisdiction: import("./types").TaxJurisdiction; from: string; note: string | null }) =>
    j<import("./types").TaxResidencyPeriodDto>("/api/tax-residency", { method: "POST", body: JSON.stringify(body) }),
  deleteTaxResidency: (id: number) => j<void>(`/api/tax-residency/${id}`, { method: "DELETE" }),
  taxReturn: (taxYear: number | null) =>
    j<import("./types").TaxReturnResponse>(
      `/api/tax-return${taxYear != null ? `?tax_year=${taxYear}` : ""}`
    ),
  usTaxReturn: (taxYear: number) =>
    j<import("./types").UsTaxReturnResponse>(`/api/tax-return/us?tax_year=${taxYear}`),
  movementMirrorCandidates: () =>
    j<import("./types").MovementMirrorCandidatesResponse>("/api/movement-mirrors/candidates"),
  convertMovementMirrors: (pairs: import("./types").MirrorPairRef[]) =>
    j<{ converted: { transfer_movement_id: number }[] }>("/api/movement-mirrors/convert", {
      method: "POST",
      body: JSON.stringify({ pairs }),
    }),
  convertCcPaymentMirrors: (pairs: import("./types").CcPaymentMirrorRefDto[]) =>
    j<{ converted: { transfer_movement_id: number }[] }>(
      "/api/movement-mirrors/convert-cc-payments",
      { method: "POST", body: JSON.stringify({ pairs }) }
    ),
  rejectMovementMirrors: (pairs: import("./types").MirrorPairRef[]) =>
    j<{ rejected: number }>("/api/movement-mirrors/reject", {
      method: "POST",
      body: JSON.stringify({ pairs }),
    }),
  unrejectMovementMirrors: (pairs: import("./types").MirrorPairRef[]) =>
    j<{ removed: number }>("/api/movement-mirrors/unreject", {
      method: "POST",
      body: JSON.stringify({ pairs }),
    }),
  groceriesSummary: () => j<import("./types/groceries").GroceriesSummary>("/api/groceries/summary"),
  groceriesProductHistory: (productId: number) =>
    j<{
      rows: import("./types/groceries").ProductHistoryRow[];
      heterogeneous_packages: boolean;
    }>(`/api/groceries/products/${productId}/history`),
  groceriesReceiptItems: (receiptId: number) =>
    j<{ items: import("./types/groceries").GroceryReceiptItemRow[] }>(
      `/api/groceries/receipts/${receiptId}/items`
    ),
  groceriesProductDetail: (productId: number) =>
    j<import("./types/groceries").GroceryProductDetail>(`/api/groceries/products/${productId}`),
  groceriesUpdateProduct: (productId: number, body: { base_unit: string }) =>
    j<import("./types/groceries").GroceryProductDetail>(`/api/groceries/products/${productId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  groceriesMergeProduct: (productId: number, intoProductId: number) =>
    j<{ aliases_moved: number; items_restamped: number }>(
      `/api/groceries/products/${productId}/merge`,
      { method: "POST", body: JSON.stringify({ into_product_id: intoProductId }) }
    ),
  groceriesBrands: () =>
    j<{ brands: import("./types/groceries").GroceryBrandRow[] }>("/api/groceries/brands"),
  groceriesUpdateAlias: (
    aliasId: number,
    body: {
      brand_name?: string;
      brand_id?: number | null;
      content_value?: number | null;
      content_unit?: string;
    }
  ) =>
    j<{ ok: boolean }>(`/api/groceries/aliases/${aliasId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  groceriesClassify: (body: {
    store_chain: string;
    targets: { barcode: string | null; description: string }[];
    product_id?: number;
    new_product_name?: string;
  }) =>
    j<{ product_id: number; aliases: number; stamped: number }>("/api/groceries/classify", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

export type AppMessageRow = {
  id: number;
  kind: "notification" | "log";
  created_at: string;
  read_at: string | null;
  title: string;
  body: string;
};
