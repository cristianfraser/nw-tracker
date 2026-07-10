import { db } from "./db.js";
import { ensureMortgageLiabilityView } from "./liabilityTabAccounts.js";

const upsertGroup = db.prepare(`
  INSERT INTO liability_groups (parent_id, slug, label, sort_order, label_i18n_key, route_path, liability_kind)
  VALUES (@parent_id, @slug, @label, @sort_order, @label_i18n_key, @route_path, @liability_kind)
  ON CONFLICT(slug) DO UPDATE SET
    parent_id = excluded.parent_id,
    label = excluded.label,
    sort_order = excluded.sort_order,
    label_i18n_key = COALESCE(excluded.label_i18n_key, liability_groups.label_i18n_key),
    route_path = COALESCE(excluded.route_path, liability_groups.route_path),
    liability_kind = COALESCE(excluded.liability_kind, liability_groups.liability_kind)
`);

const groupIdBySlug = db.prepare(`SELECT id FROM liability_groups WHERE slug = ?`);

const deleteGroupItems = db.prepare(`DELETE FROM liability_group_items WHERE group_id = ?`);

const insertAccountChild = db.prepare(`
  INSERT INTO liability_group_items (group_id, item_kind, account_id, sort_order)
  VALUES (?, 'account', ?, ?)
  ON CONFLICT(group_id, account_id) DO UPDATE SET sort_order = excluded.sort_order
`);

const insertCreditCardGroupChild = db.prepare(`
  INSERT INTO liability_group_items (group_id, item_kind, child_credit_card_group_id, sort_order)
  VALUES (?, 'credit_card_group', ?, ?)
  ON CONFLICT(group_id, child_credit_card_group_id) DO UPDATE SET sort_order = excluded.sort_order
`);

/** Idempotent Pasivos subtree: CC issuer groups; mortgage leaf → liability_view or master. */
export function seedLiabilitiesTree(): void {
  const tx = db.transaction(() => {
    upsertGroup.run({
      parent_id: null,
      slug: "liabilities_credit_card",
      label: "Tarjeta de crédito",
      sort_order: 0,
      label_i18n_key: "liabilities.creditCard",
      route_path: "/liabilities/credit-card",
      liability_kind: "credit_card",
    });
    upsertGroup.run({
      parent_id: null,
      slug: "liabilities_mortgage",
      label: "Hipoteca",
      sort_order: 10,
      label_i18n_key: "liabilities.mortgage",
      route_path: "/liabilities/mortgage",
      liability_kind: "mortgage",
    });

    const ccGroupId = (groupIdBySlug.get("liabilities_credit_card") as { id: number }).id;
    const mtgGroupId = (groupIdBySlug.get("liabilities_mortgage") as { id: number }).id;
    deleteGroupItems.run(ccGroupId);
    deleteGroupItems.run(mtgGroupId);

    const ccIssuerGroups = db
      .prepare(`SELECT id, slug FROM credit_card_groups ORDER BY sort_order, id`)
      .all() as { id: number; slug: string }[];
    let ccSort = 0;
    for (const g of ccIssuerGroups) {
      insertCreditCardGroupChild.run(ccGroupId, g.id, ccSort++);
    }

    const mtgMaster = db
      .prepare(`SELECT id FROM accounts WHERE import_key = 'import:excel|key=mortgage' ORDER BY id LIMIT 1`)
      .get() as { id: number } | undefined;
    ensureMortgageLiabilityView();
    if (mtgMaster) {
      const mtgLeaf = db
        .prepare(
          `SELECT v.id FROM accounts v
           WHERE v.source_account_id = ? AND v.account_kind = 'liability_view'`
        )
        .get(mtgMaster.id) as { id: number } | undefined;
      insertAccountChild.run(mtgGroupId, mtgLeaf?.id ?? mtgMaster.id, 0);
    }
  });
  tx();
}
