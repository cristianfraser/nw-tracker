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
  fintualGlobalSyncSettledForChileDay,
  inChileHolidayProxyHold,
  riskyNorrisProxyAppliesOnYmd,
  riskyNorrisProxyCuotaForMtm,
  shouldUseRiskyNorrisProxyMtm,
} from "./riskyNorrisProxyMtm.js";
import * as marketHolidays from "./marketHolidays.js";
import * as nyseSession from "./nyseSession.js";
import * as fintualPublishDate from "./fintualPublishDate.js";
import * as fintualCertV2Reconcile from "./fintualCertV2Reconcile.js";
import * as globalSyncState from "./globalSyncState.js";

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
  // (fintualGlobalSyncSettledForChileDay) directly, so we drive "settled" through its leaf
  // dependencies in other modules — ESM intra-module spies do not intercept internal calls.

  // Makes fintualGlobalSyncSettledForChileDay return `settled` for every day.
  function stubSettled(settled: boolean) {
    vi.spyOn(fintualPublishDate, "fintualPollDayCaughtUp").mockReturnValue(settled);
    vi.spyOn(fintualCertV2Reconcile, "fintualCertV2PollReconciled").mockReturnValue(settled);
  }

  // Makes fintualGlobalSyncSettledForChileDay return true ONLY for `settledYmd` — the evening
  // poll landed that day's cuota and nothing later exists yet.
  function stubSettledForDay(settledYmd: string) {
    vi.spyOn(fintualPublishDate, "fintualPollDayCaughtUp").mockImplementation(
      (pollYmd: string) => pollYmd === settledYmd
    );
    vi.spyOn(fintualCertV2Reconcile, "fintualCertV2PollReconciled").mockReturnValue(true);
  }

  /** The historical predicate reads only the applied publish day of the sync state. */
  function stubAppliedPublishYmd(appliedYmd: string | null) {
    vi.spyOn(globalSyncState, "loadGlobalSyncState").mockReturnValue(
      appliedYmd == null ? {} : { fintualLastAppliedPublishYmd: appliedYmd }
    );
  }

  function stubNyClock(ymd: string, hour: number, minute = 0) {
    vi.spyOn(nyseSession, "nyseWallClock").mockReturnValue({
      ymd,
      year: Number(ymd.slice(0, 4)),
      month: Number(ymd.slice(5, 7)),
      day: Number(ymd.slice(8, 10)),
      hour,
      minute,
      weekday: 1,
    });
  }

  function stubNyseTrading(trading: boolean) {
    vi.spyOn(marketHolidays, "isNyseTradingDay").mockReturnValue(trading);
    stubNyClock("2026-06-29", 10);
  }

  // The gate never reads the Chile calendar day (see fintualGlobalSyncSettledForChileDay);
  // the stub documents which Chile day each scenario sits on.
  function stubToday(ymd: string) {
    vi.spyOn(chileDate, "chileCalendarTodayYmd").mockReturnValue(ymd);
  }

  it("is false when NYSE is not trading today (and the last session was a Chile business day)", () => {
    stubSettled(false);
    stubNyseTrading(false);
    vi.spyOn(marketHolidays, "isChileBusinessDay").mockReturnValue(true);
    vi.spyOn(marketHolidays, "priorNyseSessionYmd").mockReturnValue("2026-06-26");
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
    // Fintual published a flat carry cuota for the holiday (settled for 06-29), but the first
    // cuota that can reflect the session is Tuesday's, and that evening has not happened.
    stubSettledForDay("2026-06-29");
    stubNyseTrading(true);
    stubToday("2026-06-29"); // Mon, Chile holiday
    vi.spyOn(marketHolidays, "isChileBusinessDay").mockImplementation((ymd: string) => ymd !== "2026-06-29");
    vi.spyOn(nyseSession, "isBeforeNyseRegularOpen").mockReturnValue(false);
    expect(shouldUseRiskyNorrisProxyMtm(new Date())).toBe(true);
  });

  it("holds the proxy after close on a Chile holiday", () => {
    stubSettledForDay("2026-06-29");
    stubNyseTrading(true);
    stubToday("2026-06-29");
    vi.spyOn(marketHolidays, "isChileBusinessDay").mockImplementation((ymd: string) => ymd !== "2026-06-29");
    vi.spyOn(nyseSession, "isBeforeNyseRegularOpen").mockReturnValue(false);
    expect(shouldUseRiskyNorrisProxyMtm(new Date())).toBe(true);
  });

  it("does not hold before NYSE open on the holiday itself (last official cuota shown)", () => {
    stubSettledForDay("2026-06-29");
    stubNyseTrading(true);
    stubToday("2026-06-29");
    vi.spyOn(marketHolidays, "isChileBusinessDay").mockImplementation((ymd: string) => ymd !== "2026-06-29");
    vi.spyOn(nyseSession, "isBeforeNyseRegularOpen").mockReturnValue(true);
    expect(shouldUseRiskyNorrisProxyMtm(new Date())).toBe(false);
  });

  // Chile runs ahead of New York (1h since Chile's 2026-09-06 spring-forward, 2h once New York
  // falls back): between Chile midnight and New York midnight the Chile day has rolled but the
  // session has not. 2026-09-11 00:00–01:00 Chile re-armed the proxy against the settled 09-10
  // cuota (APV +286k) and snapped back at 01:00. These scenarios use real instants — the NYSE
  // clock helpers call each other inside their module, so a namespace spy on nyseWallClock
  // would not reach isBeforeNyseRegularOpen.
  it("keeps the official cuota in the Chile-midnight gap after a settled evening (business day)", () => {
    stubSettledForDay("2026-09-10"); // Thu evening poll landed the 09-10 cuota; no 09-11 poll yet
    const now = new Date("2026-09-11T03:09:00Z"); // Chile Fri 00:09 (UTC−3), New York Thu 23:09 (EDT)
    expect(chileDate.chileWallClockAt(now).ymd).toBe("2026-09-11");
    expect(nyseSession.nyseWallClock(now).ymd).toBe("2026-09-10");
    expect(nyseSession.isBeforeNyseRegularOpen(now)).toBe(false);
    expect(shouldUseRiskyNorrisProxyMtm(now)).toBe(false);
  });

  it("keeps the official cuota in the Chile-midnight gap into a weekend (Friday session, settled)", () => {
    // Saturday 00:30 Chile = Friday 23:30 New York. Friday is a Chile business day whose cuota
    // settled at the evening poll; the Chile-day-is-Saturday framing used to take the holiday
    // hold and show the Friday EOD proxy for the hour.
    stubSettledForDay("2026-09-11");
    const now = new Date("2026-09-12T03:30:00Z");
    expect(chileDate.chileWallClockAt(now).ymd).toBe("2026-09-12");
    expect(marketHolidays.isChileBusinessDay("2026-09-12")).toBe(false);
    expect(nyseSession.nyseWallClock(now).ymd).toBe("2026-09-11");
    expect(inChileHolidayProxyHold(now)).toBe(false);
    expect(shouldUseRiskyNorrisProxyMtm(now)).toBe(false);
  });

  it("re-arms at the next NYSE open, not at Chile midnight", () => {
    stubSettledForDay("2026-09-10");
    const preOpen = new Date("2026-09-11T13:29:00Z"); // Fri 09:29 New York
    expect(nyseSession.isBeforeNyseRegularOpen(preOpen)).toBe(true);
    expect(shouldUseRiskyNorrisProxyMtm(preOpen)).toBe(false);
    const open = new Date("2026-09-11T13:30:00Z"); // Fri 09:30 New York: the 09-10 settle no longer covers the session
    expect(nyseSession.isBeforeNyseRegularOpen(open)).toBe(false);
    expect(shouldUseRiskyNorrisProxyMtm(open)).toBe(true);
  });

  it("keeps the holiday hold across the Chile-midnight gap while New York is on the holiday session", () => {
    // Chile holiday Tue 2026-12-08 (NYSE trading; Chile UTC−3 vs New York EST UTC−5 = 2h gap):
    // the flat carry cuota settled that evening, but the held proxy must survive Wed 00:30 Chile
    // (= Tue 22:30 New York) until Wednesday's open.
    stubSettledForDay("2026-12-08"); // the holiday's flat carry settled; Wednesday's cuota cannot exist yet
    vi.spyOn(marketHolidays, "isChileBusinessDay").mockImplementation(
      (ymd: string) => ymd !== "2026-12-08"
    );
    const now = new Date("2026-12-09T03:30:00Z");
    expect(chileDate.chileWallClockAt(now).ymd).toBe("2026-12-09");
    expect(nyseSession.nyseWallClock(now).ymd).toBe("2026-12-08");
    expect(marketHolidays.isNyseTradingDay("2026-12-08")).toBe(true);
    expect(inChileHolidayProxyHold(now)).toBe(true);
    expect(shouldUseRiskyNorrisProxyMtm(now)).toBe(true);
  });

  it("holds Friday's close through the weekend after a Friday holiday until Monday's cuota lands", () => {
    // Fiestas Patrias 2026-09-18 (Fri, NYSE open; Chile UTC−3, New York EDT UTC−4). Fintual
    // forward-published flat carries for 09-18..20; only Monday's cuota can reflect Friday.
    // Until 2026-09-17 the hold ended at New York midnight and the weekend showed the carries.
    stubSettledForDay("2026-09-20"); // last (forward-published) cuota; Monday not polled yet
    expect(marketHolidays.isChileBusinessDay("2026-09-18")).toBe(false);
    expect(marketHolidays.isNyseTradingDay("2026-09-18")).toBe(true);
    const probes: [string, boolean][] = [
      ["2026-09-18T12:00:00Z", false], // Fri 09:00 Chile, pre-open: last official cuota
      ["2026-09-18T14:00:00Z", true], // Fri 11:00 Chile: live session
      ["2026-09-18T21:00:00Z", true], // Fri 18:00 Chile: held close
      ["2026-09-19T03:30:00Z", true], // Sat 00:30 Chile, New York still on Friday
      ["2026-09-19T18:00:00Z", true], // Sat 15:00 Chile
      ["2026-09-20T18:00:00Z", true], // Sun 15:00 Chile
      ["2026-09-21T05:00:00Z", true], // Mon 02:00 Chile, pre-open
      ["2026-09-21T14:00:00Z", true], // Mon 11:00 Chile: live session
    ];
    for (const [iso, expected] of probes) {
      expect(shouldUseRiskyNorrisProxyMtm(new Date(iso)), iso).toBe(expected);
    }
    // Monday's evening poll lands the first cuota that saw Friday's session.
    stubSettledForDay("2026-09-21");
    expect(inChileHolidayProxyHold(new Date("2026-09-21T05:00:00Z"))).toBe(false);
    expect(shouldUseRiskyNorrisProxyMtm(new Date("2026-09-21T23:00:00Z"))).toBe(false); // Mon 20:00 Chile
  });

  it("values every day of a held block through the proxy until the catch-up cuota is applied (historical marks)", () => {
    stubAppliedPublishYmd("2026-09-20"); // forward-published flat carries through Sunday; Monday not polled
    expect(riskyNorrisProxyAppliesOnYmd("2026-09-17")).toBe(false); // Thu: business day, official bar
    expect(riskyNorrisProxyAppliesOnYmd("2026-09-18")).toBe(true); // Fri holiday: flat carry ≠ session
    expect(riskyNorrisProxyAppliesOnYmd("2026-09-19")).toBe(true); // Sat: reflects Friday's session
    expect(riskyNorrisProxyAppliesOnYmd("2026-09-20")).toBe(true); // Sun
    expect(riskyNorrisProxyAppliesOnYmd("2026-09-21")).toBe(false); // Mon: its own bar reflects Friday+Monday
    // A normal weekend after a Chile business day reads the official bars.
    expect(riskyNorrisProxyAppliesOnYmd("2026-09-12")).toBe(false);
    // Monday's evening poll applies the catch-up cuota: the block reverts to the official bars.
    stubAppliedPublishYmd("2026-09-21");
    for (const ymd of ["2026-09-18", "2026-09-19", "2026-09-20"]) {
      expect(riskyNorrisProxyAppliesOnYmd(ymd), ymd).toBe(false);
    }
  });

  it("keeps historical held blocks on the official bars while today's positions do not reconcile", () => {
    // 2026-09-21 12:30: the Reserva retiro's «Pagamos» transfer sold cuotas before the evening
    // poll re-signed, so the live settled check (caught-up + reconcile) answered false for every
    // day it was asked about — and the per-date hold then re-valued 2025-05-01 (a Chile holiday
    // NYSE traded) through today's basket, whose SPYM had no 2025 bar: a 500 on every daily view.
    stubAppliedPublishYmd("2026-09-20");
    vi.spyOn(fintualPublishDate, "fintualPollDayCaughtUp").mockReturnValue(false);
    vi.spyOn(fintualCertV2Reconcile, "fintualCertV2PollReconciled").mockReturnValue(false);
    expect(fintualGlobalSyncSettledForChileDay("2025-05-02")).toBe(false); // the live check is unsettled…
    expect(riskyNorrisProxyAppliesOnYmd("2025-05-01")).toBe(false); // …but a 2025 block is long applied
    expect(riskyNorrisProxyAppliesOnYmd("2025-09-18")).toBe(false); // Thu holiday, NYSE open, catch-up Mon 09-22
    // The current block still holds: its catch-up cuota (Monday's) is not applied yet.
    expect(riskyNorrisProxyAppliesOnYmd("2026-09-18")).toBe(true);
    expect(riskyNorrisProxyAppliesOnYmd("2026-09-20")).toBe(true);
    // A state with no applied publish day at all holds every block (nothing is in hand).
    stubAppliedPublishYmd(null);
    expect(riskyNorrisProxyAppliesOnYmd("2026-09-18")).toBe(true);
  });

  it("does not hold on a normal weekend (Friday was a Chile business day)", () => {
    stubSettledForDay("2026-09-11");
    expect(shouldUseRiskyNorrisProxyMtm(new Date("2026-09-12T18:00:00Z"))).toBe(false); // Sat 15:00 Chile
    expect(shouldUseRiskyNorrisProxyMtm(new Date("2026-09-13T18:00:00Z"))).toBe(false); // Sun 15:00 Chile
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

    const now = new Date("2026-06-20T18:00:00Z"); // Saturday: held session = Friday 06-19
    const rnPx = riskyNorrisProxyCuotaForMtm("fintual_cert_risky_norris", now);
    const apvPx = riskyNorrisProxyCuotaForMtm("fintual_cert_apv_a", now);
    const proxyRnFull = proxyClpFromMeta(meta, holdings, "2026-06-19", { preferLive: false, now });
    expect(rnPx).toBeCloseTo(proxyRnFull, 4);
    expect(apvPx / rnPx).toBeCloseTo(4200 / 4000, 4);
    expect(Math.abs(4200 / 4000 - 1)).toBeGreaterThan(APV_PROXY_NEGLIGIBLE_REL_DIFF);
  });

  it("uses shared proxy for APV when anchor spread is negligible", () => {
    vi.spyOn(chileDate, "chileCalendarTodayYmd").mockReturnValue(COMPOSITION_DATE);
    if (!seedProxyMeta(4002)) return;
    const now = new Date("2026-06-20T18:00:00Z");
    const apvPx = riskyNorrisProxyCuotaForMtm("fintual_cert_apv_a", now);
    const rnPx = riskyNorrisProxyCuotaForMtm("fintual_cert_risky_norris", now);
    expect(apvPx).toBeCloseTo(rnPx, 6);
  });
});

describe("fintualGlobalSyncSettledForChileDay", () => {
  it("reads global sync state without throwing", () => {
    expect(typeof fintualGlobalSyncSettledForChileDay(chileDate.chileCalendarTodayYmd())).toBe(
      "boolean"
    );
  });

  it("asks the poll-day predicate about the day it was given, not the clock", () => {
    const caughtUp = vi
      .spyOn(fintualPublishDate, "fintualPollDayCaughtUp")
      .mockImplementation((pollYmd: string) => pollYmd === "2026-09-10");
    vi.spyOn(fintualCertV2Reconcile, "fintualCertV2PollReconciled").mockReturnValue(true);
    expect(fintualGlobalSyncSettledForChileDay("2026-09-10")).toBe(true);
    expect(fintualGlobalSyncSettledForChileDay("2026-09-11")).toBe(false);
    expect(caughtUp).toHaveBeenCalledWith("2026-09-10", expect.anything(), expect.anything(), expect.anything());
  });
});
