/**
 * What a dashboard account row says about its account beyond the figures (docs/untangle-plan.md
 * F12): whether it has a Rentabilidad table, and the loan of a property. The client picks these
 * fields; it derives none of them. Pure: the row builder passes the account facts. A card line's
 * label is the row's `name` (until 2026-11-09 a `nav_label` field carried hardcoded lowercase
 * short names by kind slug — «spy», «risky norris», «apv-a-fintual»).
 */

export type AccountRowProfileFields = {
  /** The account page draws a Rentabilidad table (the server computes `period_returns` for it). */
  has_period_returns: boolean;
  /** A property's loan (the mortgage whose balance its net equity is net of); null otherwise. */
  loan_account_id: number | null;
};

/** Property kinds whose net equity is net of a loan (`loanAccountIdOfProperty`). */
export function isPropertyKind(kind: string): boolean {
  return kind === "property" || kind === "real_estate";
}

/** The account page header's units word and ticker, from the profile's holding. */
export function accountSummaryProfileFields(p: {
  holding: { kind: string; ticker?: string; coin?: string; occSymbol?: string };
}): { units_kind: "shares" | "coin" | "contracts"; ticker: string | null } {
  const h = p.holding;
  return {
    units_kind: h.kind === "coin" ? "coin" : h.kind === "option" ? "contracts" : "shares",
    ticker:
      h.kind === "stock" ? h.ticker ?? null : h.kind === "coin" ? h.coin ?? null : h.kind === "option" ? h.occSymbol ?? null : null,
  };
}
