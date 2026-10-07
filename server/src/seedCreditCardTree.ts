import { db } from "./db.js";
import { isSupersededSantanderCcMaster } from "./ccConsolidatedCards.js";
import { invalidateLinkedCreditCardAggregationCache } from "./aggregationCache.js";
import { CC_ISSUERS, ccMasterImportKeyPrefix } from "./ccIssuers.js";

const upsertGroup = db.prepare(`
  INSERT INTO credit_card_groups (parent_id, slug, label, sort_order, label_i18n_key, route_path)
  VALUES (@parent_id, @slug, @label, @sort_order, @label_i18n_key, @route_path)
  ON CONFLICT(slug) DO UPDATE SET
    parent_id = excluded.parent_id,
    label = excluded.label,
    sort_order = excluded.sort_order,
    label_i18n_key = COALESCE(excluded.label_i18n_key, credit_card_groups.label_i18n_key),
    route_path = excluded.route_path
`);

const groupIdBySlug = db.prepare(`SELECT id FROM credit_card_groups WHERE slug = ?`);

const deleteGroupItems = db.prepare(`DELETE FROM credit_card_group_items WHERE group_id = ?`);

const insertAccountChild = db.prepare(`
  INSERT INTO credit_card_group_items (group_id, item_kind, account_id, sort_order)
  VALUES (?, 'account', ?, ?)
  ON CONFLICT(group_id, account_id) DO UPDATE SET sort_order = excluded.sort_order
`);

function issuerGroupRoutePath(slug: string): string {
  return `/liabilities/credit-card/${slug}`;
}

/** Idempotent credit card issuer groups → master accounts (one per card_last4). */
export function seedCreditCardTree(): void {
  const tx = db.transaction(() => {
    for (const g of CC_ISSUERS) {
      const masters = db
        .prepare(`SELECT id FROM accounts WHERE import_key LIKE ? ORDER BY import_key`)
        .all(`${ccMasterImportKeyPrefix(g.slug)}%`) as { id: number }[];
      // An issuer without a card gets no page (the demo has no CMR card).
      if (masters.length === 0 && !groupIdBySlug.get(g.slug)) continue;
      upsertGroup.run({
        parent_id: null,
        slug: g.slug,
        label: g.label,
        sort_order: g.sort_order,
        label_i18n_key: g.label_i18n_key,
        route_path: issuerGroupRoutePath(g.slug),
      });

      const groupId = (groupIdBySlug.get(g.slug) as { id: number }).id;
      deleteGroupItems.run(groupId);

      let sort = 0;
      for (const { id } of masters) {
        if (isSupersededSantanderCcMaster(id)) continue;
        insertAccountChild.run(groupId, id, sort++);
      }
    }
  });
  tx();
  invalidateLinkedCreditCardAggregationCache();
}
