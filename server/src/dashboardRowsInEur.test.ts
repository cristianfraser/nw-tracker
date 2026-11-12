import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { snapshotTables } from "./test/snapshotTables.js";
import { db } from "./db.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { accountProfileOptional } from "./accountProfile.js";
import { accountValueCurrency } from "./accountValue.js";
import { buildDashboardAccountRows, buildDashboardNavSnapshot } from "./dashboardAccounts.js";
import type { NavValueMapNodeDto } from "./navValueMap.js";

/**
 * EUR as the display unit of the dashboard rows and the nav strip. The synthetic Vitest database
 * has no EUR rates: one `eur_daily` row before every fixture day makes the EUR/CLP mid 1.000 pesos
 * on every day (a direct pair: no spread, so either side reads it), and one EUR/USD row lets the
 * dollar holdings walk through USD.
 */
const CLP_PER_EUR = 1_000;
const RATE_DAY = "1990-01-01";

// The synthetic market writes EUR rates; this test states its own, so it empties both EUR
// tables first and puts them back after.
const restoreEurTables = snapshotTables(["eur_daily", "fx_rates"]);

beforeAll(() => {
  db.prepare(`DELETE FROM eur_daily`).run();
  db.prepare(`DELETE FROM fx_rates WHERE base = 'eur' OR quote = 'eur'`).run();
  db.prepare(`INSERT INTO eur_daily (date, clp_per_eur) VALUES (?, ?)`).run(RATE_DAY, CLP_PER_EUR);
  db.prepare(`INSERT INTO fx_rates (base, quote, date, mid, source) VALUES ('eur', 'usd', ?, ?, 'vitest')`).run(
    RATE_DAY,
    1.1
  );
  clearAggregationCache();
});

afterAll(() => {
  restoreEurTables();
  clearAggregationCache();
});

const close = (a: number | null | undefined, b: number | null | undefined) =>
  a == null || b == null ? a == null && b == null : Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));

function slugs(n: NavValueMapNodeDto): string[] {
  return [n.slug, ...(n.children ?? []).flatMap(slugs), ...(n.leaf_accounts ?? []).flatMap(slugs)];
}

describe("dashboard rows and nav strip in EUR", () => {
  it("a peso-valued row reads its pesos at the day's EUR/CLP rate", async () => {
    const clp = await buildDashboardAccountRows("clp");
    const eur = await buildDashboardAccountRows("eur");
    const byId = new Map(eur.map((r) => [r.account_id, r]));
    const mismatches: string[] = [];
    let checked = 0;
    for (const c of clp) {
      const e = byId.get(c.account_id)!;
      expect(e, `${c.account_id} in eur`).toBeDefined();
      // The pesos the structural rules read are the same in every unit.
      expect(e.clp_basis).toEqual(c.clp_basis);
      // Deposit events convert at their own day's EUR/CLP rate: the day's flows are pesos / 1.000.
      if (!close(e.deposits_day, c.deposits_day == null ? c.deposits_day : c.deposits_day / CLP_PER_EUR)) {
        mismatches.push(`${c.account_id} deposits_day ${e.deposits_day} vs ${c.deposits_day}`);
      }
      if (accountValueCurrency(c.account_id) !== "clp" || accountProfileOptional(c.account_id)?.quantity.kind === "card") {
        continue;
      }
      checked += 1;
      for (const f of ["current_value", "prior_day_close"] as const) {
        const want = c[f] == null ? c[f] : c[f]! / CLP_PER_EUR;
        if (!close(e[f], want)) mismatches.push(`${c.account_id} ${c.name} ${f}: ${e[f]} vs ${want}`);
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(mismatches).toEqual([]);
  }, 300_000);

  it("the nav snapshot names its unit, keeps the pesos' structure and sums the EUR rows", async () => {
    const clp = await buildDashboardNavSnapshot("clp");
    const eur = await buildDashboardNavSnapshot("eur");
    expect(eur.unit).toBe("eur");
    expect(Object.keys(eur.card_metrics_by_slug).sort()).toEqual(Object.keys(clp.card_metrics_by_slug).sort());
    for (const [slug, m] of Object.entries(clp.card_metrics_by_slug)) {
      expect(eur.card_metrics_by_slug[slug]!.liquidated?.account_ids, slug).toEqual(m.liquidated?.account_ids);
    }
    expect(slugs(eur.value_map)).toEqual(slugs(clp.value_map));
    // The liabilities owed today at the debt side: pesos / 1.000 (a direct pair has no spread).
    const lc = clp.liabilities_breakdown;
    expect(eur.liabilities_breakdown.mortgage).toBeCloseTo((lc.mortgage ?? 0) / CLP_PER_EUR, 6);
    expect(eur.liabilities_breakdown.credit_card).toBeCloseTo((lc.credit_card ?? 0) / CLP_PER_EUR, 6);
    // The net-worth root's balance is Σ of the bucket totals in EUR.
    const buckets = Object.values(eur.nw_bucket_totals.buckets);
    expect(buckets.every((v) => v != null)).toBe(true);
    expect(eur.nw_bucket_totals.net_worth).toBeCloseTo(buckets.reduce((s: number, v) => s + v!, 0), 6);
  }, 300_000);
});
