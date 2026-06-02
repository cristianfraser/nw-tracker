import type { PortfolioGroupBundle } from "../queries/fetchers";
import type { DisplayUnit } from "../queries/keys";

export function buildPlaceholderPortfolioGroupBundle(unit: DisplayUnit): PortfolioGroupBundle {
  const unitTs = unit === "usd" ? "usd" : "clp";
  return {
    accounts: [],
    ts: {
      unit: unitTs,
      accounts_in_group: { lines: [], points: [] },
      group_allocation_pie: [],
    },
    groupPerf: null,
  };
}
