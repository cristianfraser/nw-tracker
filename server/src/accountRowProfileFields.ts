/**
 * What a dashboard account row says about its account beyond the figures (docs/untangle-plan.md
 * F12): its short card label, whether it has a Rentabilidad table, and the loan of a property. The
 * client used to derive each one (`navAccountLabels.ts`, `mayHavePeriodReturns`, a mortgage
 * matched by name); it now picks these fields. Pure: the row builder passes the account facts.
 */

export type AccountRowProfileFields = {
  /** The short label the strip cards and breakdowns show (brokerage and retirement short names). */
  nav_label: string;
  /** The account page draws a Rentabilidad table (the server computes `period_returns` for it). */
  has_period_returns: boolean;
  /** A property's loan (the mortgage whose balance its net equity is net of); null otherwise. */
  loan_account_id: number | null;
};

type RowAccount = { name: string; notes: string | null; kind: string; dashboardBucket: string | null };

function brokerageNavLabel(a: RowAccount): string {
  switch (a.kind) {
    case "fintual_risky_norris":
      return a.notes?.startsWith("import:fintual|cert|key=") ? a.name : "risky norris";
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

function retirementNavLabel(a: RowAccount): string {
  if (a.kind === "apv") {
    if (a.notes === "import:excel|key=apv_a_principal") return "apv-a-principal";
    if (a.notes === "import:excel|key=apv_a") return "apv-a-fintual";
    if (a.notes === "import:excel|key=apv_b") return "apv-b-fintual";
  }
  return a.name;
}

/** The short label of an account on the strip cards and their breakdowns. */
export function accountNavLabel(a: RowAccount): string {
  if (a.dashboardBucket === "brokerage") return brokerageNavLabel(a);
  if (a.dashboardBucket === "retirement") return retirementNavLabel(a);
  return a.name;
}

/** Property kinds whose net equity is net of a loan (`loanAccountIdOfProperty`). */
export function isPropertyKind(kind: string): boolean {
  return kind === "property" || kind === "real_estate";
}

/** The account page header's units word, ticker and depto role, from the profile's facts. */
export function accountSummaryProfileFields(p: {
  kind: string;
  holding: { kind: string; ticker?: string; coin?: string };
}): { units_kind: "shares" | "coin"; ticker: string | null; depto_role: "property" | "loan" | null } {
  return {
    units_kind: p.holding.kind === "coin" ? "coin" : "shares",
    ticker: p.holding.kind === "stock" ? p.holding.ticker ?? null : p.holding.kind === "coin" ? p.holding.coin ?? null : null,
    depto_role: isPropertyKind(p.kind) ? "property" : p.kind === "mortgage" ? "loan" : null,
  };
}
