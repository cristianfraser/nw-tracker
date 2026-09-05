import type { AccountListRow, DashboardAccountRow } from "./types";

export function brokerageAccountNavLabel(a: AccountListRow): string {
  switch (a.category_slug) {
    case "fintual_risky_norris":
      if (a.notes?.startsWith("import:fintual|cert|key=")) return a.name;
      return "risky norris";
    case "spy":
      return "spy";
    case "vea":
      return "vea";
    case "bitcoin":
      return "bitcoin";
    case "eth":
      return "ether";
    default:
      return a.name;
  }
}

export function retirementAccountNavLabel(a: AccountListRow): string {
  if (a.category_slug === "apv") {
    if (a.notes === "import:excel|key=apv_a_principal") return "apv-a-principal";
    if (a.notes === "import:fintual|cert|key=apv_a") return a.name;
    if (a.notes === "import:fintual|cert|key=apv_b") return a.name;
    if (a.notes === "import:excel|key=apv_a") return "apv-a-fintual";
    if (a.notes === "import:excel|key=apv_b") return "apv-b-fintual";
  }
  return a.name;
}

function dashboardRowAsNavRow(a: DashboardAccountRow): AccountListRow {
  return {
    id: a.account_id,
    name: a.name,
    notes: a.notes ?? null,
    created_at: "",
    category_slug: a.category_slug ?? "",
    category_label: a.category_label,
    group_slug: a.group_slug,
    group_label: a.group_label,
    bucket_slug: a.bucket_slug,
    bucket_label: a.bucket_label,
  };
}

/** Nav-style card/breakdown label for a dashboard account row (brokerage/retirement short names). */
export function dashboardAccountNavLabel(row: DashboardAccountRow): string {
  const dash = row.dashboard_bucket_slug;
  if (dash === "brokerage") return brokerageAccountNavLabel(dashboardRowAsNavRow(row));
  if (dash === "retirement") return retirementAccountNavLabel(dashboardRowAsNavRow(row));
  return row.name;
}
