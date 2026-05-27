import { describe, expect, it } from "vitest";
import { priorNyseSessionYmd } from "./marketHolidays.js";
import {
  isBeforeNyseRegularOpen,
  isNyseRegularSessionOpen,
  nyseDisplaySessionYmd,
} from "./nyseSession.js";

describe("isBeforeNyseRegularOpen", () => {
  it("is true before 9:30 ET on a trading day", () => {
    const tuePreOpen = new Date("2026-05-19T08:00:00-04:00");
    expect(isBeforeNyseRegularOpen(tuePreOpen)).toBe(true);
  });

  it("is false after 9:30 ET on a trading day", () => {
    const tueMid = new Date("2026-05-19T11:00:00-04:00");
    expect(isBeforeNyseRegularOpen(tueMid)).toBe(false);
  });

  it("is false on NYSE holidays", () => {
    const memorial = new Date("2026-05-25T08:00:00-04:00");
    expect(isBeforeNyseRegularOpen(memorial)).toBe(false);
  });
});

describe("isNyseRegularSessionOpen", () => {
  it("is true during regular hours", () => {
    const tueMid = new Date("2026-05-19T11:00:00-04:00");
    expect(isNyseRegularSessionOpen(tueMid)).toBe(true);
  });

  it("is false pre-open and after close", () => {
    expect(isNyseRegularSessionOpen(new Date("2026-05-19T08:00:00-04:00"))).toBe(false);
    expect(isNyseRegularSessionOpen(new Date("2026-05-19T17:00:00-04:00"))).toBe(false);
  });

  it("is false on Memorial Day", () => {
    expect(isNyseRegularSessionOpen(new Date("2026-05-25T12:00:00-04:00"))).toBe(false);
  });
});

describe("nyseDisplaySessionYmd", () => {
  it("uses last trading day on Memorial Day", () => {
    const memorial = new Date("2026-05-25T18:00:00-04:00");
    expect(nyseDisplaySessionYmd(memorial)).toBe("2026-05-22");
    expect(priorNyseSessionYmd(nyseDisplaySessionYmd(memorial))).toBe("2026-05-21");
  });

  it("uses same day after regular close on Monday", () => {
    const monAfterClose = new Date("2026-05-18T17:00:00-04:00");
    expect(nyseDisplaySessionYmd(monAfterClose)).toBe("2026-05-18");
    expect(priorNyseSessionYmd(nyseDisplaySessionYmd(monAfterClose))).toBe("2026-05-15");
  });

  it("uses prior session before open on Tuesday", () => {
    const tuePreOpen = new Date("2026-05-19T08:00:00-04:00");
    expect(nyseDisplaySessionYmd(tuePreOpen)).toBe("2026-05-18");
    expect(priorNyseSessionYmd(nyseDisplaySessionYmd(tuePreOpen))).toBe("2026-05-15");
  });

  it("skips Thanksgiving when Friday opens pre-market", () => {
    const friPreOpen = new Date("2026-11-27T08:00:00-05:00");
    expect(nyseDisplaySessionYmd(friPreOpen)).toBe("2026-11-25");
    expect(priorNyseSessionYmd(nyseDisplaySessionYmd(friPreOpen))).toBe("2026-11-24");
  });
});
