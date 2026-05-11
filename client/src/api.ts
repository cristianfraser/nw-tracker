const base = () => import.meta.env.VITE_API_URL ?? "";

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  assetTree: () => j<import("./types").AssetTreeResponse>("/api/meta/asset-tree"),
  dashboard: (includeUsd?: boolean) =>
    j<import("./types").DashboardResponse>(
      includeUsd ? "/api/dashboard?include_usd=true" : "/api/dashboard"
    ),
  fxLatest: () => j<import("./types").FxLatest | null>("/api/fx/latest"),
  accountsByGroup: (groupSlug: string) =>
    j<{ accounts: import("./types").AccountListRow[] }>(`/api/accounts?group=${encodeURIComponent(groupSlug)}`),
  income: () => j<{ income: unknown[] }>("/api/income"),
  expenses: () => j<{ expenses: unknown[] }>("/api/expenses"),
};
