const base = () => import.meta.env.VITE_API_URL ?? "";

const API_HINT =
  "Start the API in another terminal: cd server && npm run dev (port 3001).";

function isProbablyHtml(body: string) {
  const t = body.trimStart();
  return t.startsWith("<!") || t.startsWith("<html") || t.startsWith("<");
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
    throw new Error(`${API_HINT} (${msg})`);
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
  assetTree: () => j<import("./types").AssetTreeResponse>("/api/meta/asset-tree"),
  dashboard: (includeUsd?: boolean) =>
    j<import("./types").DashboardResponse>(
      includeUsd ? "/api/dashboard?include_usd=true" : "/api/dashboard"
    ),
  valuationTimeseries: (unit: "clp" | "usd", opts?: { group?: string; subgroup?: string }) => {
    const q = new URLSearchParams();
    if (unit === "usd") q.set("include_usd", "true");
    if (opts?.group) q.set("group", opts.group);
    if (opts?.subgroup) q.set("subgroup", opts.subgroup);
    const qs = q.toString();
    return j<import("./types").ValuationTimeseriesResponse>(
      `/api/dashboard/valuation-timeseries${qs ? `?${qs}` : ""}`
    );
  },
  brokerageFlows: (accountId: string | number) =>
    j<{
      flows: {
        id: number;
        occurred_on: string;
        flow_kind: string;
        amount_clp: number | null;
        amount_usd: number | null;
        ticker: string | null;
        note: string | null;
        units_delta: number | null;
      }[];
    }>(`/api/accounts/${accountId}/brokerage-flows`),
  ufLatest: () => j<import("./types").UfLatest | null>("/api/uf/latest"),
  fxLatest: () => j<import("./types").FxLatest | null>("/api/fx/latest"),
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
        flow_type: string;
        flow_type_label: string;
      }[];
    }>(`/api/accounts/${id}/movements`),
  income: () => j<{ income: unknown[] }>("/api/income"),
  expenses: () => j<{ expenses: unknown[] }>("/api/expenses"),
  flowsDeposits: () => j<import("./types").FlowsDepositsResponse>("/api/flows/deposits"),
  marketSeries: () => j<import("./types").MarketSeriesResponse>("/api/market-series"),
};
