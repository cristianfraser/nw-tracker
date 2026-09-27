import { afterEach, describe, expect, it } from "vitest";
import { dateAtTimeZoneWallClock } from "./chileDate.js";
import { db } from "./db.js";
import { LIVE_FX_SYMBOL } from "./liveMarketQuotesConfig.js";
import {
  INTERBANK_WINDOW_MIN_PRINTS,
  interbankWindowAverageClpPerUsd,
  observadoFrameFxForDay,
} from "./fxObservadoFrame.js";

// Far-future synthetic dates: nothing real is published there, so the series head and the
// "first row after" lookups are exactly the rows this file seeds. Every row is removed in
// afterEach, including the live prints (a 2091 fetched_at would otherwise be "the latest print").
const D_PUB_A = "2091-03-05"; // publication of 03-04's trades
const D_PUB_B = "2091-03-06"; // publication of 03-05's trades
const D_PUB_C = "2091-03-14"; // publication after an 8-day hole
const CHILE_TZ = "America/Santiago";

function seedObservado(rows: Record<string, number>): void {
  for (const [date, value] of Object.entries(rows)) {
    db.prepare(`INSERT INTO fx_daily_bcentral (date, clp_per_usd) VALUES (?, ?)`).run(date, value);
  }
}

function seedPrint(ymd: string, hour: number, minute: number, value: number): void {
  const fetchedAt = dateAtTimeZoneWallClock(ymd, hour, minute, CHILE_TZ).toISOString();
  db.prepare(
    `INSERT INTO live_market_quotes (symbol, kind, value, currency, session_ymd, previous_value, fetched_at)
     VALUES (?, 'fx_clp_per_usd', ?, NULL, ?, NULL, ?)`
  ).run(LIVE_FX_SYMBOL, value, ymd, fetchedAt);
}

function chileInstant(ymd: string, hour: number, minute: number): Date {
  return dateAtTimeZoneWallClock(ymd, hour, minute, CHILE_TZ);
}

afterEach(() => {
  db.prepare(`DELETE FROM fx_daily_bcentral WHERE date >= '2091-01-01' AND date < '2092-01-01'`).run();
  db.prepare(
    `DELETE FROM live_market_quotes WHERE kind = 'fx_clp_per_usd' AND session_ymd >= '2091-01-01' AND session_ymd < '2092-01-01'`
  ).run();
});

describe("observadoFrameFxForDay — published", () => {
  it("day D reads the first observado published after D (day D's interbank average)", () => {
    seedObservado({ [D_PUB_A]: 900, [D_PUB_B]: 910, [D_PUB_C]: 920 });
    expect(observadoFrameFxForDay("2091-03-04")).toEqual({ clp_per_usd: 900, source: "published", as_of: D_PUB_A });
    expect(observadoFrameFxForDay("2091-03-05")).toEqual({ clp_per_usd: 910, source: "published", as_of: D_PUB_B });
    // A weekend/holiday day reads the next publication too (the last business day's trades).
    expect(observadoFrameFxForDay("2091-03-13")).toEqual({ clp_per_usd: 920, source: "published", as_of: D_PUB_C });
  });

  it("a publication more than 7 days after D is a series gap, never the frame", () => {
    seedObservado({ [D_PUB_A]: 900, [D_PUB_B]: 910, [D_PUB_C]: 920 });
    // 03-06 → next row 03-14 is 8 days later.
    expect(() => observadoFrameFxForDay("2091-03-06")).toThrow(/fx_daily_bcentral gap/);
    // 03-07 → 03-14 is exactly 7 days: allowed (a long weekend plus holidays).
    expect(observadoFrameFxForDay("2091-03-07").as_of).toBe(D_PUB_C);
  });
});

describe("observadoFrameFxForDay — pending publication", () => {
  it("carries the last published observado when no prints exist", () => {
    seedObservado({ [D_PUB_A]: 900, [D_PUB_B]: 910, [D_PUB_C]: 920 });
    expect(observadoFrameFxForDay(D_PUB_C, chileInstant(D_PUB_C, 16, 0))).toEqual({
      clp_per_usd: 920,
      source: "carry",
      as_of: D_PUB_C,
    });
    expect(observadoFrameFxForDay("2091-03-20", chileInstant("2091-03-20", 16, 0)).source).toBe("carry");
  });

  it("refuses to carry a series whose head is more than 7 days old", () => {
    seedObservado({ [D_PUB_A]: 900, [D_PUB_B]: 910, [D_PUB_C]: 920 });
    expect(() => observadoFrameFxForDay("2091-03-22", chileInstant("2091-03-22", 16, 0))).toThrow(
      /sbif_usd sync stale/
    );
  });

  it("averages the live CLP=X prints inside the 09:00–14:00 Chile interbank window", () => {
    seedObservado({ [D_PUB_A]: 900, [D_PUB_B]: 910, [D_PUB_C]: 920 });
    seedPrint(D_PUB_C, 8, 30, 800); // before the window — ignored
    seedPrint(D_PUB_C, 9, 30, 950);
    seedPrint(D_PUB_C, 10, 0, 960);
    seedPrint(D_PUB_C, 10, 30, 970);
    seedPrint(D_PUB_C, 13, 30, 980);
    seedPrint(D_PUB_C, 14, 30, 1000); // after the market closed — ignored

    const afterClose = observadoFrameFxForDay(D_PUB_C, chileInstant(D_PUB_C, 16, 0));
    expect(afterClose).toEqual({ clp_per_usd: 965, source: "interbank_window", as_of: D_PUB_C });

    // Running average while the window is open: only prints up to `now` count.
    expect(interbankWindowAverageClpPerUsd(D_PUB_C, chileInstant(D_PUB_C, 10, 45))).toEqual({
      clp_per_usd: 960,
      prints: 3,
    });
    expect(observadoFrameFxForDay(D_PUB_C, chileInstant(D_PUB_C, 10, 45)).clp_per_usd).toBe(960);
  });

  it("needs at least three prints before a window average counts, else carries", () => {
    seedObservado({ [D_PUB_A]: 900, [D_PUB_B]: 910, [D_PUB_C]: 920 });
    seedPrint(D_PUB_C, 9, 30, 950);
    seedPrint(D_PUB_C, 10, 0, 960);
    expect(INTERBANK_WINDOW_MIN_PRINTS).toBe(3);
    expect(interbankWindowAverageClpPerUsd(D_PUB_C, chileInstant(D_PUB_C, 10, 15))).toBeNull();
    expect(observadoFrameFxForDay(D_PUB_C, chileInstant(D_PUB_C, 10, 15))).toEqual({
      clp_per_usd: 920,
      source: "carry",
      as_of: D_PUB_C,
    });
  });

  it("before today's window opens, carries yesterday's window estimate while yesterday's publication is pending", () => {
    seedObservado({ [D_PUB_A]: 900, [D_PUB_B]: 910, [D_PUB_C]: 920 });
    seedPrint(D_PUB_C, 9, 30, 950);
    seedPrint(D_PUB_C, 10, 0, 960);
    seedPrint(D_PUB_C, 10, 30, 970);
    seedPrint(D_PUB_C, 13, 30, 980);
    // 03-15 08:00 Chile: no prints yet today, 03-14's observado (published 03-15) not synced —
    // the frame's last observation is 03-14's window average, not the row published on 03-14
    // (03-13's trades), which would pair today's basket with an interbank fx two days old.
    expect(observadoFrameFxForDay("2091-03-15", chileInstant("2091-03-15", 8, 0))).toEqual({
      clp_per_usd: 965,
      source: "carry",
      as_of: D_PUB_C,
    });
    // Once 03-15's own window has prints, they win.
    seedPrint("2091-03-15", 9, 10, 990);
    seedPrint("2091-03-15", 9, 20, 992);
    seedPrint("2091-03-15", 9, 30, 994);
    expect(observadoFrameFxForDay("2091-03-15", chileInstant("2091-03-15", 9, 35))).toEqual({
      clp_per_usd: 992,
      source: "interbank_window",
      as_of: "2091-03-15",
    });
  });

  it("a published row always outranks prints for the same day", () => {
    seedObservado({ [D_PUB_A]: 900, [D_PUB_B]: 910, [D_PUB_C]: 920 });
    seedPrint("2091-03-05", 10, 0, 1);
    seedPrint("2091-03-05", 10, 30, 1);
    seedPrint("2091-03-05", 11, 0, 1);
    expect(observadoFrameFxForDay("2091-03-05", chileInstant("2091-03-05", 16, 0)).clp_per_usd).toBe(910);
  });
});
