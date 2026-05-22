import { db } from "./db.js";

const upsertGroup = db.prepare(`
  INSERT INTO credit_card_groups (parent_id, slug, label, sort_order, label_i18n_key, route_path)
  VALUES (@parent_id, @slug, @label, @sort_order, @label_i18n_key, @route_path)
  ON CONFLICT(slug) DO UPDATE SET
    parent_id = excluded.parent_id,
    label = excluded.label,
    sort_order = excluded.sort_order,
    label_i18n_key = COALESCE(excluded.label_i18n_key, credit_card_groups.label_i18n_key),
    route_path = COALESCE(excluded.route_path, credit_card_groups.route_path)
`);

const groupIdBySlug = db.prepare(`SELECT id FROM credit_card_groups WHERE slug = ?`);

const deleteGroupItems = db.prepare(`DELETE FROM credit_card_group_items WHERE group_id = ?`);

const insertGroupChild = db.prepare(`
  INSERT INTO credit_card_group_items (group_id, item_kind, child_group_id, sort_order)
  VALUES (?, 'group', ?, ?)
  ON CONFLICT(group_id, child_group_id) DO UPDATE SET sort_order = excluded.sort_order
`);

const insertAccountChild = db.prepare(`
  INSERT INTO credit_card_group_items (group_id, item_kind, account_id, sort_order)
  VALUES (?, 'account', ?, ?)
  ON CONFLICT(group_id, account_id) DO UPDATE SET sort_order = excluded.sort_order
`);

/** Idempotent Santander credit card group → master accounts (one per card_last4). */
export function seedCreditCardTree(): void {
  const tx = db.transaction(() => {
    upsertGroup.run({
      parent_id: null,
      slug: "santander",
      label: "Santander",
      sort_order: 0,
      label_i18n_key: "creditCardGroup.santander",
      route_path: "/liabilities/credit-card",
    });

    const santanderId = (groupIdBySlug.get("santander") as { id: number }).id;
    deleteGroupItems.run(santanderId);

    const masters = db
      .prepare(
        `SELECT id FROM accounts
         WHERE notes LIKE 'credit_card_master|santander|%'
         ORDER BY notes`
      )
      .all() as { id: number }[];

    let sort = 0;
    for (const { id } of masters) {
      insertAccountChild.run(santanderId, id, sort++);
    }
  });
  tx();
}
