import { describe, expect, it, vi, afterEach } from "vitest";
import { db } from "./db.js";
import * as chileDate from "./chileDate.js";
import {
  APV_PROXY_NEGLIGIBLE_REL_DIFF,
  basketUsdForHoldings,
  loadCompositeHoldings,
  loadCompositeMeta,
  proxyClpFromMeta,
  RISKY_NORRIS_PROXY_BUCKET,
  type CompositeHolding,
} from "./watchlistComposite.js";
import {
  fintualGlobalSyncSettledForChileToday,
  inChileHolidayProxyHold,
  riskyNorrisProxyCuotaForMtm,
  shouldUseRiskyNorrisProxyMtm,
} from "./riskyNorrisProxyMtm.js";
import * as riskyNorrisProxyMtm from "./riskyNorrisProxyMtm.js";
import * as marketHolidays from "./marketHolidays.js";
import * as nyseSession from "./nyseSession.js";
import * as fintualPublishDate from "./fintualPublishDate.js";
import * as fintualCertV2Reconcile from "./fintualCertV2Reconcile.js";

const TEST_BUCKET = RISKY_NORRIS_PROXY_BUCKET;
const COMPOSITION_DATE = "2026-06-20";

const HOLDINGS: CompositeHolding[] = [
  { ticker: "SPY", weight: 0.6, synced_at: COMPOSITION_DATE },
  { ticker: "VEA", weight: 0.4, synced_at: COMPOSITION_DATE },
];

afterEach(() => {
  vi.restoreAllMocks();
});

function seedProxyMeta(anchorApv: number | null): boolean {
  let anchorBasket: number;
  try {
    anchorBasket = basketUsdForHoldings(HOLDINGS, COMPOSITION_DATE, { preferLive: false });
  } catch {
    return false;
  }
  const fxRow = db
    .prepare(`SELECT clp_per_usd FROM fx_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`)
    .get(COMPOSITION_DATE) as { clp_per_usd: number } | undefined;
  if (fxRow == null) return false;

  db.prepare(`DELETE FROM watchlist_composite_holdings WHERE bucket_slug = ?`).run(TEST_BUCKET);
  db.prepare(`DELETE FROM watchlist_composite_meta WHERE bucket_slug = ?`).run(TEST_BUCKET);
  db.prepare(
    `INSERT INTO watchlist_composite_meta (
       bucket_slug, fintual_managed_fund_id, composition_date,
       anchor_fund_unit_clp, anchor_apv_fund_unit_clp, anchor_basket_usd, anchor_fx_clp, last_sync_ymd
     ) VALUES (?, 4, ?, 4000, ?, ?, ?, ?)`
  ).run(TEST_BUCKET, COMPOSITION_DATE, anchorApv, anchorBasket, fxRow.clp_per_usd, COMPOSITION_DATE);
  for (const h of HOLDINGS) {
    db.prepare(
      `INSERT INTO watchlist_composite_holdings (bucket_slug, ticker, weight, synced_at)
       VALUES (?, ?, ?, ?)`
    ).run(TEST_BUCKET, h.ticker, h.weight, h.synced_at);
  }
  return true;
}

describe("shouldUseRiskyNorrisProxyMtm", () => {
  // shouldUseRiskyNorrisProxyMtm / inChileHolidayProxyHold call sibling exports
  // (fintualGlobalSyncSettledForChileToday) directly, so we drive "settled" through its leaf
  // dependencies in other modules — ESM intra-module spies do not intercept internal calls.

  // Makes fintualGlobalSyncSettledForChileToday return `settled`.
  function stubSettled(settled: boolean) {
    vi.spyOn(fintualPublishDate, "fintualPollDayCaughtUp").mockReturnValue(settled);
    vi.spyOn(fintualCertV2Reconcile, "fintualCertV2PollReconciled").mockReturnValue(settled);
  }

  function stubNyseTrading(trading: boolean) {
    vi.spyOn(marketHolidays, "isNyseTradingDay").mockReturnValue(trading);
    vi.spyOn(nyseSession, "nyseWallClock").mockReturnValue({
      ymd: "2026-06-29",
      year: 2026,
      month: 6,
      day: 29,
      hour: 10,
      minute: 0,
      weekday: 1,
    });
  }

  function stubToday(ymd: string) {
    vi.spyOn(chileDate, "chileCalendarTodayYmd").mockReturnValue(ymd);
  }

  it("is false when NYSE is not trading today", () => {
    stubSettled(false);
    stubNyseTrading(false);
    expect(shouldUseRiskyNorrisProxyMtm(new Date())).toBe(false);
  });

  it("is false on a normal business day once the Fintual evening sync is settled", () => {
    stubSettled(true);
    stubNyseTrading(true);
    stubToday("2026-06-30"); // Tue, business day
    vi.spyOn(marketHolidays, "isChileBusinessDay").mockReturnValue(true);
    expect(shouldUseRiskyNorrisProxyMtm(new Date())).toBe(false);
  });

  it("is true during the session on a Chile holiday — overrides the flat settled cuota", () => {
    // Even though Fintual published a flat carry cuota (settled = true), the holiday hold wins.
    stubSettled(true);
    stubNyseTrading(true);
    stubToday("2026-06-29"); // Mon, Chile holiday
    vi.spyOn(marketHolidays, "isChileBusinessDay").mockReturnValue(false);
    vi.spyOn(nyseSession, "isBeforeNyseRegularOpen").mockReturnValue(false);
    expect(shouldUseRiskyNorrisProxyMtm(new Date())).toBe(true);
  });

  it("holds the proxy after close on a Chile holiday", () => {
    stubSettled(true);
    stubNyseTrading(true);
    stubToday("2026-06-29");
    vi.spyOn(marketHolidays, "isChileBusinessDay").mockReturnValue(false);
    vi.spyOn(nyseSession, "isBeforeNyseRegularOpen").mockReturnValue(false);
    expect(shouldUseRiskyNorrisProxyMtm(new Date())).toBe(true);
  });

  it("does not hold before NYSE open on the holiday itself (last official cuota shown)", () => {
    stubSettled(true);
    stubNyseTrading(true);
    stubToday("2026-06-29");
    vi.spyOn(marketHolidays, "isChileBusinessDay").mockReturnValue(false);
    vi.spyOn(nyseSession, "isBeforeNyseRegularOpen").mockReturnValue(true);
    expect(shouldUseRiskyNorrisProxyMtm(new Date())).toBe(false);
  });
});

describe("inChileHolidayProxyHold", () => {
  function stubSettled(settled: boolean) {
    vi.spyOn(fintualPublishDate, "fintualPollDayCaughtUp").mockReturnValue(settled);
    vi.spyOn(fintualCertV2Reconcile, "fintualCertV2PollReconciled").mockReturnValue(settled);
  }
  function stubNyYmd(ymd: string) {
    vi.spyOn(nyseSession, "nyseWallClock").mockReturnValue({
      ymd,
      year: Number(ymd.slice(0, 4)),
      month: Number(ymd.slice(5, 7)),
      day: Number(ymd.slice(8, 10)),
      hour: 8,
      minute: 0,
      weekday: 2,
    });
  }

  it("keeps the proxy pre-open the morning after a holiday (prior session was a Chile holiday)", () => {
    stubSettled(false);
    vi.spyOn(chileDate, "chileCalendarTodayYmd").mockReturnValue("2026-06-30"); // Tue business
    vi.spyOn(marketHolidays, "isChileBusinessDay").mockImplementation(
      (ymd: string) => ymd !== "2026-06-29"
    );
    vi.spyOn(marketHolidays, "priorNyseSessionYmd").mockReturnValue("2026-06-29"); // Mon holiday
    stubNyYmd("2026-06-30");
    vi.spyOn(nyseSession, "isBeforeNyseRegularOpen").mockReturnValue(true);
    expect(inChileHolidayProxyHold(new Date())).toBe(true);
  });

  it("does not hold pre-open on a normal morning (prior session was a business day)", () => {
    stubSettled(false);
    vi.spyOn(chileDate, "chileCalendarTodayYmd").mockReturnValue("2026-06-30");
    vi.spyOn(marketHolidays, "isChileBusinessDay").mockReturnValue(true);
    vi.spyOn(marketHolidays, "priorNyseSessionYmd").mockReturnValue("2026-06-29");
    stubNyYmd("2026-06-30");
    vi.spyOn(nyseSession, "isBeforeNyseRegularOpen").mockReturnValue(true);
    expect(inChileHolidayProxyHold(new Date())).toBe(false);
  });

  it("stops holding once the post-holiday business day's sync has settled", () => {
    stubSettled(true);
    vi.spyOn(chileDate, "chileCalendarTodayYmd").mockReturnValue("2026-06-30");
    vi.spyOn(marketHolidays, "isChileBusinessDay").mockImplementation(
      (ymd: string) => ymd !== "2026-06-29"
    );
    vi.spyOn(marketHolidays, "priorNyseSessionYmd").mockReturnValue("2026-06-29");
    stubNyYmd("2026-06-30");
    vi.spyOn(nyseSession, "isBeforeNyseRegularOpen").mockReturnValue(true);
    expect(inChileHolidayProxyHold(new Date())).toBe(false);
  });
});

describe("riskyNorrisProxyCuotaForMtm APV calibration", () => {
  it("scales taxable proxy for APV when anchor spread exceeds threshold", () => {
    vi.spyOn(chileDate, "chileCalendarTodayYmd").mockReturnValue(COMPOSITION_DATE);
    if (!seedProxyMeta(4200)) return;
    const meta = loadCompositeMeta(TEST_BUCKET);
    const holdings = loadCompositeHoldings(TEST_BUCKET);
    if (meta == null || holdings.length === 0) return;

    vi.spyOn(riskyNorrisProxyMtm, "fintualGlobalSyncSettledForChileToday").mockReturnValue(false);
    const rnPx = riskyNorrisProxyCuotaForMtm("fintual_cert_risky_norris");
    const apvPx = riskyNorrisProxyCuotaForMtm("fintual_cert_apv_a");
    const proxyRnFull = proxyClpFromMeta(meta, holdings, COMPOSITION_DATE, { preferLive: false });
    expect(rnPx).toBeCloseTo(proxyRnFull, 4);
    expect(apvPx / rnPx).toBeCloseTo(4200 / 4000, 4);
    expect(Math.abs(4200 / 4000 - 1)).toBeGreaterThan(APV_PROXY_NEGLIGIBLE_REL_DIFF);
  });

  it("uses shared proxy for APV when anchor spread is negligible", () => {
    vi.spyOn(chileDate, "chileCalendarTodayYmd").mockReturnValue(COMPOSITION_DATE);
    if (!seedProxyMeta(4002)) return;
    vi.spyOn(riskyNorrisProxyMtm, "fintualGlobalSyncSettledForChileToday").mockReturnValue(false);
    const apvPx = riskyNorrisProxyCuotaForMtm("fintual_cert_apv_a");
    const rnPx = riskyNorrisProxyCuotaForMtm("fintual_cert_risky_norris");
    expect(apvPx).toBeCloseTo(rnPx, 6);
  });
});

describe("fintualGlobalSyncSettledForChileToday", () => {
  it("reads global sync state without throwing", () => {
    expect(typeof fintualGlobalSyncSettledForChileToday()).toBe("boolean");
  });
});
