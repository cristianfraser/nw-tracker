import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./aggregationCache.js";
import { monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import {
  getGroupConsolidatedMonthlyPerfForRows,
  type ConsolidatedMonthlyPerfRow,
} from "./groupMonthlyPerfConsolidation.js";
import { buildInversionesConsolidatedMonthly, buildNetWorthConsolidatedMonthly } from "./netWorthConsolidation.js";
import { getSidebarNavPayload } from "./navTree.js";
import { accountIdsInPortfolioGroup } from "./portfolioGroupTree.js";
import { seedNavTree } from "./seedNavTree.js";
import { listAccountsForGroupTab } from "./valuationTimeseries.js";

/**
 * A managed portfolio unit (migration 190's shape, as data): a brokerage bucket backed by its
 * own asset group, the holding's and the fee caja's leaf asset groups reparented under it.
 * The group's return is the holding's P/L net of the fee over the whole portfolio, and moving
 * the pair out of the class buckets changes no total.
 */
const PREFIX = "vitest_pfu";
const UNIT_SLUG = `${PREFIX}_unit`;
const HOLD_LEAF = `${PREFIX}_hold__${PREFIX}mark`;
const CAJA_LEAF = `${PREFIX}_caja__clp`;
const NOTE = "vitest-portfolio-unit";

const thisMonth = monthKeyFromYmd(chileCalendarTodayYmd());
const M1 = addCalendarMonths(thisMonth, -5);
const M2 = addCalendarMonths(thisMonth, -4);

const agId = (slug: string): number =>
  (db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(slug) as { id: number }).id;

const rowFor = (rows: readonly ConsolidatedMonthlyPerfRow[], mk: string): ConsolidatedMonthlyPerfRow => {
  const r = rows.find((x) => monthKeyFromYmd(x.as_of_date) === mk);
  if (!r) throw new Error(`no row for ${mk}`);
  return r;
};

const groupRows = (slug: string) => getGroupConsolidatedMonthlyPerfForRows(listAccountsForGroupTab(slug), slug, "clp");

describe("brokerage portfolio unit (holding + fee caja as one bucket)", () => {
  let holdId = 0;
  let cajaId = 0;
  let before: { nw: ConsolidatedMonthlyPerfRow; inv: ConsolidatedMonthlyPerfRow; brk: ConsolidatedMonthlyPerfRow } | null =
    null;

  beforeAll(() => {
    const insAg = db.prepare(`INSERT INTO asset_groups (slug, label, sort_order, parent_id) VALUES (?, ?, ?, ?)`);
    // Filed as the class buckets file them first: holding under acciones, caja under cash.
    insAg.run(HOLD_LEAF, "Vitest PFU holding", 99, agId("brokerage_acciones"));
    insAg.run(CAJA_LEAF, "Vitest PFU caja", 99, agId("brokerage_cash"));
    const insAcc = db.prepare(`INSERT INTO accounts (asset_group_id, name, import_key) VALUES (?, ?, ?)`);
    holdId = Number(insAcc.run(agId(HOLD_LEAF), "Vitest PFU holding", `${NOTE}|hold`).lastInsertRowid);
    cajaId = Number(insAcc.run(agId(CAJA_LEAF), "Vitest PFU caja", `${NOTE}|caja`).lastInsertRowid);

    const single = db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind)
       VALUES (?, ?, 'clp', ?, ?, ?)`
    );
    single.run(cajaId, 1_010_000, `${M1}-05`, NOTE, null);
    // The broker's monthly fee, charged from the caja: P/L of the caja, never a withdrawal.
    single.run(cajaId, -850, `${M2}-15`, NOTE, "cash_fee");
    // The caja buys the holding: internal to the unit.
    db.prepare(
      `INSERT INTO movements (account_id, from_account_id, to_account_id, amount, currency, occurred_on, note)
       VALUES (NULL, ?, ?, 1000000, 'clp', ?, ?)`
    ).run(cajaId, holdId, `${M1}-06`, NOTE);
    const val = db.prepare(`INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')`);
    val.run(holdId, `${M1}-06`, 1_000_000);
    val.run(holdId, monthEndUtcYmd(M1), 1_000_000);
    val.run(holdId, monthEndUtcYmd(M2), 1_020_000);

    seedNavTree();
    before = {
      nw: rowFor(buildNetWorthConsolidatedMonthly("clp"), M2),
      inv: rowFor(buildInversionesConsolidatedMonthly("clp"), M2),
      brk: rowFor(groupRows("brokerage"), M2),
    };

    // The unit, as migration 190 writes it.
    insAg.run(UNIT_SLUG, "Vitest PFU", 99, agId("brokerage"));
    db.prepare(`UPDATE asset_groups SET parent_id = ? WHERE slug IN (?, ?)`).run(agId(UNIT_SLUG), HOLD_LEAF, CAJA_LEAF);
    db.prepare(
      `INSERT INTO portfolio_groups (
         parent_id, slug, label, sort_order, route_path, active_prefix, api_group, api_subgroup,
         asset_group_slug, sidebar_section, group_kind, kind_slug
       )
       SELECT id, ?, 'Vitest PFU', 25, ?, ?, 'brokerage', ?, ?, 'nested', 'bucket', ?
       FROM portfolio_groups WHERE slug = 'brokerage'`
    ).run(UNIT_SLUG, `/inversiones/brokerage/${PREFIX}`, `/inversiones/brokerage/${PREFIX}`, UNIT_SLUG, UNIT_SLUG, UNIT_SLUG);
    seedNavTree();
  });

  afterAll(() => {
    const mine = `SELECT id FROM accounts WHERE import_key LIKE '${NOTE}|%'`;
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(NOTE);
    db.prepare(`DELETE FROM valuations WHERE account_id IN (${mine})`).run();
    db.prepare(`UPDATE accounts SET primary_portfolio_group_id = NULL WHERE id IN (${mine})`).run();
    db.prepare(`DELETE FROM portfolio_groups WHERE slug = ?`).run(UNIT_SLUG);
    db.prepare(`DELETE FROM accounts WHERE id IN (${mine})`).run();
    db.prepare(`DELETE FROM asset_groups WHERE slug IN (?, ?, ?)`).run(HOLD_LEAF, CAJA_LEAF, UNIT_SLUG);
    seedNavTree();
    clearAggregationCache();
  });

  it("seeds the unit under brokerage with both members, out of the class buckets", () => {
    expect(accountIdsInPortfolioGroup(UNIT_SLUG)).toEqual([holdId, cajaId].sort((a, b) => a - b));
    expect(accountIdsInPortfolioGroup("brokerage_acciones")).not.toContain(holdId);
    expect(accountIdsInPortfolioGroup("brokerage_cash")).not.toContain(cajaId);
    expect(accountIdsInPortfolioGroup("brokerage")).toEqual(expect.arrayContaining([holdId, cajaId]));

    const find = (nodes: readonly { slug: string; children: unknown[] }[]): { children: unknown[] } | null => {
      for (const n of nodes) {
        if (n.slug === UNIT_SLUG) return n;
        const hit = find(n.children as { slug: string; children: unknown[] }[]);
        if (hit) return hit;
      }
      return null;
    };
    const node = find(getSidebarNavPayload().net_worth ? [getSidebarNavPayload().net_worth!] : []);
    expect(node?.children).toHaveLength(2);
  });

  it("reads the month as (holding P/L − fee) over the whole portfolio", () => {
    const m2 = rowFor(groupRows(UNIT_SLUG), M2);
    expect(m2.prior_closing).toBe(1_010_000);
    expect(m2.net_capital_flow).toBe(0);
    expect(m2.nominal_pl).toBe(20_000 - 850);
    expect(m2.pct_month).toBeCloseTo((20_000 - 850) / 1_010_000, 12);
    const m1 = rowFor(groupRows(UNIT_SLUG), M1);
    expect(m1.net_capital_flow).toBe(1_010_000);
    expect(m1.nominal_pl).toBe(0);
  });

  it("changes no total: net worth, inversiones and brokerage read the same month", () => {
    const after = {
      nw: rowFor(buildNetWorthConsolidatedMonthly("clp"), M2),
      inv: rowFor(buildInversionesConsolidatedMonthly("clp"), M2),
      brk: rowFor(groupRows("brokerage"), M2),
    };
    for (const k of ["nw", "inv", "brk"] as const) {
      expect(after[k].closing_value).toBeCloseTo(before![k].closing_value, 6);
      expect(after[k].net_capital_flow).toBeCloseTo(before![k].net_capital_flow, 6);
      expect(after[k].nominal_pl!).toBeCloseTo(before![k].nominal_pl!, 6);
      expect(after[k].pct_month!).toBeCloseTo(before![k].pct_month!, 12);
    }
  });
});
