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
    expect(isSbifUtmStale(june11, { maxUtm: { y: 2026, m: 6 } })).toBe(true);
    expect(isSbifUtmStale(june11, { maxUtm: { y: 2026, m: 7 } })).toBe(false);
  });

  it("honours forceSbif", () => {
    expect(isSbifUfStale(cl("2026-06-01"), { forceSbif: true, maxUfDate: "2026-07-31" })).toBe(true);
  });
});
