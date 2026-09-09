import { afterEach, describe, expect, it } from "vitest";
import { chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import {
  DAILY_RUN_FAILED_TITLE,
  DAILY_RUN_MESSAGE_TITLE,
  HOURLY_EMAIL_RUN_FAILED_TITLE,
  HOURLY_EMAIL_RUN_MESSAGE_TITLE,
  dailyRunAlreadyRanToday,
  formatDailyRunBody,
  lastDailyRunAt,
  recordDailyRun,
  recordHourlyEmailRun,
  staleDailyRunDays,
} from "./dailyRunLog.js";

/**
 * The daily run is fail-soft by design, so its outcome has to be recorded somewhere a human
 * actually looks — otherwise a broken fetch is invisible.
 */
describe("dailyRunLog", () => {
  afterEach(() => {
    db.prepare(`DELETE FROM app_messages WHERE title IN (?, ?, ?, ?)`).run(
      DAILY_RUN_MESSAGE_TITLE,
      DAILY_RUN_FAILED_TITLE,
      HOURLY_EMAIL_RUN_MESSAGE_TITLE,
      HOURLY_EMAIL_RUN_FAILED_TITLE
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

  it("records an empty step list as a failed run, never as «all ok»", () => {
    // A runner killed during its first step reaches its EXIT trap with nothing recorded.
    const killed = recordDailyRun([]);
    expect(killed.ok).toBe(false);
    const row = db
      .prepare(`SELECT kind, title FROM app_messages WHERE id = ?`)
      .get(killed.message_id) as { kind: string; title: string };
    expect(row.kind).toBe("notification");
    expect(row.title).toBe(DAILY_RUN_FAILED_TITLE);
    expect(killed.body).toMatch(/No step completed/);
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

/**
 * The hourly e-mail poll records under its own titles. The one property that must never
 * break: hourly rows are invisible to the daily run's same-day skip and staleness reads —
 * an hourly row matching the daily titles would make the 22:00 scheduled bank run skip
 * itself every day.
 */
describe("recordHourlyEmailRun", () => {
  afterEach(() => {
    db.prepare(`DELETE FROM app_messages WHERE title IN (?, ?)`).run(
      HOURLY_EMAIL_RUN_MESSAGE_TITLE,
      HOURLY_EMAIL_RUN_FAILED_TITLE
    );
  });

  it("records nothing for a quiet success", () => {
    const r = recordHourlyEmailRun([{ label: "fetch broker e-mail", ok: true, seconds: 5 }], {
      activity: false,
    });
    expect(r.ok).toBe(true);
    expect(r.recorded).toBe(false);
    expect(r.message_id).toBeNull();
    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM app_messages WHERE title IN (?, ?)`)
      .get(HOURLY_EMAIL_RUN_MESSAGE_TITLE, HOURLY_EMAIL_RUN_FAILED_TITLE) as { c: number };
    expect(count.c).toBe(0);
  });

  it("records a log row when the run had activity", () => {
    const r = recordHourlyEmailRun([{ label: "Lider boletas import", ok: true, seconds: 2 }], {
      activity: true,
    });
    expect(r.recorded).toBe(true);
    const row = db
      .prepare(`SELECT kind, title FROM app_messages WHERE id = ?`)
      .get(r.message_id) as { kind: string; title: string };
    expect(row.kind).toBe("log");
    expect(row.title).toBe(HOURLY_EMAIL_RUN_MESSAGE_TITLE);
  });

  it("badges only the first failure of the Chile day", () => {
    const first = recordHourlyEmailRun([{ label: "fetch broker e-mail", ok: false }], {
      activity: false,
    });
    expect(first.recorded).toBe(true);
    expect(first.kind).toBe("notification");

    const repeat = recordHourlyEmailRun([{ label: "fetch broker e-mail", ok: false }], {
      activity: false,
    });
    expect(repeat.recorded).toBe(true);
    expect(repeat.kind).toBe("log");

    // A new Chile day badges again.
    const nextDay = recordHourlyEmailRun([{ label: "fetch broker e-mail", ok: false }], {
      activity: false,
      nowYmd: "2099-01-01",
    });
    expect(nextDay.kind).toBe("notification");
  });

  it("stays invisible to the daily run's same-day skip and staleness reads", () => {
    recordHourlyEmailRun([{ label: "Lider boletas import", ok: true }], { activity: true });
    recordHourlyEmailRun([{ label: "fetch broker e-mail", ok: false }], { activity: false });
    expect(lastDailyRunAt()).toBeNull();
    expect(dailyRunAlreadyRanToday()).toBe(false);
    expect(staleDailyRunDays()).toBeNull();
  });
});
