const base = () => import.meta.env.VITE_API_URL ?? "";

const API_HINT =
  "Start the API in another terminal: cd server && npm run dev (port 3001).";

function isProbablyHtml(body: string) {
  const t = body.trimStart();
  return t.startsWith("<!") || t.startsWith("<html") || t.startsWith("<");
}

async function jForm<T>(path: string, form: FormData, method = "POST"): Promise<T> {
  const url = `${base()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, { method, body: form });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${API_HINT} (${msg})`, { cause: e });
  }
  const text = await res.text();
  const trimmed = text.trim();
  if (!res.ok) {
    if (isProbablyHtml(text)) throw new Error(`${API_HINT} (HTTP ${res.status})`);
    throw new Error(trimmed || res.statusText);
  }
  if (trimmed === "") return undefined as T;
  return JSON.parse(trimmed) as T;
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${base()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${API_HINT} (${msg})`, { cause: e });
  }

  const text = await res.text();
  const trimmed = text.trim();

  if (!res.ok) {
    if (isProbablyHtml(text)) {
      throw new Error(`${API_HINT} (HTTP ${res.status})`);
    }
    throw new Error(trimmed || res.statusText);
  }

  if (res.status === 204 || trimmed === "") {
    return undefined as T;
  }

  const ct = res.headers.get("content-type") ?? "";
  if (isProbablyHtml(text) || (ct.includes("text/html") && !ct.includes("json"))) {
    throw new Error(API_HINT);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `${API_HINT} Response was not JSON (starts with: ${trimmed.slice(0, 60).replace(/\s+/g, " ")}…)`
    );
  }
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
  portfolioTree: () => j<import("./types").PortfolioTreeResponse>("/api/meta/portfolio-tree"),
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
  ratesInstruments: () => j<import("./types").RatesInstrumentsResponse>("/api/meta/rates-instruments"),
  dashboard: (includeUsd?: boolean) =>
    j<import("./types").DashboardResponse>(
      includeUsd ? "/api/dashboard?include_usd=true" : "/api/dashboard"
    ),
  dashboardNavSnapshot: (unit: "clp" | "usd") => {
    const q = new URLSearchParams();
    if (unit === "usd") q.set("include_usd", "true");
    const qs = q.toString();
    return j<import("./types").DashboardNavSnapshotResponse>(
      `/api/dashboard/nav-snapshot${qs ? `?${qs}` : ""}`
    );
  },
  dashboardNavContext: (unit: "clp" | "usd") => {
    const q = new URLSearchParams();
    if (unit === "usd") q.set("include_usd", "true");
    const qs = q.toString();
    return j<import("./types").DashboardNavContextResponse>(
      `/api/dashboard/nav-context${qs ? `?${qs}` : ""}`
    );
  },
  dashboardPageBundle: (unit: "clp" | "usd") => {
    const q = new URLSearchParams();
    if (unit === "usd") q.set("include_usd", "true");
    const qs = q.toString();
    return j<import("./types").DashboardPageBundleResponse>(`/api/dashboard/page-bundle${qs ? `?${qs}` : ""}`);
  },
  valuationTimeseries: (
    unit: "clp" | "usd",
    opts?: { portfolio_group?: string; group?: string; subgroup?: string }
  ) => {
    const q = new URLSearchParams();
    if (unit === "usd") q.set("include_usd", "true");
    if (opts?.portfolio_group) q.set("portfolio_group", opts.portfolio_group);
    if (opts?.group) q.set("group", opts.group);
    if (opts?.subgroup) q.set("subgroup", opts.subgroup);
    const qs = q.toString();
    return j<import("./types").ValuationTimeseriesResponse>(
      `/api/dashboard/valuation-timeseries${qs ? `?${qs}` : ""}`
    );
  },
  fxLatest: () => j<import("./types").FxLatest | null>("/api/fx/latest"),
  accountsByPortfolioGroup: (portfolioGroup: string, unit: "clp" | "usd" = "clp") => {
    const q = new URLSearchParams();
    q.set("portfolio_group", portfolioGroup);
    if (unit === "usd") q.set("include_usd", "true");
    const qs = q.toString();
    return j<{ accounts: import("./types").AccountListRow[] }>(`/api/accounts?${qs}`);
  },
  accountsByGroup: (groupSlug: string, subgroup?: string) => {
    const q = new URLSearchParams();
    q.set("group", groupSlug);
    if (subgroup) q.set("subgroup", subgroup);
    return j<{ accounts: import("./types").AccountListRow[] }>(`/api/accounts?${q.toString()}`);
  },
  accountDepositInflows: (id: string | number) =>
    j<import("./types").AccountDepositInflowsResponse>(`/api/accounts/${id}/deposit-inflows`),
  accountMortgageLedger: (id: string | number) =>
    j<import("./types").AccountMortgageLedgerResponse>(`/api/accounts/${id}/mortgage-ledger`),
  accountCcInstallments: (id: string | number, extraOffsets?: Record<string, number>) => {
    const q = new URLSearchParams();
    if (extraOffsets && Object.keys(extraOffsets).length > 0) {
      q.set("extraOffsets", JSON.stringify(extraOffsets));
    }
    const qs = q.toString();
    return j<import("./types").AccountCcInstallmentsResponse>(
      `/api/accounts/${id}/cc-installments${qs ? `?${qs}` : ""}`
    );
  },
  portfolioGroupCcLedger: (slug: string, extraOffsets?: Record<string, number>) => {
    const q = new URLSearchParams();
    if (extraOffsets && Object.keys(extraOffsets).length > 0) {
      q.set("extraOffsets", JSON.stringify(extraOffsets));
    }
    const qs = q.toString();
    return j<import("./types").PortfolioGroupCcLedgerResponse>(
      `/api/portfolio-groups/${encodeURIComponent(slug)}/cc-ledger${qs ? `?${qs}` : ""}`
    );
  },
  portfolioGroupMortgageLedger: (slug: string) =>
    j<import("./types").PortfolioGroupMortgageLedgerResponse>(
      `/api/portfolio-groups/${encodeURIComponent(slug)}/mortgage-ledger`
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
  deleteCcStatementLine: (id: string | number, lineId: number) =>
    j<{ ok: boolean }>(`/api/accounts/${id}/cc-statement-lines/${lineId}`, { method: "DELETE" }),
  makeStatementLineInstallment: (id: string | number, lineId: number, cuotas_totales: number) =>
    j<{ ok: boolean; purchase_id: number }>(
      `/api/accounts/${id}/cc-statement-lines/${lineId}/make-installment`,
      { method: "POST", body: JSON.stringify({ cuotas_totales }), headers: { "Content-Type": "application/json" } }
    ),
  accountValuationTimeseries: (
    id: string | number,
    unit: "clp" | "usd",
    opts?: { granularity?: "monthly" | "daily" }
  ) => {
    const q = new URLSearchParams();
    if (unit === "usd") q.set("include_usd", "true");
    if (opts?.granularity === "daily") q.set("granularity", "daily");
    const qs = q.toString();
    return j<import("./types").AccountValuationTimeseriesResponse>(
      `/api/accounts/${id}/valuation-timeseries${qs ? `?${qs}` : ""}`
    );
  },
  accountSummary: (id: string | number) =>
    j<{
      account_id: number;
      category_slug: string | null;
      group_slug: string | null;
      group_label: string | null;
      group_peer_count: number | null;
      deposits_clp: number;
      withdrawals_clp: number;
      latest_valuation_clp: number | null;
      latest_valuation_date: string | null;
      position: import("./types").AccountPositionSnapshot | null;
    }>(`/api/accounts/${id}/summary`),
  accountMonthlyPerformance: (id: string | number, unit: "clp" | "usd") => {
    const q = unit === "usd" ? "?include_usd=true" : "";
    return j<import("./types").AccountMonthlyPerformanceResponse>(
      `/api/accounts/${id}/performance-monthly${q}`
    );
  },
  accountCheckingCartolaMonths: (id: string | number) =>
    j<import("./types").CheckingCartolaMonthsResponse>(
      `/api/accounts/${id}/checking-cartola-months`
    ),
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
  groupConsolidatedTables: (slug: string, unit: "clp" | "usd", subgroup?: string) => {
    const q = new URLSearchParams();
    if (unit === "usd") q.set("include_usd", "true");
    if (subgroup) q.set("subgroup", subgroup);
    const qs = q.toString();
    return j<import("./types").GroupConsolidatedTablesResponse>(
      `/api/groups/${encodeURIComponent(slug)}/consolidated-tables${qs ? `?${qs}` : ""}`
    );
  },
  groupConsolidatedMonthly: (
    slug: string,
    unit: "clp" | "usd",
    opts: { page?: number; pageSize?: number; period?: "month" | "year" }
  ) => {
    const q = new URLSearchParams();
    if (unit === "usd") q.set("include_usd", "true");
    if (opts.period === "year") q.set("period", "year");
    if (opts.page) q.set("page", String(opts.page));
    if (opts.pageSize) q.set("page_size", String(opts.pageSize));
    const qs = q.toString();
    return j<import("./types").GroupConsolidatedMonthlyPageResponse>(
      `/api/groups/${encodeURIComponent(slug)}/consolidated-monthly${qs ? `?${qs}` : ""}`
    );
  },
  accountDetailBundle: (
    id: string | number,
    unit: "clp" | "usd",
    opts?: { granularity?: "monthly" | "daily"; extraOffsets?: Record<string, number> }
  ) => {
    const q = new URLSearchParams();
    if (unit === "usd") q.set("include_usd", "true");
    if (opts?.granularity === "daily") q.set("granularity", "daily");
    if (opts?.extraOffsets && Object.keys(opts.extraOffsets).length > 0) {
      q.set("extraOffsets", JSON.stringify(opts.extraOffsets));
    }
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
      category?: string;
      q?: string;
      date_from?: string;
      date_to?: string;
      amount_min?: number;
      amount_max?: number;
      amount_exact?: number;
    }
  ) => {
    const qu = new URLSearchParams();
    if (opts.page) qu.set("page", String(opts.page));
    if (opts.pageSize) qu.set("page_size", String(opts.pageSize));
    if (opts.year) qu.set("year", opts.year);
    if (opts.type) qu.set("type", opts.type);
    if (opts.account_id != null) qu.set("account_id", String(opts.account_id));
    if (opts.category) qu.set("category", opts.category);
    if (opts.q) qu.set("q", opts.q);
    for (const key of ["date_from", "date_to"] as const) {
      if (opts[key]) qu.set(key, opts[key]!);
    }
    for (const key of ["amount_min", "amount_max", "amount_exact"] as const) {
      if (opts[key] != null) qu.set(key, String(opts[key]));
    }
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
    const qs = qu.toString();
    return j<import("./types").FlowsPageResponse>(
      `/api/accounts/${id}/flows${qs ? `?${qs}` : ""}`
    );
  },
  groupMonthlyPerformance: (slug: string, unit: "clp" | "usd", subgroup?: string) => {
    const q = new URLSearchParams();
    if (unit === "usd") q.set("include_usd", "true");
    if (subgroup) q.set("subgroup", subgroup);
    const qs = q.toString();
    return j<import("./types").GroupMonthlyPerformanceResponse>(
      `/api/groups/${encodeURIComponent(slug)}/performance-monthly${qs ? `?${qs}` : ""}`
    );
  },
  accountMovements: (id: string | number) =>
    j<{
      movements: {
        id: number;
        amount_clp: number;
        occurred_on: string;
        note: string | null;
        units_delta: number | null;
        flow_kind: string | null;
        amount_usd: number | null;
        ticker: string | null;
        flow_type: string;
        flow_type_label: string;
      }[];
    }>(`/api/accounts/${id}/movements`),
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
    j<{ valuations: { id: number; as_of_date: string; value_clp: number }[] }>(
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
  income: () => j<import("./types").FlowsIncomeResponse>("/api/income"),
  createIncome: (body: {
    amount_clp: number;
    received_on: string;
    source?: string | null;
    note?: string | null;
  }) =>
    j<{ id: number }>("/api/income", {
      method: "POST",
      body: JSON.stringify(body),
    }),
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
  restoreIncomeMovement: (movementId: number) =>
    j<{ ok: true; movement_id: number }>(
      `/api/income/movements/${movementId}/restore`,
      { method: "POST" }
    ),
  createExpense: (body: {
    amount_clp: number;
    spent_on: string;
    category: string;
    note?: string | null;
  }) =>
    j<{ id: number }>("/api/expenses", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  flowsDeposits: () => j<import("./types").FlowsDepositsResponse>("/api/flows/deposits"),
  flowsDepositsReconciliation: () =>
    j<import("./types").DepositsReconciliationPayload>("/api/flows/deposits/reconciliation"),
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
  flowsCreditCardExpenses: () =>
    j<import("./types").FlowsCreditCardExpensesResponse>("/api/flows/expenses/credit-card"),
  assignCcExpenseLineCategory: (
    lineId: number,
    body: {
      unique: boolean;
      category_slug?: string;
      clear_category?: boolean;
      source?: import("./types").FlowCcExpenseLineSource;
    }
  ) =>
    j<{ category_slug: string; unique: boolean; merchant_key: string; purchase_key: string }>(
      `/api/flows/expenses/credit-card/lines/${lineId}/category`,
      { method: "PATCH", body: JSON.stringify(body) }
    ),
  patchCcExpensePurchaseNote: (body: {
    account_id: number;
    purchase_key?: string;
    statement_line_id?: number;
    notes: string;
  }) =>
    j<{ account_id: number; purchase_key: string; notes: string }>(
      "/api/flows/expenses/credit-card/purchase-notes",
      { method: "PATCH", body: JSON.stringify(body) }
    ),
  putCcExpensePurchaseBigGroup: (body: {
    account_id: number;
    purchase_key: string;
    group_slug: string | null;
  }) =>
    j<{ account_id: number; purchase_key: string; group_slug: string | null }>(
      "/api/flows/expenses/credit-card/purchase-big-group",
      { method: "PUT", body: JSON.stringify(body) }
    ),
  createCcExpenseBigGroup: (label: string) =>
    j<import("./types").CcExpenseBigGroupDto>(
      "/api/flows/expenses/credit-card/big-groups",
      { method: "POST", body: JSON.stringify({ label }) }
    ),
  renameCcExpenseBigGroup: (slug: string, label: string) =>
    j<import("./types").CcExpenseBigGroupDto>(
      `/api/flows/expenses/credit-card/big-groups/${encodeURIComponent(slug)}`,
      { method: "PATCH", body: JSON.stringify({ label }) }
    ),
  deleteCcExpenseBigGroup: (slug: string) =>
    j<void>(
      `/api/flows/expenses/credit-card/big-groups/${encodeURIComponent(slug)}`,
      { method: "DELETE" }
    ),
  ccFacturadoFinancingLinks: () =>
    j<{ links: import("./types").CcFacturadoFinancingLink[] }>(
      "/api/flows/expenses/credit-card/financing-links"
    ),
  upsertCcFacturadoFinancingLink: (body: {
    financed_account_id: number;
    financed_billing_month: string;
    financing: { account_id: number; purchase_key: string }[];
  }) =>
    j<{ ok: boolean; id: number }>("/api/flows/expenses/credit-card/financing-links", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  deleteCcFacturadoFinancingLink: (id: number) =>
    j<void>(`/api/flows/expenses/credit-card/financing-links/${id}`, { method: "DELETE" }),
  marketSeries: () => j<import("./types").MarketSeriesResponse>("/api/market-series"),
  fxCoverage: () => j<import("./types").FxCoverage>("/api/fx/coverage"),
  fxBidAskGaps: () => j<{ gaps: import("./types").FxBidAskGapRow[] }>("/api/fx/bid-ask/gaps"),
  upsertFxBidAsk: (date: string, buy_clp_per_usd: number, sell_clp_per_usd: number) =>
    j<{ ok: boolean }>("/api/fx/bid-ask", {
      method: "POST",
      body: JSON.stringify({ date, buy_clp_per_usd, sell_clp_per_usd }),
    }),
  marketTicker: () => j<import("./types").MarketTickerResponse>("/api/market-ticker"),
  watchlist: () => j<import("./types").WatchlistResponse>("/api/watchlist"),
  patchWatchlistRow: (id: number, body: { show_in_marquee?: number; sort_order?: number }) =>
    j<import("./types").WatchlistRow>(`/api/watchlist/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
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
  markMessagesRead: () => j<{ marked: number }>("/api/messages/mark-read", { method: "POST" }),
  syncStatus: () => j<import("./types").SyncStatusResponse>("/api/sync/status"),
  syncForceStale: (source: import("./types").SyncSourceId) =>
    j<import("./types").SyncStatusResponse>("/api/sync/force-stale", {
      method: "POST",
      body: JSON.stringify({ source }),
    }),
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
  projections: (unit: "clp" | "usd", overrides: Partial<import("./types").ProjectionParams>) => {
    const qs = new URLSearchParams();
    if (unit === "usd") qs.set("unit", "usd");
    for (const [k, v] of Object.entries(overrides)) {
      if (v != null) qs.set(k, String(v));
    }
    const q = qs.toString();
    return j<import("./types").ProjectionsResponse>(`/api/projections${q ? `?${q}` : ""}`);
  },
  movementMirrorCandidates: () =>
    j<import("./types").MovementMirrorCandidatesResponse>("/api/movement-mirrors/candidates"),
  convertMovementMirrors: (pairs: import("./types").MirrorPairRef[]) =>
    j<{ converted: { transfer_movement_id: number }[] }>("/api/movement-mirrors/convert", {
      method: "POST",
      body: JSON.stringify({ pairs }),
    }),
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
};

export type AppMessageRow = {
  id: number;
  kind: "notification" | "log";
  created_at: string;
  read_at: string | null;
  title: string;
  body: string;
};
