import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./cacheRegistry.js";
import { stableInstallmentHPurchaseKeyFromLedgerArgs } from "./ccExpenseCategories.js";
import { db } from "./db.js";
import { installmentHKeyWithoutTotal } from "./expenseKeys.js";
import { getFlowCategory, putFlowCategory } from "./flows/flowCategories.js";
import { expenseKeyParts } from "./flows/flowKeyResolve.js";
import {
  applyLegacyInstallmentKeyRekey,
  planLegacyInstallmentKeyRekey,
} from "../scripts/lib/ccLegacyInstallmentKeyRekey.js";

/**
 * A hand-entered plan whose category was written before the `installment-h:` key carried the
 * plan's total: the re-key script moves it onto the current key, and refuses when the legacy key
 * could belong to another plan.
 */

const PREFIX = "vitest-legacy-rekey";
let ccId: number | null = null;
let categories: number[] = [];

function insertPlan(total: number, merchant = "VITEST LEGACY REKEY"): number {
  return Number(
    db
      .prepare(
        `INSERT INTO cc_installment_purchases (
           account_id, card_group, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales,
           merchant, description_merged, source
         ) VALUES (?, 'santander', ?, '2025-06-03', ?, 3, ?, ?, 'manual')`
      )
      .run(ccId, `${PREFIX}-${total}`, total, merchant, merchant).lastInsertRowid
  );
}

function keysOf(total: number): { current: string; legacy: string } {
  const current = stableInstallmentHPurchaseKeyFromLedgerArgs({
    accountId: ccId!,
    purchaseDateIso: "2025-06-03",
    cuotasTotales: 3,
    totalAmountClp: total,
    merchant: "VITEST LEGACY REKEY",
  })!;
  return { current, legacy: installmentHKeyWithoutTotal(current)! };
}

/** The pre-amount state: a flow answering to the identity-only key, holding a category. */
function seedLegacyCategory(planId: number, legacyKey: string, categoryId: number): void {
  const planFlow = (db.prepare(`SELECT flow_id FROM cc_installment_purchases WHERE id = ?`).get(planId) as { flow_id: number })
    .flow_id;
  const flowId = Number(
    db
      .prepare(
        `INSERT INTO flows (kind, from_account_id, to_account_id, from_party_id, to_party_id, occurred_on, amount, currency, description, legacy_key)
         SELECT kind, from_account_id, to_account_id, from_party_id, to_party_id, occurred_on, amount, currency, description, ?
         FROM flows WHERE id = ?`
      )
      .run(expenseKeyParts(legacyKey)!.flowKey, planFlow).lastInsertRowid
  );
  db.prepare(`INSERT INTO flow_categories (flow_id, account_id, category_id) VALUES (?, ?, ?)`).run(flowId, ccId, categoryId);
}

beforeAll(() => {
  const leaf = db
    .prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%__credit_card' OR slug LIKE 'credit_cards__%' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!leaf) throw new Error("no credit-card asset group in the test database");
  ccId = Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · legacy rekey card', ?, ?)`)
      .run(leaf.id, PREFIX, PREFIX).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO credit_card_account_config (account_id, card_last4, billing_cycle_start_day, billing_cycle_end_day, issuer)
     VALUES (?, '7772', 21, 20, 'santander')`
  ).run(ccId);
  categories = (db.prepare(`SELECT id FROM cc_expense_categories ORDER BY id LIMIT 2`).all() as { id: number }[]).map((r) => r.id);
  if (categories.length < 2) throw new Error("the test database needs two expense categories");
});

function wipe(): void {
  if (ccId == null) return;
  db.prepare(`DELETE FROM flow_categories WHERE account_id = ?`).run(ccId);
  db.prepare(`DELETE FROM cc_installment_purchases WHERE account_id = ?`).run(ccId);
  db.prepare(`DELETE FROM flows WHERE legacy_key LIKE ?`).run(`installment-h:${ccId}:%`);
  clearAggregationCache();
}

afterEach(wipe);

afterAll(() => {
  if (ccId == null) return;
  wipe();
  db.prepare(`DELETE FROM flows WHERE from_account_id = ? OR to_account_id = ?`).run(ccId, ccId);
  db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(ccId);
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(ccId);
  clearAggregationCache();
});

const mine = () => planLegacyInstallmentKeyRekey(db).filter((i) => i.account_id === ccId);

describe("re-keying a manual plan's legacy category", () => {
  it("moves the category onto the current key, and a second run finds nothing", () => {
    const plan = insertPlan(300_000);
    const { current, legacy } = keysOf(300_000);
    seedLegacyCategory(plan, legacy, categories[0]!);
    expect(getFlowCategory(ccId!, current)).toBeUndefined();

    const items = mine();
    expect(items.map((i) => [i.plan_id, i.outcome])).toEqual([[plan, "rekey"]]);
    expect(applyLegacyInstallmentKeyRekey(db, items)).toBe(1);

    expect(getFlowCategory(ccId!, current)?.category_id).toBe(categories[0]);
    expect(getFlowCategory(ccId!, legacy)).toBeUndefined();
    expect(mine()).toEqual([]);
  });

  it("reports, and never moves, a legacy key two plans of different totals share", () => {
    const plan = insertPlan(300_000);
    insertPlan(450_000);
    const { current, legacy } = keysOf(300_000);
    seedLegacyCategory(plan, legacy, categories[0]!);

    const items = mine();
    expect(items.length).toBe(2);
    expect(items.every((i) => i.outcome === "ambiguous")).toBe(true);
    expect(applyLegacyInstallmentKeyRekey(db, items)).toBe(0);
    expect(getFlowCategory(ccId!, current)).toBeUndefined();
    expect(getFlowCategory(ccId!, legacy)?.category_id).toBe(categories[0]);
  });

  it("reports a current key that already carries another category", () => {
    const plan = insertPlan(300_000);
    const { current, legacy } = keysOf(300_000);
    seedLegacyCategory(plan, legacy, categories[0]!);
    putFlowCategory(ccId!, current, categories[1]!, "replace");

    const [item] = mine();
    expect(item?.outcome).toBe("ambiguous");
    expect(applyLegacyInstallmentKeyRekey(db, [item!])).toBe(0);
    expect(getFlowCategory(ccId!, current)?.category_id).toBe(categories[1]);
  });
});
