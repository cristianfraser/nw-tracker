import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  compositionSelfCheck,
  RN_COMPOSITION_SELF_CHECK_ERROR_BP,
  resolveCompositionAnchor,
  type CompositionAnchor,
} from "./fintualRiskyNorrisComposition.js";
import type { CompositeHolding, CompositeMeta } from "./watchlistComposite.js";

/**
 * Anchor resolution on the real 2026-09 calendar: Wed 16 and Thu 17 are Chile business days,
 * Fri 18 is Fiestas Patrias (Chile closed, NYSE open), Sat 19 / Sun 20 weekend, Mon 21 and
 * Tue 22 business days. Fintual printed a flat carry for 18..20 and caught Friday's NYSE move
 * up in Monday's cuota.
 */
const WED = "2026-09-16";
const THU = "2026-09-17";
const FRI = "2026-09-18";
const SAT = "2026-09-19";
const SUN = "2026-09-20";
const MON = "2026-09-21";
const TUE = "2026-09-22";

const RN_KEY = "vitest:rn:anchor";
const APV_KEY = "vitest:apv:anchor";
const PUBLISHED = "fintual:public-serie:publish|serie=6";
const CARRY = "fintual:carry-forward";
const OPTS = { seriesKeys: [RN_KEY], apvSeriesKeys: [APV_KEY] };

function seedUnit(seriesKey: string, day: string, value: number, note = PUBLISHED): void {
  db.prepare(
    `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note) VALUES (?, ?, ?, ?)
     ON CONFLICT(series_key, day) DO UPDATE SET unit_value_clp = excluded.unit_value_clp, note = excluded.note`
  ).run(seriesKey, day, value, note);
}

/** The RN serie as it stood on 2026-09-22 before the evening poll: Thursday's valuation carried through Sunday. */
function seedHolidayBlock(): void {
  seedUnit(RN_KEY, WED, 4191.9596);
  seedUnit(RN_KEY, THU, 4271.4609);
  seedUnit(RN_KEY, FRI, 4271.3241);
  seedUnit(RN_KEY, SAT, 4271.1873);
  seedUnit(RN_KEY, SUN, 4271.0505);
}

afterEach(() => {
  db.prepare(`DELETE FROM fund_unit_daily WHERE series_key IN (?, ?)`).run(RN_KEY, APV_KEY);
});

describe("resolveCompositionAnchor", () => {
  it("a positions date inside a holiday block anchors on the last Chile business day, not the carried row", () => {
    seedHolidayBlock();
    const anchor = resolveCompositionAnchor(SUN, OPTS);
    expect(anchor.anchor_ymd).toBe(THU);
    expect(anchor.fund_unit_clp).toBe(4271.4609);
    expect(anchor.positions_ymd).toBe(SUN);
    expect(anchor.series_key).toBe(RN_KEY);
    // The holiday Friday is skipped even though it carries a "published" row (a flat carry).
    expect(resolveCompositionAnchor(FRI, OPTS).anchor_ymd).toBe(THU);
  });

  it("a positions date newer than the serie anchors on the cuota's own day, never the positions date", () => {
    seedHolidayBlock();
    // Monday's cuota not published yet: the walk passes the weekend and the holiday to Thursday.
    expect(resolveCompositionAnchor(MON, OPTS).anchor_ymd).toBe(THU);
    expect(resolveCompositionAnchor(TUE, OPTS).anchor_ymd).toBe(THU);
    // Once Monday's cuota lands, Tuesday's positions anchor on Monday.
    seedUnit(RN_KEY, MON, 4335.7073);
    const anchor = resolveCompositionAnchor(TUE, OPTS);
    expect(anchor.anchor_ymd).toBe(MON);
    expect(anchor.fund_unit_clp).toBe(4335.7073);
  });

  it("a carry-forward placeholder on a business day is skipped like a holiday", () => {
    seedHolidayBlock();
    seedUnit(RN_KEY, MON, 4271.0505, CARRY);
    expect(resolveCompositionAnchor(TUE, OPTS).anchor_ymd).toBe(THU);
  });

  it("reads the APV cuota on the anchor day exactly, and refuses an APV serie that lacks it", () => {
    seedHolidayBlock();
    // No APV serie at all (demo/CI): null.
    expect(resolveCompositionAnchor(SUN, OPTS).apv_fund_unit_clp).toBeNull();
    // APV serie present on the anchor day: its value.
    seedUnit(APV_KEY, THU, 4432.9171);
    expect(resolveCompositionAnchor(SUN, OPTS).apv_fund_unit_clp).toBe(4432.9171);
    // APV serie exists but stops before the anchor day: a gap, never an on-or-before substitute.
    db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ? AND day = ?`).run(APV_KEY, THU);
    seedUnit(APV_KEY, WED, 4350.3273);
    expect(() => resolveCompositionAnchor(SUN, OPTS)).toThrow(/no published cuota on anchor day 2026-09-17/);
  });

  it("throws when no published cuota sits on a business day within the walk window", () => {
    seedUnit(RN_KEY, "2026-08-31", 4000);
    expect(() => resolveCompositionAnchor(TUE, OPTS)).toThrow(/no published Risky Norris cuota/);
  });
});

/**
 * Self-check fixture on far-future weekdays (no Chile holidays there): a Thursday-valued cuota,
 * a Friday NYSE session, and Monday's official cuota that includes both Friday and Monday.
 * The observado is flat (900 on every publication) so only the basket pairing is measured.
 */
const SC_THU = "2099-03-05";
const SC_FRI = "2099-03-06";
const SC_SUN = "2099-03-08";
const SC_MON = "2099-03-09";
const SC_TUE = "2099-03-10";
const SC_TICKERS = ["VITESTRNSCA", "VITESTRNSCB"] as const;
const SC_BUCKET = "vitest_rn_proxy_self_check";
const SC_HOLDINGS: CompositeHolding[] = [
  { ticker: SC_TICKERS[0], weight: 0.5, synced_at: SC_SUN },
  { ticker: SC_TICKERS[1], weight: 0.5, synced_at: SC_SUN },
];

const observadoBackup = new Map<string, number | null>();
function setObservado(date: string, value: number): void {
  if (!observadoBackup.has(date)) {
    const prior = db.prepare(`SELECT clp_per_usd FROM fx_daily_bcentral WHERE date = ?`).get(date) as
      | { clp_per_usd: number }
      | undefined;
    observadoBackup.set(date, prior?.clp_per_usd ?? null);
  }
  db.prepare(
    `INSERT INTO fx_daily_bcentral (date, clp_per_usd) VALUES (?, ?)
     ON CONFLICT(date) DO UPDATE SET clp_per_usd = excluded.clp_per_usd`
  ).run(date, value);
}

function seedSelfCheckFixture(): void {
  const closes: Record<(typeof SC_TICKERS)[number], Record<string, number>> = {
    VITESTRNSCA: { [SC_THU]: 100, [SC_FRI]: 105, [SC_MON]: 110 },
    VITESTRNSCB: { [SC_THU]: 10, [SC_FRI]: 10, [SC_MON]: 10 },
  };
  for (const ticker of SC_TICKERS) {
    for (const [day, close] of Object.entries(closes[ticker])) {
      db.prepare(
        `INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'usd')
         ON CONFLICT(ticker, trade_date) DO UPDATE SET close = excluded.close, currency = excluded.currency`
      ).run(ticker, day, close);
    }
  }
  for (const day of [SC_FRI, SC_MON, SC_TUE]) setObservado(day, 900);
}

afterEach(() => {
  for (const [date, prior] of observadoBackup) {
    if (prior == null) db.prepare(`DELETE FROM fx_daily_bcentral WHERE date = ?`).run(date);
    else db.prepare(`UPDATE fx_daily_bcentral SET clp_per_usd = ? WHERE date = ?`).run(prior, date);
  }
  observadoBackup.clear();
  for (const ticker of SC_TICKERS) db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(ticker);
});

function previousMeta(compositionDate: string): CompositeMeta {
  return {
    bucket_slug: SC_BUCKET,
    fintual_managed_fund_id: 4,
    composition_date: compositionDate,
    anchor_fund_unit_clp: 4000,
    anchor_apv_fund_unit_clp: null,
    anchor_basket_usd: 55,
    anchor_fx_clp: 900,
    last_sync_ymd: compositionDate,
  };
}

function mondayAnchor(officialClp: number): CompositionAnchor {
  return {
    anchor_ymd: SC_MON,
    series_key: "vitest:rn:self-check",
    fund_unit_clp: officialClp,
    apv_fund_unit_clp: null,
    positions_ymd: SC_MON,
  };
}

// Basket Thursday → Monday: 0.5 × 110/100 + 0.5 × 10/10 = 1.05; Friday → Monday: 0.5 × 110/105 + 0.5.
const OFFICIAL_MON = 4000 * 1.05;

describe("compositionSelfCheck", () => {
  it("a consistently paired previous anchor predicts the new official cuota exactly", () => {
    seedSelfCheckFixture();
    const check = compositionSelfCheck(previousMeta(SC_THU), SC_HOLDINGS, mondayAnchor(OFFICIAL_MON))!;
    expect(check.previous_anchor_ymd).toBe(SC_THU);
    expect(check.anchor_ymd).toBe(SC_MON);
    expect(check.predicted_clp).toBeCloseTo(OFFICIAL_MON, 6);
    expect(check.error_bp).toBeCloseTo(0, 6);
    expect(check.alarm).toBe(false);
  });

  it("the old pairing — a carried cuota under Friday's closes — reads as a step change and alarms", () => {
    seedSelfCheckFixture();
    // The previous meta anchored on the Sunday carry of Thursday's valuation with Friday's closes as base.
    const check = compositionSelfCheck(previousMeta(SC_SUN), SC_HOLDINGS, mondayAnchor(OFFICIAL_MON))!;
    expect(check.predicted_clp).toBeCloseTo(4000 * (0.5 * (110 / 105) + 0.5), 6);
    expect(check.error_bp).toBeLessThan(-200);
    expect(check.alarm).toBe(true);
  });

  it("alarms only beyond the threshold", () => {
    seedSelfCheckFixture();
    const under = compositionSelfCheck(
      previousMeta(SC_THU),
      SC_HOLDINGS,
      mondayAnchor(OFFICIAL_MON * (1 + (RN_COMPOSITION_SELF_CHECK_ERROR_BP - 5) / 10_000))
    )!;
    expect(under.error_bp).toBeCloseTo(-(RN_COMPOSITION_SELF_CHECK_ERROR_BP - 5), 0);
    expect(under.alarm).toBe(false);
    const over = compositionSelfCheck(
      previousMeta(SC_THU),
      SC_HOLDINGS,
      mondayAnchor(OFFICIAL_MON * (1 + (RN_COMPOSITION_SELF_CHECK_ERROR_BP + 5) / 10_000))
    )!;
    expect(over.alarm).toBe(true);
  });

  it("is null without a previous anchor or when nothing newer was published", () => {
    seedSelfCheckFixture();
    expect(compositionSelfCheck(null, SC_HOLDINGS, mondayAnchor(OFFICIAL_MON))).toBeNull();
    expect(compositionSelfCheck(previousMeta(SC_THU), [], mondayAnchor(OFFICIAL_MON))).toBeNull();
    expect(compositionSelfCheck(previousMeta(SC_MON), SC_HOLDINGS, mondayAnchor(OFFICIAL_MON))).toBeNull();
  });
});
