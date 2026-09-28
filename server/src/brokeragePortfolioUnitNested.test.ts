import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./aggregationCache.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { navChartBucketNavNodes } from "./groupChartBuckets.js";
import { getNavChartGroupNodeBySlug, getSidebarNavPayload, type NavTreeNodeDto } from "./navTree.js";
import { accountIdsInPortfolioGroup, assertNavGroupItemsShape } from "./portfolioGroupTree.js";
import { seedNavTree } from "./seedNavTree.js";

/**
 * A managed portfolio unit filed UNDER a class bucket (migration 192's shape, as data): the
 * unit's asset group and portfolio group sit under Acciones, so Acciones holds its stocks and
 * the unit side by side. Each account sits in exactly one group, and the Acciones chart lists
 * each first-level child — a stock or the unit — as one line.
 */
const PREFIX = "vitest_pfn";
const UNIT_SLUG = `${PREFIX}_unit`;
const HOLD_LEAF = `${PREFIX}_hold__mark`;
const CAJA_LEAF = `${PREFIX}_caja__clp`;
const STOCK_LEAF = `brokerage_acciones__${PREFIX}_stock`;
const NOTE = "vitest-portfolio-unit-nested";

const agId = (slug: string): number =>
  (db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(slug) as { id: number }).id;

function findNode(root: NavTreeNodeDto | null | undefined, slug: string): NavTreeNodeDto | null {
  if (!root) return null;
  if (root.slug === slug) return root;
  for (const c of root.children ?? []) {
    const hit = findNode(c, slug);
    if (hit) return hit;
  }
  return null;
}

describe("brokerage portfolio unit nested under Acciones", () => {
  let holdId = 0;
  let cajaId = 0;
  let stockId = 0;
  let brokerageBefore: number[] = [];

  beforeAll(() => {
    const insAg = db.prepare(`INSERT INTO asset_groups (slug, label, sort_order, parent_id) VALUES (?, ?, ?, ?)`);
    insAg.run(STOCK_LEAF, "Vitest PFN stock", 99, agId("brokerage_acciones"));
    insAg.run(UNIT_SLUG, "Vitest PFN", 99, agId("brokerage_acciones"));
    insAg.run(HOLD_LEAF, "Vitest PFN holding", 99, agId(UNIT_SLUG));
    insAg.run(CAJA_LEAF, "Vitest PFN caja", 99, agId(UNIT_SLUG));
    const insAcc = db.prepare(`INSERT INTO accounts (asset_group_id, name, import_key) VALUES (?, ?, ?)`);
    stockId = Number(insAcc.run(agId(STOCK_LEAF), "Vitest PFN stock", `${NOTE}|stock`).lastInsertRowid);
    holdId = Number(insAcc.run(agId(HOLD_LEAF), "Vitest PFN holding", `${NOTE}|hold`).lastInsertRowid);
    cajaId = Number(insAcc.run(agId(CAJA_LEAF), "Vitest PFN caja", `${NOTE}|caja`).lastInsertRowid);
    const today = chileCalendarTodayYmd();
    const val = db.prepare(`INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')`);
    val.run(stockId, today, 1_000);
    val.run(holdId, today, 900_000_000);
    val.run(cajaId, today, 50_000);

    db.prepare(
      `INSERT INTO portfolio_groups (
         parent_id, slug, label, sort_order, route_path, active_prefix, api_group, api_subgroup,
         asset_group_slug, sidebar_section, group_kind, kind_slug
       )
       SELECT id, ?, 'Vitest PFN', 25, ?, ?, 'brokerage', ?, ?, 'nested', 'bucket', ?
       FROM portfolio_groups WHERE slug = 'brokerage_acciones'`
    ).run(
      UNIT_SLUG,
      `/inversiones/brokerage/acciones/${PREFIX}`,
      `/inversiones/brokerage/acciones/${PREFIX}`,
      UNIT_SLUG,
      UNIT_SLUG,
      UNIT_SLUG
    );
    seedNavTree();
    brokerageBefore = accountIdsInPortfolioGroup("brokerage");
  });

  afterAll(() => {
    const mine = `SELECT id FROM accounts WHERE import_key LIKE '${NOTE}|%'`;
    db.prepare(`DELETE FROM valuations WHERE account_id IN (${mine})`).run();
    db.prepare(`UPDATE accounts SET primary_portfolio_group_id = NULL WHERE id IN (${mine})`).run();
    db.prepare(`DELETE FROM portfolio_groups WHERE slug = ?`).run(UNIT_SLUG);
    db.prepare(`DELETE FROM accounts WHERE id IN (${mine})`).run();
    // Leaves before the unit they sit under (FK on parent_id).
    db.prepare(`DELETE FROM asset_groups WHERE slug IN (?, ?, ?)`).run(HOLD_LEAF, CAJA_LEAF, STOCK_LEAF);
    db.prepare(`DELETE FROM asset_groups WHERE slug = ?`).run(UNIT_SLUG);
    seedNavTree();
    clearAggregationCache();
  });

  it("links the unit as a child group of Acciones and each account in one group only", () => {
    expect(() => assertNavGroupItemsShape()).not.toThrow();
    expect(accountIdsInPortfolioGroup(UNIT_SLUG)).toEqual([holdId, cajaId].sort((a, b) => a - b));
    const acciones = accountIdsInPortfolioGroup("brokerage_acciones");
    expect(acciones).toEqual(expect.arrayContaining([stockId, holdId, cajaId]));
    expect(brokerageBefore).toEqual(expect.arrayContaining([stockId, holdId, cajaId]));

    const direct = db
      .prepare(
        `SELECT i.item_kind, i.account_id, c.slug AS child
         FROM portfolio_group_items i
         JOIN portfolio_groups g ON g.id = i.group_id
         LEFT JOIN portfolio_groups c ON c.id = i.child_group_id
         WHERE g.slug = 'brokerage_acciones'`
      )
      .all() as { item_kind: string; account_id: number | null; child: string | null }[];
    expect(direct.some((r) => r.item_kind === "group" && r.child === UNIT_SLUG)).toBe(true);
    expect(direct.some((r) => r.account_id === stockId)).toBe(true);
    expect(direct.some((r) => r.account_id === holdId || r.account_id === cajaId)).toBe(false);

    const primaries = db
      .prepare(
        `SELECT a.id, g.slug FROM accounts a JOIN portfolio_groups g ON g.id = a.primary_portfolio_group_id
         WHERE a.id IN (?, ?, ?)`
      )
      .all(stockId, holdId, cajaId) as { id: number; slug: string }[];
    expect(Object.fromEntries(primaries.map((r) => [r.id, r.slug]))).toEqual({
      [stockId]: "brokerage_acciones",
      [holdId]: UNIT_SLUG,
      [cajaId]: UNIT_SLUG,
    });

    const accionesNode = findNode(getSidebarNavPayload().net_worth, "brokerage_acciones");
    expect(accionesNode?.children.some((c) => c.slug === UNIT_SLUG)).toBe(true);
  });

  it("charts each first-level child of Acciones as one line, by balance", () => {
    const acciones = getNavChartGroupNodeBySlug("brokerage_acciones")!;
    const grouped = navChartBucketNavNodes(acciones, true);
    const slugs = grouped.map((n) => n.slug);
    expect(slugs[0]).toBe(UNIT_SLUG);
    expect(grouped.some((n) => n.account_id === stockId)).toBe(true);
    expect(grouped.some((n) => n.account_id === holdId || n.account_id === cajaId)).toBe(false);

    // Sin agrupar: one level deeper — the unit opens into its two accounts.
    const ungrouped = navChartBucketNavNodes(acciones, false);
    expect(ungrouped.some((n) => n.slug === UNIT_SLUG)).toBe(false);
    expect(ungrouped.filter((n) => n.account_id === holdId || n.account_id === cajaId)).toHaveLength(2);
    expect(ungrouped.some((n) => n.account_id === stockId)).toBe(true);

    // On Brokerage, Sin agrupar lists Acciones' first-level children, the unit among them.
    const brokerage = getNavChartGroupNodeBySlug("brokerage")!;
    const brkUngrouped = navChartBucketNavNodes(brokerage, false);
    expect(brkUngrouped.some((n) => n.slug === UNIT_SLUG)).toBe(true);
    expect(brkUngrouped.some((n) => n.account_id === stockId)).toBe(true);
  });
});
