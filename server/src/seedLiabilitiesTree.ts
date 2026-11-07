import { db } from "./db.js";

import { accountsWithRole } from "./accountRoles.js";
import { listCreditCardMasterAccountIdsInNavOrder } from "./creditCardTree.js";

const upsertGroup = db.prepare(`
  INSERT INTO liability_groups (parent_id, slug, label, sort_order, label_i18n_key, route_path, liability_kind)
  VALUES (@parent_id, @slug, @label, @sort_order, @label_i18n_key, @route_path, @liability_kind)
  ON CONFLICT(slug) DO NOTHING
`);

const groupIdBySlug = db.prepare(`SELECT id FROM liability_groups WHERE slug = ?`);

const storedAccountItems = db.prepare(
  `SELECT id, account_id, sort_order FROM liability_group_items WHERE group_id = ? AND item_kind = 'account'`
);
const deleteItem = db.prepare(`DELETE FROM liability_group_items WHERE id = ?`);
const setItemSort = db.prepare(`UPDATE liability_group_items SET sort_order = ? WHERE id = ?`);
const insertAccountChild = db.prepare(`
  INSERT INTO liability_group_items (group_id, item_kind, account_id, sort_order)
  VALUES (?, 'account', ?, ?)
`);

/** The group's account items become `accountIds` (in that order); a member that stays keeps its row. */
function syncAccountItems(groupId: number, accountIds: readonly number[]): void {
  const sortOf = new Map(accountIds.map((id, i) => [id, i]));
  const have = new Set<number>();
  for (const r of storedAccountItems.all(groupId) as { id: number; account_id: number; sort_order: number }[]) {
    const sort = sortOf.get(r.account_id);
    if (sort == null) {
      deleteItem.run(r.id);
      continue;
    }
    have.add(r.account_id);
    if (r.sort_order !== sort) setItemSort.run(sort, r.id);
  }
  for (const [id, sort] of sortOf) if (!have.has(id)) insertAccountChild.run(groupId, id, sort);
}

/**
 * Idempotent Pasivos subtree (groups created when missing, never rewritten): tarjeta de crédito → every operational card master (superseded ones
 * left out; a nav-retired card stays a member, the nav tree hides it); hipoteca → the mortgage
 * master account.
 */
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
    syncAccountItems(ccGroupId, listCreditCardMasterAccountIdsInNavOrder());
    // Every loan of a property (`loan_of` role) sits under Pasivos › hipoteca.
    syncAccountItems(mtgGroupId, accountsWithRole("loan_of"));
  });
  tx();
}
