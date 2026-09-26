import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { dailyRunFinishedWithin, staleDailyRunDays, DAILY_RUN_MESSAGE_TITLE } from "./dailyRunLog.js";

/**
 * The 22:00 scheduled run skips itself only right behind another run. `app_messages.created_at`
 * is UTC; the nightly job runs at 22:00 Chile = 01:00–02:00 UTC the NEXT day.
 */
describe("dailyRunFinishedWithin", () => {
  const cleanup = () =>
    db.prepare(`DELETE FROM app_messages WHERE body = 'vitest-daily-run-same-day'`).run();

  const insertRun = (createdAtUtc: string) => {
    cleanup();
    db.prepare(
      `INSERT INTO app_messages (kind, title, body, created_at) VALUES ('log', ?, 'vitest-daily-run-same-day', ?)`
    ).run(DAILY_RUN_MESSAGE_TITLE, createdAtUtc);
  };

  it("skips the 22:00 run right behind a manual run", () => {
    insertRun("2026-09-26 00:50:00"); // = 2026-09-25 21:50 Chile
    try {
      expect(dailyRunFinishedWithin(60, new Date("2026-09-26T01:00:04Z"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("still runs at 22:00 after a manual run that afternoon (2026-09-25)", () => {
    insertRun("2026-09-25 16:07:11"); // = 2026-09-25 13:07 Chile
    try {
      expect(dailyRunFinishedWithin(60, new Date("2026-09-26T01:00:04Z"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("still runs at 22:00 after the catch-up run launchd fired on waking at 04:21", () => {
    insertRun("2026-09-25 07:26:53"); // = 2026-09-25 04:26 Chile
    try {
      expect(dailyRunFinishedWithin(60, new Date("2026-09-26T01:00:04Z"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("counts last night's run as one day stale, not zero", () => {
    insertRun("2026-08-07 02:10:10"); // = 2026-08-06 22:10 Chile
    try {
      expect(staleDailyRunDays("2026-08-07")).toBe(1);
      expect(staleDailyRunDays("2026-08-06")).toBe(0);
    } finally {
      cleanup();
    }
  });
});
