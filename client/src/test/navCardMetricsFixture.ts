import { zeroNavCardMetrics } from "../placeholders/dashboardPagePlaceholders";
import type { NavCardAmountDto, NavCardMetricsDto } from "../types";

type ValueSpec =
  | number
  | {
      child?: number | NavCardAmountDto;
      parent?: number | NavCardAmountDto;
      members?: number | NavCardAmountDto;
      fx_missing?: boolean;
      sync_stale?: boolean;
    };

function amount(v: number | NavCardAmountDto | undefined, fallback: NavCardAmountDto): NavCardAmountDto {
  if (v == null) return fallback;
  return typeof v === "number" ? { clp: v, usd: null } : v;
}

/**
 * `card_metrics_by_slug` stand-in: zero metrics per slug, with the balances the server would
 * send (a bare number = the same CLP balance for child, parent and members).
 */
export function navCardMetricsFixture(
  values: Record<string, ValueSpec>,
  extra: Record<string, Partial<NavCardMetricsDto>> = {}
): Record<string, NavCardMetricsDto> {
  const out: Record<string, NavCardMetricsDto> = {};
  for (const slug of new Set([...Object.keys(values), ...Object.keys(extra)])) {
    const base = zeroNavCardMetrics("clp");
    const spec = values[slug];
    if (spec != null) {
      const all = typeof spec === "number" ? { clp: spec, usd: null } : undefined;
      const s = typeof spec === "number" ? {} : spec;
      const members = amount(s.members, all ?? base.value.members);
      base.value = {
        child: amount(s.child, all ?? members),
        parent: amount(s.parent, all ?? members),
        members,
        fx_missing: s.fx_missing ?? false,
        sync_stale: s.sync_stale ?? false,
      };
    }
    out[slug] = { ...base, ...extra[slug] };
  }
  return out;
}
