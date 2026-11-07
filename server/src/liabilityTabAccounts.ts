import { db } from "./db.js";
import { liabilityGroups } from "./navTreeModel.js";
import type { GroupTabAccountRow } from "./groupMonthlyPerfConsolidation.js";

/**
 * Pasivos tab rows: the accounts of the Pasivos groups (`liability_group_items`, attached to the nav
 * tree — every operational card master, the loans of the property), one group after the other,
 * each by id; `tabSubgroup` keeps one kind (`credit_card`, `mortgage`).
 */
export function listLiabilitiesTabAccountRows(tabSubgroup?: string): GroupTabAccountRow[] {
  const out: GroupTabAccountRow[] = [];
  const seen = new Set<number>();
  for (const group of liabilityGroups()) {
    if (tabSubgroup && group.liabilityKind !== tabSubgroup) continue;
    const ids = [...group.accountIds].filter((id) => !seen.has(id)).sort((a, b) => a - b);
    if (!ids.length) continue;
    const byId = new Map(
      (
        db
          .prepare(
            `SELECT a.id AS account_id, a.name, g.slug AS bucket_slug, a.notes AS notes, a.import_key,
                    a.exclude_from_group_totals AS exclude_from_group_totals
             FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id
             WHERE a.id IN (${ids.map(() => "?").join(",")})`
          )
          .all(...ids) as GroupTabAccountRow[]
      ).map((r) => [r.account_id, r])
    );
    for (const id of ids) {
      const r = byId.get(id);
      if (!r) continue;
      seen.add(id);
      out.push({ ...r, import_key: r.import_key ?? null });
    }
  }
  return out;
}
