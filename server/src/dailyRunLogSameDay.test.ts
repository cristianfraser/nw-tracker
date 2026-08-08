import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { dailyRunAlreadyRanToday, staleDailyRunDays, DAILY_RUN_MESSAGE_TITLE } from "./dailyRunLog.js";

/**
 * `app_messages.created_at` is UTC. The nightly job runs at 22:00 Chile, which is 02:00 the NEXT
 * day in UTC — so a naive `slice(0, 10)` makes last night's run look like today's and the
 * scheduled run skips itself forever.
 */
describe("dailyRunAlreadyRanToday", () => {
  const cleanup = () =>
    db.prepare(`DELETE FROM app_messages WHERE body = 'vitest-daily-run-same-day'`).run();

  const insertRun = (createdAtUtc: string) => {
    cleanup();
    db.prepare(
      `INSERT INTO app_messages (kind, title, body, created_at) VALUES ('log', ?, 'vitest-daily-run-same-day', ?)`
    ).run(DAILY_RUN_MESSAGE_TITLE, createdAtUtc);
  };

  it("treats last night's 22:00 Chile run as yesterday, not today", () => {
    insertRun("2026-08-07 02:10:10"); // = 2026-08-06 22:10 Chile
    try {
      expect(dailyRunAlreadyRanToday("2026-08-07")).toBe(false);
      expect(dailyRunAlreadyRanToday("2026-08-06")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("recognises a manual run made earlier the same Chile day", () => {
    insertRun("2026-08-07 17:00:00"); // = 2026-08-07 13:00 Chile
    try {
      expect(dailyRunAlreadyRanToday("2026-08-07")).toBe(true);
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
