import { zeroNavCardMetrics } from "../placeholders/dashboardPagePlaceholders";
import type { NavCardMetricsDto } from "../types";

type ValueSpec =
  | number
  | {
      child?: number | null;
      parent?: number | null;
      members?: number | null;
      fx_missing?: boolean;
      sync_stale?: boolean;
    };

/**
 * `card_metrics_by_slug` stand-in: zero metrics per slug, with the balances the server would
 * send in the payload's unit (a bare number = the same balance for child, parent and members).
 */
export function navCardMetricsFixture(
  values: Record<string, ValueSpec>,
  extra: Record<string, Partial<NavCardMetricsDto>> = {}
): Record<string, NavCardMetricsDto> {
  const out: Record<string, NavCardMetricsDto> = {};
  for (const slug of new Set([...Object.keys(values), ...Object.keys(extra)])) {
    const base = zeroNavCardMetrics();
    const spec = values[slug];
    if (spec != null) {
      const all = typeof spec === "number" ? spec : undefined;
      const s = typeof spec === "number" ? {} : spec;
      const members = s.members !== undefined ? s.members : (all ?? base.value.members);
      base.value = {
        child: s.child !== undefined ? s.child : (all ?? members),
        parent: s.parent !== undefined ? s.parent : (all ?? members),
        members,
        fx_missing: s.fx_missing ?? false,
        sync_stale: s.sync_stale ?? false,
      };
    }
    out[slug] = { ...base, ...extra[slug] };
  }
  return out;
}
