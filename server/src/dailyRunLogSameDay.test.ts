import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { staleDailyRunDays, DAILY_RUN_MESSAGE_TITLE } from "./dailyRunLog.js";

/**
 * `app_messages.created_at` is UTC; the nightly job runs at 22:00 Chile = 01:00–02:00 UTC the
 * NEXT day.
 */
describe("staleDailyRunDays", () => {
  const cleanup = () =>
    db.prepare(`DELETE FROM app_messages WHERE body = 'vitest-daily-run-same-day'`).run();

  const insertRun = (createdAtUtc: string) => {
    cleanup();
    db.prepare(
      `INSERT INTO app_messages (kind, title, body, created_at) VALUES ('log', ?, 'vitest-daily-run-same-day', ?)`
    ).run(DAILY_RUN_MESSAGE_TITLE, createdAtUtc);
  };

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
