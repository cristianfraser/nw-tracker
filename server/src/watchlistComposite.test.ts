import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import { db } from "./db.js";
import { observadoFrameFxForDay } from "./fxObservadoFrame.js";
import {
  basketUsdForHoldings,
  compositeLiveStats,
  loadCompositeHoldings,
  loadCompositeMeta,
  proxyClpFromMeta,
  type CompositeHolding,
} from "./watchlistComposite.js";
import { watchlistStatsForRow } from "./watchlistStats.js";
import type { MarketDisplaySeriesRow } from "./marketDisplaySeries.js";

const TEST_BUCKET = "vitest_rn_proxy";
const COMPOSITION_DATE = "2026-06-20";

const HOLDINGS: CompositeHolding[] = [
  { ticker: "SPY", weight: 0.6, synced_at: COMPOSITION_DATE },
  { ticker: "VEA", weight: 0.4, synced_at: COMPOSITION_DATE },
];

/**
 * The proxy's fx frame is the dólar observado (`fx_daily_bcentral`, keyed by PUBLICATION date:
 * day D reads the first row after D). Fixtures seed the rows they need and restore the shared
 * table afterwards — date → pre-test clp_per_usd (null = row absent).
 */
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

/** Removes a publication the fixture's window must not contain (restored afterwards like `setObservado`). */
function clearObservado(date: string): void {
  if (!observadoBackup.has(date)) {
    const prior = db.prepare(`SELECT clp_per_usd FROM fx_daily_bcentral WHERE date = ?`).get(date) as
      | { clp_per_usd: number }
      | undefined;
    observadoBackup.set(date, prior?.clp_per_usd ?? null);
  }
  db.prepare(`DELETE FROM fx_daily_bcentral WHERE date = ?`).run(date);
}

afterEach(() => {
  for (const [date, prior] of observadoBackup) {
    if (prior == null) {
      db.prepare(`DELETE FROM fx_daily_bcentral WHERE date = ?`).run(date);
    } else {
      db.prepare(
        `INSERT INTO fx_daily_bcentral (date, clp_per_usd) VALUES (?, ?)
         ON CONFLICT(date) DO UPDATE SET clp_per_usd = excluded.clp_per_usd`
      ).run(date, prior);
    }
  }
  observadoBackup.clear();
});

afterEach(() => {
  db.prepare(`DELETE FROM watchlist_composite_holdings WHERE bucket_slug = ?`).run(TEST_BUCKET);
  db.prepare(`DELETE FROM watchlist_composite_meta WHERE bucket_slug = ?`).run(TEST_BUCKET);
});

function seedCompositeFixture(): void {
  const holdings = HOLDINGS;
  let anchorBasket: number;
  let anchorFx: number;
  try {
    anchorBasket = basketUsdForHoldings(holdings, COMPOSITION_DATE, { preferLive: false });
    anchorFx = observadoFrameFxForDay(COMPOSITION_DATE).clp_per_usd;
  } catch {
    return;
  }

  db.prepare(
    `INSERT INTO watchlist_composite_meta (
       bucket_slug, fintual_managed_fund_id, composition_date,
       anchor_fund_unit_clp, anchor_apv_fund_unit_clp, anchor_basket_usd, anchor_fx_clp, last_sync_ymd
     ) VALUES (?, 4, ?, 4000, NULL, ?, ?, ?)`
  ).run(TEST_BUCKET, COMPOSITION_DATE, anchorBasket, anchorFx, COMPOSITION_DATE);
  for (const h of holdings) {
    db.prepare(
      `INSERT INTO watchlist_composite_holdings (bucket_slug, ticker, weight, synced_at)
       VALUES (?, ?, ?, ?)`
    ).run(TEST_BUCKET, h.ticker, h.weight, h.synced_at);
  }
}

describe("watchlistComposite valuation", () => {
  it("computes basket USD from equity_daily when prices exist", () => {
    seedCompositeFixture();
    const holdings = loadCompositeHoldings(TEST_BUCKET);
    if (holdings.length === 0) return;
    const basket = basketUsdForHoldings(holdings, COMPOSITION_DATE, { preferLive: false });
    expect(basket).toBeGreaterThan(0);
    expect(Number.isFinite(basket)).toBe(true);
  });

  it("proxy CLP scales with basket and FX vs anchor", () => {
    seedCompositeFixture();
    const meta = loadCompositeMeta(TEST_BUCKET);
    if (meta == null) return;
    const holdings = loadCompositeHoldings(TEST_BUCKET);
    const atAnchor = proxyClpFromMeta(meta, holdings, COMPOSITION_DATE, { preferLive: false });
    expect(atAnchor).toBeCloseTo(4000, 0);
  });
});

const SESSION_BUCKET = "vitest_rn_proxy_session";
const SESSION_TICKERS = ["VITESTRNA", "VITESTRNB"] as const;
/** Mon–Fri NYSE trading days, all in the past so live-quote paths never engage. */
const SESSION_DAYS = ["2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25", "2026-06-26"];
/** Observado publications covering each session day (day D reads the first row after D). */
const SESSION_OBSERVADO_DATES = ["2026-06-23", "2026-06-24", "2026-06-25", "2026-06-26", "2026-06-29"];

/** Synthetic tickers + closes so day_pct assertions do not depend on live-DB market data. */
function seedSessionFixture(): void {
  const closes: Record<(typeof SESSION_TICKERS)[number], number[]> = {
    VITESTRNA: [100, 101, 102, 103, 104],
    VITESTRNB: [50, 50.5, 51, 51.5, 52],
  };
  for (const ticker of SESSION_TICKERS) {
    SESSION_DAYS.forEach((day, i) => {
      db.prepare(
        `INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'usd')
         ON CONFLICT(ticker, trade_date) DO UPDATE SET close = excluded.close, currency = excluded.currency`
      ).run(ticker, day, closes[ticker][i]);
    });
  }
  for (const date of SESSION_OBSERVADO_DATES) setObservado(date, 950);

  const holdings: CompositeHolding[] = [
    { ticker: "VITESTRNA", weight: 0.6, synced_at: SESSION_DAYS[0]! },
    { ticker: "VITESTRNB", weight: 0.4, synced_at: SESSION_DAYS[0]! },
  ];
  const anchorBasket = basketUsdForHoldings(holdings, SESSION_DAYS[0]!, { preferLive: false });
  const anchorFx = observadoFrameFxForDay(SESSION_DAYS[0]!).clp_per_usd;
  db.prepare(
    `INSERT INTO watchlist_composite_meta (
       bucket_slug, fintual_managed_fund_id, composition_date,
       anchor_fund_unit_clp, anchor_apv_fund_unit_clp, anchor_basket_usd, anchor_fx_clp, last_sync_ymd
     ) VALUES (?, 4, ?, 4000, NULL, ?, ?, ?)`
  ).run(SESSION_BUCKET, SESSION_DAYS[0], anchorBasket, anchorFx, SESSION_DAYS[0]);
  for (const h of holdings) {
    db.prepare(
      `INSERT INTO watchlist_composite_holdings (bucket_slug, ticker, weight, synced_at)
       VALUES (?, ?, ?, ?)`
    ).run(SESSION_BUCKET, h.ticker, h.weight, h.synced_at);
  }
}

afterEach(() => {
  db.prepare(`DELETE FROM watchlist_composite_holdings WHERE bucket_slug = ?`).run(SESSION_BUCKET);
  db.prepare(`DELETE FROM watchlist_composite_meta WHERE bucket_slug = ?`).run(SESSION_BUCKET);
  for (const ticker of SESSION_TICKERS) {
    db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(ticker);
  }
});

describe("compositeLiveStats session anchoring", () => {
  function expectedDayPct(prevYmd: string, sessionYmd: string): number {
    const meta = loadCompositeMeta(SESSION_BUCKET)!;
    const holdings = loadCompositeHoldings(SESSION_BUCKET);
    const live = proxyClpFromMeta(meta, holdings, sessionYmd, { preferLive: false });
    const prior = proxyClpFromMeta(meta, holdings, prevYmd, { preferLive: false });
    return ((live - prior) / prior) * 100;
  }

  it("pre-open Friday shows Thursday session vs Wednesday (not 0%)", () => {
    seedSessionFixture();
    // 01:00 Chile / 01:00 NY, Friday 2026-06-26 — before NYSE open.
    const now = new Date("2026-06-26T01:00:00-04:00");
    const stats = compositeLiveStats(SESSION_BUCKET, now);
    expect(stats.as_of_date).toBe("2026-06-25");
    expect(stats.day_pct).not.toBeNull();
    expect(stats.day_pct!).toBeCloseTo(expectedDayPct("2026-06-24", "2026-06-25"), 6);
    expect(stats.day_pct!).not.toBeCloseTo(0, 3);
  });

  it("Sunday shows Friday session vs Thursday", () => {
    seedSessionFixture();
    const now = new Date("2026-06-28T12:00:00-04:00");
    const stats = compositeLiveStats(SESSION_BUCKET, now);
    expect(stats.as_of_date).toBe("2026-06-26");
    expect(stats.day_pct).not.toBeNull();
    expect(stats.day_pct!).toBeCloseTo(expectedDayPct("2026-06-25", "2026-06-26"), 6);
  });

  it("after Friday close shows Friday session vs Thursday", () => {
    seedSessionFixture();
    const now = new Date("2026-06-26T18:00:00-04:00");
    const stats = compositeLiveStats(SESSION_BUCKET, now);
    expect(stats.as_of_date).toBe("2026-06-26");
    expect(stats.day_pct!).toBeCloseTo(expectedDayPct("2026-06-25", "2026-06-26"), 6);
  });
});

const VALUE_WEIGHT_BUCKET = "vitest_rn_proxy_value_weights";
const VW_TICKERS = ["VITESTRNC", "VITESTRND"] as const;
/** Mon/Tue NYSE trading days in the past so live-quote paths never engage. */
const VW_DAYS = ["2026-07-06", "2026-07-07"] as const;
/** Observado published the morning after each VW day: 950 for Monday's trades, 955 for Tuesday's. */
const VW_OBSERVADO: Record<string, number> = { "2026-07-07": 950, "2026-07-08": 955 };

/**
 * Divergent price magnitudes AND returns: C US$xxx→110 (+10%), D US$10→10 (0%), both at
 * weight 0.5. Value-weighted the basket moves +5%; the old Σ w·px level ratio read
 * (55+5)/55 = +9.09% because C's share price out-voted its weight.
 */
function seedValueWeightFixture(): void {
  const closes: Record<(typeof VW_TICKERS)[number], number[]> = {
    VITESTRNC: [100, 110],
    VITESTRND: [10, 10],
  };
  for (const ticker of VW_TICKERS) {
    VW_DAYS.forEach((day, i) => {
      db.prepare(
        `INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'usd')
         ON CONFLICT(ticker, trade_date) DO UPDATE SET close = excluded.close, currency = excluded.currency`
      ).run(ticker, day, closes[ticker][i]);
    });
  }
  for (const [date, value] of Object.entries(VW_OBSERVADO)) setObservado(date, value);

  const holdings: CompositeHolding[] = [
    { ticker: "VITESTRNC", weight: 0.5, synced_at: VW_DAYS[0] },
    { ticker: "VITESTRND", weight: 0.5, synced_at: VW_DAYS[0] },
  ];
  const anchorBasket = basketUsdForHoldings(holdings, VW_DAYS[0], { preferLive: false });
  const anchorFx = observadoFrameFxForDay(VW_DAYS[0]).clp_per_usd;
  db.prepare(
    `INSERT INTO watchlist_composite_meta (
       bucket_slug, fintual_managed_fund_id, composition_date,
       anchor_fund_unit_clp, anchor_apv_fund_unit_clp, anchor_basket_usd, anchor_fx_clp, last_sync_ymd
     ) VALUES (?, 4, ?, 4000, NULL, ?, ?, ?)`
  ).run(VALUE_WEIGHT_BUCKET, VW_DAYS[0], anchorBasket, anchorFx, VW_DAYS[0]);
  for (const h of holdings) {
    db.prepare(
      `INSERT INTO watchlist_composite_holdings (bucket_slug, ticker, weight, synced_at)
       VALUES (?, ?, ?, ?)`
    ).run(VALUE_WEIGHT_BUCKET, h.ticker, h.weight, h.synced_at);
  }
}

afterEach(() => {
  db.prepare(`DELETE FROM watchlist_composite_holdings WHERE bucket_slug = ?`).run(VALUE_WEIGHT_BUCKET);
  db.prepare(`DELETE FROM watchlist_composite_meta WHERE bucket_slug = ?`).run(VALUE_WEIGHT_BUCKET);
  for (const ticker of VW_TICKERS) {
    db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(ticker);
  }
});

describe("proxyClpFromMeta value weighting", () => {
  it("weights are value fractions, not share counts", () => {
    seedValueWeightFixture();
    const meta = loadCompositeMeta(VALUE_WEIGHT_BUCKET)!;
    const holdings = loadCompositeHoldings(VALUE_WEIGHT_BUCKET);

    const atAnchor = proxyClpFromMeta(meta, holdings, VW_DAYS[0], { preferLive: false });
    expect(atAnchor).toBeCloseTo(4000, 6);

    // Both legs in the observado frame: Tuesday's cuota embeds Tuesday's interbank average,
    // published Wednesday morning (955), against Monday's (950, published Tuesday).
    const fxRatio =
      observadoFrameFxForDay(VW_DAYS[1]).clp_per_usd / observadoFrameFxForDay(VW_DAYS[0]).clp_per_usd;
    expect(fxRatio).toBeCloseTo(955 / 950, 10);

    const next = proxyClpFromMeta(meta, holdings, VW_DAYS[1], { preferLive: false });
    // 0.5×(110/100) + 0.5×(10/10) = 1.05 — the fund's value-weighted move.
    expect(next / atAnchor).toBeCloseTo(1.05 * fxRatio, 8);
    // The share-count reading Σ w·px(d)/Σ w·px(0) = 60/55 would land ~4% higher.
    expect(next / atAnchor).not.toBeCloseTo((60 / 55) * fxRatio, 2);
  });
});

const WEEKEND_ANCHOR_BUCKET = "vitest_rn_proxy_weekend_anchor";
const WA_TICKERS = ["VITESTRNE", "VITESTRNF"] as const;
/** Fri / Sat / Sun / Mon / Tue around a weekend composition date. */
const WA_FRI = "2026-07-10";
const WA_SAT = "2026-07-11";
const WA_SUN = "2026-07-12";
const WA_MON = "2026-07-13";
const WA_TUE = "2026-07-14";

/**
 * Weekend composition anchor in the observado frame: equity closes exist Friday and Monday
 * only, and the observado is published on bank business days — Friday's trades print on
 * Monday (900), Monday's on Tuesday (905). Friday, Saturday and Sunday therefore all read
 * Monday's publication (the weekend cuotas carry Friday's dólar), and a Sunday composition
 * date anchors on exactly that value. Yahoo's Sunday week-open CLP=X bar plays no part: the
 * frame never reads fx_daily.
 */
function seedWeekendAnchorFixture(): void {
  const closes: Record<(typeof WA_TICKERS)[number], Record<string, number>> = {
    VITESTRNE: { [WA_FRI]: 100, [WA_MON]: 110 },
    VITESTRNF: { [WA_FRI]: 10, [WA_MON]: 10 },
  };
  for (const ticker of WA_TICKERS) {
    for (const [day, close] of Object.entries(closes[ticker])) {
      db.prepare(
        `INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'usd')
         ON CONFLICT(ticker, trade_date) DO UPDATE SET close = excluded.close, currency = excluded.currency`
      ).run(ticker, day, close);
    }
  }
  setObservado(WA_FRI, 890); // Friday's publication = Thursday's trades — must not be read for Friday
  // The bank publishes nothing on a weekend; the synthetic test DB's calendar-day series does.
  clearObservado(WA_SAT);
  clearObservado(WA_SUN);
  setObservado(WA_MON, 900); // Monday's publication = Friday's trades
  setObservado(WA_TUE, 905); // Tuesday's publication = Monday's trades

  const holdings: CompositeHolding[] = [
    { ticker: "VITESTRNE", weight: 0.5, synced_at: WA_SUN },
    { ticker: "VITESTRNF", weight: 0.5, synced_at: WA_SUN },
  ];
  // Anchor fx exactly as the composition sync resolves it for a Sunday composition_date.
  const anchorFx = observadoFrameFxForDay(WA_SUN).clp_per_usd;
  db.prepare(
    `INSERT INTO watchlist_composite_meta (
       bucket_slug, fintual_managed_fund_id, composition_date,
       anchor_fund_unit_clp, anchor_apv_fund_unit_clp, anchor_basket_usd, anchor_fx_clp, last_sync_ymd
     ) VALUES (?, 4, ?, 4000, NULL, ?, ?, ?)`
  ).run(
    WEEKEND_ANCHOR_BUCKET,
    WA_SUN,
    basketUsdForHoldings(holdings, WA_SUN, { preferLive: false }),
    anchorFx,
    WA_SUN
  );
  for (const h of holdings) {
    db.prepare(
      `INSERT INTO watchlist_composite_holdings (bucket_slug, ticker, weight, synced_at)
       VALUES (?, ?, ?, ?)`
    ).run(WEEKEND_ANCHOR_BUCKET, h.ticker, h.weight, h.synced_at);
  }
}

afterEach(() => {
  db.prepare(`DELETE FROM watchlist_composite_holdings WHERE bucket_slug = ?`).run(WEEKEND_ANCHOR_BUCKET);
  db.prepare(`DELETE FROM watchlist_composite_meta WHERE bucket_slug = ?`).run(WEEKEND_ANCHOR_BUCKET);
  for (const ticker of WA_TICKERS) {
    db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(ticker);
  }
});

describe("weekend anchors in the observado frame", () => {
  it("Friday, Saturday and Sunday all read Monday's publication; Monday reads Tuesday's", () => {
    seedWeekendAnchorFixture();
    for (const day of [WA_FRI, WA_SAT, WA_SUN]) {
      const fx = observadoFrameFxForDay(day);
      expect(fx.source).toBe("published");
      expect(fx.as_of).toBe(WA_MON);
      expect(fx.clp_per_usd).toBe(900);
    }
    expect(observadoFrameFxForDay(WA_MON)).toEqual({ clp_per_usd: 905, source: "published", as_of: WA_TUE });
  });

  it("a Sunday composition date anchors on Friday's interbank dólar and holds the anchor identity", () => {
    seedWeekendAnchorFixture();
    const meta = loadCompositeMeta(WEEKEND_ANCHOR_BUCKET)!;
    const holdings = loadCompositeHoldings(WEEKEND_ANCHOR_BUCKET);
    expect(meta.anchor_fx_clp).toBe(900);

    // Anchor identity: proxy at the composition date is the anchor cuota exactly.
    const atAnchor = proxyClpFromMeta(meta, holdings, WA_SUN, { preferLive: false });
    expect(atAnchor).toBeCloseTo(4000, 8);

    // Weekends are flat: nothing repriced between Friday's close and Sunday, and Friday's own
    // publication (Thursday's trades, 890) is never the frame for Friday.
    const atFri = proxyClpFromMeta(meta, holdings, WA_FRI, { preferLive: false });
    const atSat = proxyClpFromMeta(meta, holdings, WA_SAT, { preferLive: false });
    expect(atFri).toBeCloseTo(atAnchor, 8);
    expect(atSat).toBeCloseTo(atAnchor, 8);
    expect(atFri).not.toBeCloseTo(4000 * (890 / 900), 0);
  });

  it("Monday reprices with Monday's interbank dólar, published Tuesday", () => {
    seedWeekendAnchorFixture();
    const meta = loadCompositeMeta(WEEKEND_ANCHOR_BUCKET)!;
    const holdings = loadCompositeHoldings(WEEKEND_ANCHOR_BUCKET);
    const atMon = proxyClpFromMeta(meta, holdings, WA_MON, { preferLive: false });
    // 0.5×(110/100) + 0.5×(10/10) = 1.05 basket leg; fx leg 905/900.
    expect(atMon).toBeCloseTo(4000 * 1.05 * (905 / 900), 6);
  });
});

describe("watchlistStatsForRow composite", () => {
  it("returns CLP stats for composite row when meta exists", () => {
    seedCompositeFixture();
    const row: MarketDisplaySeriesRow = {
      id: 9999,
      slug: TEST_BUCKET,
      label: "Test proxy",
      label_i18n_key: null,
      sort_order: 0,
      kind: "composite",
      series_key: TEST_BUCKET,
      show_in_marquee: 0,
      show_in_rates: 0,
      rates_chart_title: null,
      source: "builtin",
    };
    const stats = watchlistStatsForRow(row);
    if (stats.value == null) return;
    expect(stats.value_currency).toBe("clp");
    expect(stats.changes).not.toBeNull();
  });
});
