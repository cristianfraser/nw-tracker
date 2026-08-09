import { afterEach, describe, expect, it } from "vitest";
import { chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import {
  DAILY_RUN_FAILED_TITLE,
  DAILY_RUN_MESSAGE_TITLE,
  formatDailyRunBody,
  lastDailyRunAt,
  recordDailyRun,
  staleDailyRunDays,
} from "./dailyRunLog.js";

/**
 * The daily run is fail-soft by design, so its outcome has to be recorded somewhere a human
 * actually looks — otherwise a broken fetch is invisible.
 */
describe("dailyRunLog", () => {
  afterEach(() => {
    db.prepare(`DELETE FROM app_messages WHERE title IN (?, ?)`).run(
      DAILY_RUN_MESSAGE_TITLE,
      DAILY_RUN_FAILED_TITLE
    );
  });

  it("logs a clean run and notifies on a failed one", () => {
    const clean = recordDailyRun([
      { label: "fetch Santander", ok: true, seconds: 41 },
      { label: "inbox pipeline", ok: true, seconds: 12 },
    ]);
    expect(clean.ok).toBe(true);
    expect(
      (db.prepare(`SELECT kind FROM app_messages WHERE id = ?`).get(clean.message_id) as { kind: string }).kind
    ).toBe("log");

    const broken = recordDailyRun([
      { label: "fetch Santander", ok: false, seconds: 3 },
      { label: "inbox pipeline", ok: true, seconds: 12 },
    ]);
    expect(broken.ok).toBe(false);
    const row = db
      .prepare(`SELECT kind, title, read_at FROM app_messages WHERE id = ?`)
      .get(broken.message_id) as { kind: string; title: string; read_at: string | null };
    // `notification` + unread is what puts a badge in the app.
    expect(row.kind).toBe("notification");
    expect(row.title).toBe(DAILY_RUN_FAILED_TITLE);
    expect(row.read_at).toBeNull();
    expect(broken.body).toMatch(/1 of 2 step\(s\) FAILED: fetch Santander/);
  });

  it("names every step and its duration in the body", () => {
    const body = formatDailyRunBody([
      { label: "fetch Santander", ok: true, seconds: 41.4 },
      { label: "inbox pipeline", ok: false, seconds: 2 },
    ]);
    expect(body).toContain("ok    fetch Santander (41s)");
    expect(body).toContain("FAIL  inbox pipeline (2s)");
  });

  it("reports the gap when nightly runs were missed", () => {
    expect(staleDailyRunDays()).toBeNull();
    expect(formatDailyRunBody([{ label: "x", ok: true }])).toContain("First recorded run.");

    recordDailyRun([{ label: "fetch Santander", ok: true }]);
    const at = lastDailyRunAt({ successOnly: true });
    expect(at).not.toBeNull();
    // `created_at` is stored UTC; the implementation compares Chile days, so derive the same
    // Chile day here — slicing the raw timestamp reads the NEXT day once it is past UTC
    // midnight (21:00 Chile at -4), which made this assertion fail late in the evening.
    const ymd = chileWallClockAt(new Date(`${String(at).replace(" ", "T")}Z`)).ymd;

    // Same day → not stale; four days later → four missed nights, and the body says so.
    expect(staleDailyRunDays(ymd)).toBe(0);
    const plus4 = new Date(`${ymd}T00:00:00Z`);
    plus4.setUTCDate(plus4.getUTCDate() + 4);
    const laterYmd = plus4.toISOString().slice(0, 10);
    expect(staleDailyRunDays(laterYmd)).toBe(4);
    expect(formatDailyRunBody([{ label: "x", ok: true }], laterYmd)).toContain(
      "Last successful run was 4 day(s) ago"
    );
  });

  it("does not count a failed run as the last successful one", () => {
    recordDailyRun([{ label: "fetch Santander", ok: false }]);
    expect(lastDailyRunAt({ successOnly: true })).toBeNull();
    expect(lastDailyRunAt()).not.toBeNull();
  });
});
