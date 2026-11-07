import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChileWallClock } from "./chileDate.js";
import {
  PUBLISHER_LAG_MAX_POLL_AGE_MS,
  expectedPublishedDay,
  nextPublishDue,
  publisherLagFromPoll,
  type PublisherSchedule,
} from "./publisherSchedule.js";

type Cases = {
  schedules: Record<string, PublisherSchedule>;
  expected: { schedule: string; at: [string, number]; day: string; why: string }[];
  next_due: { schedule: string; at: [string, number]; latest: string | null; due: [string, number] | null; why: string }[];
};

const cases = JSON.parse(readFileSync(new URL("./test/publisherScheduleCases.json", import.meta.url), "utf8")) as Cases;

function at([ymd, hour]: [string, number]): ChileWallClock {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return { ymd, year: y, month: m, day: d, hour, minute: 0, monthKey: ymd.slice(0, 7) };
}

describe("expectedPublishedDay", () => {
  for (const c of cases.expected) {
    it(`${c.schedule} at ${c.at.join(" ")}h: ${c.why}`, () => {
      expect(expectedPublishedDay(at(c.at), cases.schedules[c.schedule]!)).toBe(c.day);
    });
  }
});

describe("nextPublishDue", () => {
  for (const c of cases.next_due) {
    it(`${c.schedule} at ${c.at.join(" ")}h: ${c.why}`, () => {
      const due = nextPublishDue(at(c.at), c.latest, cases.schedules[c.schedule]!);
      expect(due).toEqual(c.due ? { ymd: c.due[0], hour: c.due[1] } : null);
    });
  }
});

describe("publisherLagFromPoll", () => {
  const nowMs = Date.parse("2026-10-05T15:00:00.000Z");
  const recent = new Date(nowMs - 60_000).toISOString();
  const base = { forced: false, publishedYmd: "2026-10-01", latestDbDay: "2026-10-01", expectedYmd: "2026-10-02", lastCheckedAt: recent, nowMs };

  it("is the publisher's lag when a recent poll holds every printed day and the expected one is not printed", () => {
    expect(publisherLagFromPoll(base)).toEqual({ expected_ymd: "2026-10-02", published_ymd: "2026-10-01", last_checked_at: recent });
  });

  it("is ours when forced, the poll is old or missing, the DB lacks the printed day, or the expected day is printed", () => {
    expect(publisherLagFromPoll({ ...base, forced: true })).toBeNull();
    expect(publisherLagFromPoll({ ...base, lastCheckedAt: null })).toBeNull();
    expect(publisherLagFromPoll({ ...base, lastCheckedAt: new Date(nowMs - PUBLISHER_LAG_MAX_POLL_AGE_MS - 1).toISOString() })).toBeNull();
    expect(publisherLagFromPoll({ ...base, latestDbDay: "2026-09-30" })).toBeNull();
    expect(publisherLagFromPoll({ ...base, publishedYmd: "2026-10-02" })).toBeNull();
    expect(publisherLagFromPoll({ ...base, publishedYmd: "garbage" })).toBeNull();
  });
});
