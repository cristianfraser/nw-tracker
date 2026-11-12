import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { snapshotTables } from "./test/snapshotTables.js";
import { db } from "./db.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { accountValueCurrency } from "./accountValue.js";
import { accountProfileOptional } from "./accountProfile.js";
import { buildAccountDetailBundle } from "./accountDetailBundle.js";

/**
 * The account page's money (summary deposits and value, the position, broker holdings, the state
 * contribution) in the request's display unit (docs/any-currency-plan.md, Phase A item 1). The
 * EUR rates are fixed as in `dashboardRowsInEur.test.ts`: EUR/CLP 1.000 pesos on every day (a
 * direct pair, no spread) and EUR/USD 1,1.
 */
const CLP_PER_EUR = 1_000;
const USD_PER_EUR = 1.1;
const RATE_DAY = "1990-01-01";

const restoreEurTables = snapshotTables(["eur_daily", "fx_rates"]);

beforeAll(() => {
  db.prepare(`DELETE FROM eur_daily`).run();
  db.prepare(`DELETE FROM fx_rates WHERE base = 'eur' OR quote = 'eur'`).run();
  db.prepare(`INSERT INTO eur_daily (date, clp_per_eur) VALUES (?, ?)`).run(RATE_DAY, CLP_PER_EUR);
  db.prepare(`INSERT INTO fx_rates (base, quote, date, mid, source) VALUES ('eur', 'usd', ?, ?, 'vitest')`).run(
    RATE_DAY,
    USD_PER_EUR
  );
  clearAggregationCache();
});

afterAll(() => {
  restoreEurTables();
  clearAggregationCache();
});

const close = (a: number | null | undefined, b: number | null | undefined) =>
  a == null || b == null ? a == null && b == null : Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));

const accountIds = () => (db.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: number }[]).map((r) => r.id);

async function bundles(id: number) {
  const [clp, usd, eur] = await Promise.all(
    (["clp", "usd", "eur"] as const).map((u) => buildAccountDetailBundle(id, u, "monthly"))
  );
  return { clp: clp!, usd: usd!, eur: eur! };
}

describe("account detail bundle money in the display unit", () => {
  it("names its unit and reads the dashboard row's value in every unit", async () => {
    const mismatches: string[] = [];
    for (const id of accountIds()) {
      const b = await bundles(id);
      for (const [unit, x] of Object.entries(b)) {
        expect(x.summary.unit, `${id} ${unit}`).toBe(unit);
        expect(x.depositInflows.unit, `${id} ${unit}`).toBe(unit);
        if (x.summary.position) expect(x.summary.position.unit).toBe(unit);
        if (!close(x.summary.latest_valuation, x.dashboard_account_row?.current_value ?? null)) {
          mismatches.push(`${id} ${unit}: ${x.summary.latest_valuation} vs row ${x.dashboard_account_row?.current_value}`);
        }
        // The native balance is what the account holds, whatever the unit.
        expect(x.summary.latest_valuation_native).toEqual(b.clp.summary.latest_valuation_native);
      }
    }
    expect(mismatches).toEqual([]);
  }, 300_000);

  it("in EUR a peso account's figures are its pesos at EUR/CLP, deposits event by event", async () => {
    let checked = 0;
    for (const id of accountIds()) {
      if (accountValueCurrency(id) !== "clp" || accountProfileOptional(id)?.quantity.kind === "card") continue;
      const { clp, eur } = await bundles(id);
      expect(eur.summary.deposits).toBeCloseTo(clp.summary.deposits / CLP_PER_EUR, 6);
      if (clp.summary.latest_valuation != null) {
        expect(eur.summary.latest_valuation).toBeCloseTo(clp.summary.latest_valuation / CLP_PER_EUR, 6);
      }
      const pc = clp.summary.position;
      const pe = eur.summary.position;
      if (pc && pe) {
        expect(close(pe.value, pc.value == null ? null : pc.value / CLP_PER_EUR)).toBe(true);
        expect(close(pe.value_per_unit, pc.value_per_unit == null ? null : pc.value_per_unit / CLP_PER_EUR)).toBe(true);
        expect(close(pe.deposited, pc.deposited == null ? null : pc.deposited / CLP_PER_EUR)).toBe(true);
      }
      const se = eur.depositInflows.state_contribution_events;
      const sc = clp.depositInflows.state_contribution_events;
      expect(se.length).toBe(sc.length);
      se.forEach((e, i) => expect(e.amt).toBeCloseTo(sc[i]!.amt / CLP_PER_EUR, 6));
      expect(eur.depositInflows.state_contribution_total).toBeCloseTo(
        clp.depositInflows.state_contribution_total / CLP_PER_EUR,
        6
      );
      if (se.length > 0) expect(se[se.length - 1]!.cumulative).toBeCloseTo(eur.depositInflows.state_contribution_total, 6);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  }, 300_000);

  it("a dollar stock in EUR: its dollars at EUR/USD; units × price = value; returns in the unit", async () => {
    let checked = 0;
    for (const id of accountIds()) {
      if (accountProfileOptional(id)?.quantity.kind !== "stock" || accountValueCurrency(id) !== "usd") continue;
      const { usd, eur } = await bundles(id);
      const pu = usd.summary.position!;
      const pe = eur.summary.position!;
      expect(pe.value).toBeCloseTo(pu.value! / USD_PER_EUR, 6);
      expect(pe.value_per_unit! * pe.units!).toBeCloseTo(pe.value!, 4);
      expect(pu.value_per_unit! * pu.units!).toBeCloseTo(pu.value!, 4);
      expect(pe.total_return).toBeCloseTo(pe.value! - pe.deposited!, 6);
      for (const h of pe.brokers ?? []) expect(h.value).toBeCloseTo(pe.value! * h.share, 6);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  }, 300_000);
});
