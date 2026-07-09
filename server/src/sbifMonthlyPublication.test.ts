import { describe, expect, it } from "vitest";
import type { ChileWallClock } from "./chileDate.js";
import {
  isSbifUfCoverageComplete,
  isSbifUfStale,
  isSbifUtmCoverageComplete,
  isSbifUtmStale,
  sbifMonthlyPublicationEndYmd,
  sbifMonthlyPublicationTargetMonth,
} from "./sbifMonthlyPublication.js";

function cl(ymd: string): ChileWallClock {
  const [ys, ms, ds] = ymd.split("-");
  return {
    ymd,
    year: Number(ys),
    month: Number(ms),
    day: Number(ds),
    hour: 12,
    minute: 0,
    monthKey: ymd.slice(0, 7),
  };
}

describe("sbifMonthlyPublicationEndYmd", () => {
  it("targets end of next calendar month after day 9", () => {
    expect(sbifMonthlyPublicationEndYmd(cl("2026-06-09"))).toBe("2026-07-31");
    expect(sbifMonthlyPublicationEndYmd(cl("2026-06-11"))).toBe("2026-07-31");
    expect(sbifMonthlyPublicationEndYmd(cl("2026-12-15"))).toBe("2027-01-31");
  });
});

describe("isSbifUfCoverageComplete", () => {
  it("requires max uf_daily through publication horizon", () => {
    const june11 = cl("2026-06-11");
    expect(isSbifUfCoverageComplete("2026-06-09", june11)).toBe(false);
    expect(isSbifUfCoverageComplete("2026-07-31", june11)).toBe(true);
  });
});

describe("isSbifUtmCoverageComplete", () => {
  it("requires UTM for next calendar month", () => {
    const june11 = cl("2026-06-11");
    expect(sbifMonthlyPublicationTargetMonth(june11)).toEqual({ y: 2026, m: 7 });
    expect(isSbifUtmCoverageComplete({ y: 2026, m: 6 }, june11)).toBe(false);
    expect(isSbifUtmCoverageComplete({ y: 2026, m: 7 }, june11)).toBe(true);
  });
});

describe("isSbifUfStale / isSbifUtmStale", () => {
  it("is not stale before the 9th", () => {
    const june8 = cl("2026-06-08");
    expect(isSbifUfStale(june8, { maxUfDate: "2026-06-01" })).toBe(false);
    expect(isSbifUtmStale(june8, { maxUtm: { y: 2026, m: 5 } })).toBe(false);
  });

  it("is stale on/after the 9th when DB lacks current month UF", () => {
    const june9 = cl("2026-06-09");
    const june11 = cl("2026-06-11");
    const june22 = cl("2026-06-22");
    expect(isSbifUfStale(june9, { maxUfDate: "2026-06-08" })).toBe(true);
    expect(isSbifUfStale(june9, { maxUfDate: "2026-07-31" })).toBe(false);
    expect(isSbifUfStale(june9, { maxUfDate: "2026-06-30" })).toBe(true);
    expect(isSbifUfStale(cl("2026-06-10"), { maxUfDate: "2026-06-30" })).toBe(false);
    expect(isSbifUfStale(june11, { maxUfDate: "2026-06-09" })).toBe(true);
    expect(isSbifUfStale(june11, { maxUfDate: "2026-06-30", lastSyncYmd: "2026-06-10" })).toBe(false);
    expect(isSbifUfStale(june11, { maxUfDate: "2026-06-30", lastSyncYmd: "2026-06-11" })).toBe(false);
    expect(isSbifUfStale(june22, { maxUfDate: "2026-07-09", lastSyncYmd: "2026-06-21" })).toBe(false);
    expect(isSbifUfStale(june11, { maxUfDate: "2026-07-31" })).toBe(false);
    // UTM: stale only while the current month's value is missing — next-month UTM
    // is not queryable on day 9, and a completed grab goes fresh immediately.
    expect(isSbifUtmStale(june9, { maxUtm: { y: 2026, m: 5 } })).toBe(true); // missing current month
    expect(isSbifUtmStale(june9, { maxUtm: { y: 2026, m: 6 } })).toBe(false); // grab done → fresh even on day 9
    expect(isSbifUtmStale(june11, { maxUtm: { y: 2026, m: 5 } })).toBe(true); // still missing current month
    expect(isSbifUtmStale(june11, { maxUtm: { y: 2026, m: 6 } })).toBe(false); // current month present → fresh
    expect(isSbifUtmStale(june11, { maxUtm: { y: 2026, m: 7 } })).toBe(false); // next month present → fresh
  });

  it("UF goes fresh on day 9 once the published horizon (9th of next month) is ingested", () => {
    // Regression: the July 9 08:45 grab reached 2026-08-09 but the source kept
    // polling stale all day because day 9 was unconditionally stale.
    const july9 = cl("2026-07-09");
    expect(isSbifUfStale(july9, { maxUfDate: "2026-07-09" })).toBe(true); // pre-grab
    expect(isSbifUfStale(july9, { maxUfDate: "2026-07-31" })).toBe(true); // partial — horizon not ingested
    expect(isSbifUfStale(july9, { maxUfDate: "2026-08-09" })).toBe(false); // grab done → fresh same day
  });

  it("UTM goes fresh once the current-month value is in the DB (next month unpublished)", () => {
    // Regression: July 9 with July UTM present must not loop stale — neither all
    // of day 9 nor the weeks until BCentral publishes the August value.
    expect(isSbifUtmStale(cl("2026-07-09"), { maxUtm: { y: 2026, m: 6 } })).toBe(true); // pre-grab
    expect(isSbifUtmStale(cl("2026-07-09"), { maxUtm: { y: 2026, m: 7 } })).toBe(false); // grab done → fresh
    expect(isSbifUtmStale(cl("2026-07-10"), { maxUtm: { y: 2026, m: 7 } })).toBe(false);
    expect(isSbifUtmStale(cl("2026-07-25"), { maxUtm: { y: 2026, m: 7 } })).toBe(false);
  });

  it("honours forceSbif", () => {
    expect(isSbifUfStale(cl("2026-06-01"), { forceSbif: true, maxUfDate: "2026-07-31" })).toBe(true);
  });
});
