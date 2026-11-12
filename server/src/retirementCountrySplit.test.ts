/**
 * Retirement by country (docs/demo-us-chapter-plan.md, phase 3): the split is created on demand
 * (`ensureRetirementCountrySplit`, the demo generator's call), the tree links by what exists, and a
 * 401(k) is a cuota ledger on a dollar fund series (`fund_unit_daily.currency`). Synthetic
 * fixtures only (`vitest_us_` series, «Vitest US» account), removed afterwards along with the split.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { ensureRetirementCountrySplit, seedNavTree } from "./seedNavTree.js";
import { getNetWorthNavGroupNode, getSidebarNavPayload } from "./navTree.js";
import type { NavTreeNodeDto } from "./navTree.js";
import { compositionLineSpecsFromNavTree } from "./dashboardComposition.js";
import { listAccountsForGroupTab } from "./valuationTimeseries.js";
import { buildDashboardNavSnapshot } from "./dashboardAccounts.js";
import { accountValueAt } from "./accountValue.js";
import { accountHolding } from "./holdings.js";
import { convertValue } from "./valueConvert.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import {
  fundSeriesCurrency,
  fundUnitClpOnOrBefore,
  latestFundUnitRow,
  upsertFundUnitSpotPreservingHistory,
  writeFundUnitSeriesRows,
} from "./fundUnitDaily.js";
import { latestAfpUnoFundUnitRowOnOrBeforeForDisplay } from "./afpUnoValuation.js";

const SERIES = "vitest_us_tdf_usd";
const UNIT_USD = 25;
const CUOTAS = 10;
const SPLIT_GROUPS = ["retirement_us_401k", "retirement_us_roth_ira", "retirement_us_hsa", "retirement_us", "retirement_cl"];

let accountId = 0;
let pastDay = "";

function navDump() {
  return {
    nav: getSidebarNavPayload(),
    items: db
      .prepare(
        `SELECT g.slug AS g, i.item_kind, c.slug AS c, i.account_id, i.sort_order
         FROM portfolio_group_items i JOIN portfolio_groups g ON g.id = i.group_id
         LEFT JOIN portfolio_groups c ON c.id = i.child_group_id
         ORDER BY g.slug, i.item_kind, c.slug, i.account_id`
      )
      .all(),
    assetParents: db
      .prepare(
        `SELECT a.slug, p.slug AS parent FROM asset_groups a LEFT JOIN asset_groups p ON p.id = a.parent_id ORDER BY a.slug`
      )
      .all(),
  };
}

function find(node: NavTreeNodeDto | null | undefined, slug: string): NavTreeNodeDto | null {
  if (!node) return null;
  if (node.slug === slug) return node;
  for (const c of node.children ?? []) {
    const hit = find(c, slug);
    if (hit) return hit;
  }
  return null;
}

const childSlugs = (n: NavTreeNodeDto | null) => (n?.children ?? []).map((c) => c.slug);

/** Undo the split: the Chilean nodes back under Retirement first (a parent's delete cascades). */
function removeSplit(): void {
  for (const table of ["portfolio_groups", "asset_groups"]) {
    for (const slug of ["retirement_afp_afc", "retirement_apv"]) {
      db.prepare(`UPDATE ${table} SET parent_id = (SELECT id FROM ${table} WHERE slug = 'retirement') WHERE slug = ?`).run(slug);
    }
  }
  for (const slug of SPLIT_GROUPS) db.prepare(`DELETE FROM portfolio_groups WHERE slug = ?`).run(slug);
  seedNavTree();
}

function removeFixtures(): void {
  db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
  db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ?`).run(SERIES);
}

let before: ReturnType<typeof navDump>;

beforeAll(() => {
  seedNavTree();
  before = navDump();
  const today = chileCalendarTodayYmd();
  pastDay = chileCalendarAddDays(today, -10);
  const leaf = db.prepare(`SELECT id FROM asset_groups WHERE slug = 'retirement_us_401k__us_401k'`).get() as { id: number };
  accountId = Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, fund_series_key) VALUES (?, 'Vitest US 401(k)', ?)`)
      .run(leaf.id, SERIES).lastInsertRowid
  );
  writeFundUnitSeriesRows({
    seriesKey: SERIES,
    currency: "usd",
    rows: Array.from({ length: 31 }, (_, i) => ({ day: chileCalendarAddDays(today, i - 30), unit_value: UNIT_USD })),
  });
  db.prepare(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, flow_kind, units_delta) VALUES (?, ?, 'usd', ?, NULL, ?)`
  ).run(accountId, CUOTAS * UNIT_USD, chileCalendarAddDays(today, -20), CUOTAS);
  ensureRetirementCountrySplit();
  clearAggregationCache();
});

afterAll(() => {
  removeFixtures();
  if (db.prepare(`SELECT 1 FROM portfolio_groups WHERE slug = 'retirement_cl'`).get()) removeSplit();
  clearAggregationCache();
});

describe("Retirement by country", () => {
  it("nests Chile (the existing subtree) and US (the leaves that hold accounts) under Retirement", () => {
    const nw = getNetWorthNavGroupNode();
    expect(childSlugs(find(nw, "retirement"))).toEqual(["retirement_cl", "retirement_us"]);
    expect(childSlugs(find(nw, "retirement_cl"))).toEqual(["retirement_afp_afc", "retirement_apv"]);
    expect(childSlugs(find(nw, "retirement_apv"))).toEqual(["retirement_apv_a", "retirement_apv_b"]);
    // Roth IRA and HSA hold nothing: left out.
    expect(childSlugs(find(nw, "retirement_us"))).toEqual(["retirement_us_401k"]);
    expect(find(nw, "retirement_us_401k")?.member_account_ids).toEqual([accountId]);
    expect(find(nw, "retirement_us")?.route_path).toBe("/inversiones/retiro/us");
    expect(find(nw, "retirement_cl")?.label_i18n_key).toBe("retirement.chile");
    // Every Chilean account keeps its leaf, and so its group.
    const clAccounts = [...(find(nw, "retirement_cl")?.member_account_ids ?? [])].sort((a, b) => a - b);
    const beforeAccounts = [...(find(before.nav.net_worth, "retirement")?.member_account_ids ?? [])].sort((a, b) => a - b);
    expect(clAccounts).toEqual(beforeAccounts);
  });

  it("is idempotent", () => {
    const once = navDump();
    ensureRetirementCountrySplit();
    expect(navDump()).toEqual(once);
  });

  it("gives both country nodes card metrics that add up to Retirement", async () => {
    clearAggregationCache();
    const snap = await buildDashboardNavSnapshot("clp");
    const m = snap.card_metrics_by_slug;
    const cl = m.retirement_cl!.value.child!;
    const us = m.retirement_us!.value.child!;
    expect(us).toBeGreaterThan(0);
    expect(us).toBeCloseTo(accountValueAt(accountId, chileCalendarTodayYmd(), "clp")!.value, 2);
    // The bucket total is rounded to the peso.
    expect(Math.abs(cl + us - m.retirement!.value.parent!)).toBeLessThanOrEqual(1);
  });

  it("composes Retirement one level down: Chile and US", () => {
    const specs = compositionLineSpecsFromNavTree((slug) => listAccountsForGroupTab(slug));
    expect(specs.filter((s) => s.bigBucketSlug === "retirement").map((s) => s.dataKey)).toEqual([
      "retirement_cl",
      "retirement_us",
    ]);
    expect(specs.find((s) => s.dataKey === "retirement_us")!.rows.map((r) => r.account_id)).toEqual([accountId]);
  });
});

describe("a fund series in dollars (the 401(k))", () => {
  it("prices the holding in its series' currency", () => {
    expect(fundSeriesCurrency(SERIES)).toBe("usd");
    expect(accountHolding(accountId)).toEqual({ kind: "fund", seriesKey: SERIES, quote: "usd" });
  });

  it("values cuotas × the dollar valor cuota, converted once at the asset side", () => {
    expect(accountValueAt(accountId, pastDay, "usd")!.value).toBeCloseTo(CUOTAS * UNIT_USD, 6);
    const clp = accountValueAt(accountId, pastDay, "clp")!.value;
    expect(clp).toBeCloseTo(convertValue(CUOTAS * UNIT_USD, "usd", "clp", pastDay, "asset")!, 2);
    expect(clp).toBeGreaterThan(CUOTAS * UNIT_USD * 100);
    expect(accountValueAt(accountId, chileCalendarTodayYmd(), "usd")!.value).toBeCloseTo(CUOTAS * UNIT_USD, 6);
  });

  it("refuses a peso reader and a write in another currency", () => {
    expect(() => latestFundUnitRow(SERIES)).toThrow(/USD/);
    expect(() => fundUnitClpOnOrBefore(SERIES, pastDay)).toThrow(/USD/);
    expect(() => latestAfpUnoFundUnitRowOnOrBeforeForDisplay(SERIES, pastDay)).toThrow(/USD/);
    expect(() =>
      upsertFundUnitSpotPreservingHistory({
        seriesKey: SERIES,
        observationDay: pastDay,
        unitValueClp: 1000,
        note: "vitest",
        dryRun: false,
      })
    ).toThrow(/quoted in USD/);
  });
});

describe("without the split", () => {
  it("leaves the tree exactly as it was before the split", () => {
    removeFixtures();
    removeSplit();
    expect(navDump()).toEqual(before);
    expect(childSlugs(find(getNetWorthNavGroupNode(), "retirement"))).toEqual(["retirement_afp_afc", "retirement_apv"]);
  });
});
