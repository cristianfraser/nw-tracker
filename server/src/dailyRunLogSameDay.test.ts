import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { staleDailyRunDays, DAILY_RUN_MESSAGE_TITLE } from "./dailyRunLog.js";

/**
 * `app_messages.created_at` is UTC; the nightly job runs at 22:00 Chile = 01:00–02:00 UTC the
 * NEXT day.
 */
describe("staleDailyRunDays", () => {
  // The generated test person carries its own daily-run rows (demoData/ingestHistory.ts), newer
  // than the one this test inserts; `staleDailyRunDays` reads the newest, so those rows are set
  // aside under another title while the test runs and restored after it.
  const STASHED_TITLE = `vitest-stash:${DAILY_RUN_MESSAGE_TITLE}`;
  const cleanup = () => {
    db.prepare(`DELETE FROM app_messages WHERE body = 'vitest-daily-run-same-day'`).run();
    db.prepare(`UPDATE app_messages SET title = ? WHERE title = ?`).run(DAILY_RUN_MESSAGE_TITLE, STASHED_TITLE);
  };

  const insertRun = (createdAtUtc: string) => {
    cleanup();
    db.prepare(`UPDATE app_messages SET title = ? WHERE title = ?`).run(STASHED_TITLE, DAILY_RUN_MESSAGE_TITLE);
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
