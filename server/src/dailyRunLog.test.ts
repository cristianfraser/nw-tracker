import { afterEach, describe, expect, it } from "vitest";
import { chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import {
  DAILY_RUN_FAILED_TITLE,
  DAILY_RUN_MESSAGE_TITLE,
  HOURLY_EMAIL_RUN_FAILED_TITLE,
  HOURLY_EMAIL_RUN_MESSAGE_TITLE,
  HOURLY_EMAIL_RUN_NOTICES_TITLE,
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

  it("lists a failed step's problems under it", () => {
    const body = formatDailyRunBody([
      { label: "Fintual e-mail movements (apply)", ok: false, seconds: 3, problems: ["2026-11-19 buy 50 USD: cannot tell which holding"] },
    ]);
    expect(body).toContain("FAIL  Fintual e-mail movements (apply) (3s)\n        2026-11-19 buy 50 USD: cannot tell which holding");
  });

  it("records a clean run with a notice as a notification under the clean title, the notices under their step", () => {
    const held = "Held, not imported: DOC-1_2.pdf — readable, but neither a card statement nor a cartola; kept in cfraser/inbox/held/";
    const r = recordDailyRun([
      { label: "fetch Santander", ok: true, seconds: 41 },
      { label: "inbox pipeline", ok: true, seconds: 12, notices: [held] },
    ]);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("notification");
    const row = db.prepare(`SELECT kind, title FROM app_messages WHERE id = ?`).get(r.message_id) as { kind: string; title: string };
    expect(row).toEqual({ kind: "notification", title: DAILY_RUN_MESSAGE_TITLE });
    expect(r.body).toContain("2 step(s), all ok. 1 notice(s).");
    expect(r.body).toContain(`ok    inbox pipeline (12s)\n        notice: ${held}`);
    // A notice is no failure: the next clean run is a plain log, not a recovery.
    const next = recordDailyRun([{ label: "inbox pipeline", ok: true, seconds: 3 }]);
    expect(next.kind).toBe("log");
    expect(next.recovered_from).toBeNull();
  });

  it("lists a failed run's notices beside its problems", () => {
    const r = recordDailyRun([
      { label: "fetch Santander", ok: false, seconds: 3, problems: ["login rejected"] },
      { label: "inbox pipeline", ok: true, seconds: 12, notices: ["Held, not imported: A.pdf", "Held, not imported: B.pdf"] },
    ]);
    expect(r.kind).toBe("notification");
    expect(r.body).toMatch(/^1 of 2 step\(s\) FAILED: fetch Santander\. 2 notice\(s\)\./);
    expect(r.body).toContain("FAIL  fetch Santander (3s)\n        login rejected");
    expect(r.body).toContain("        notice: Held, not imported: A.pdf\n        notice: Held, not imported: B.pdf");
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

  it("records the first clean run after a failure as a notification, so the tab shows the recovery", () => {
    recordDailyRun([{ label: "fetch Santander", ok: false, seconds: 2222 }]);
    const recovered = recordDailyRun([{ label: "fetch Santander", ok: true, seconds: 450 }]);
    expect(recovered.ok).toBe(true);
    expect(recovered.kind).toBe("notification");
    expect(recovered.recovered_from).not.toBeNull();
    const row = db
      .prepare(`SELECT kind, title, read_at FROM app_messages WHERE id = ?`)
      .get(recovered.message_id) as { kind: string; title: string; read_at: string | null };
    expect(row.kind).toBe("notification");
    expect(row.read_at).toBeNull();
    // Same title as every clean run: the staleness and same-day-skip reads key on it.
    expect(row.title).toBe(DAILY_RUN_MESSAGE_TITLE);
    expect(lastDailyRunAt({ successOnly: true })).not.toBeNull();
    expect(recovered.body).toMatch(/Recovered: the previous run \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\) had failed\./);

    // The next clean run finds a success on top and is an ordinary log again.
    const routine = recordDailyRun([{ label: "fetch Santander", ok: true, seconds: 400 }]);
    expect(routine.kind).toBe("log");
    expect(routine.recovered_from).toBeNull();
    expect(routine.body).not.toContain("Recovered");
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
    db.prepare(`DELETE FROM app_messages WHERE title IN (?, ?, ?)`).run(
      HOURLY_EMAIL_RUN_MESSAGE_TITLE,
      HOURLY_EMAIL_RUN_FAILED_TITLE,
      HOURLY_EMAIL_RUN_NOTICES_TITLE
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

  const kindAndTitle = (id: number | null) =>
    db.prepare(`SELECT kind, title FROM app_messages WHERE id = ?`).get(id) as { kind: string; title: string };

  it("records a quiet poll with a notice as a log, and notifies the notice on its own", () => {
    const r = recordHourlyEmailRun([{ label: "inbox pipeline", ok: true, seconds: 4, notices: ["Held, not imported: A.pdf"] }], {
      activity: false,
    });
    expect(r.recorded).toBe(true);
    expect(r.kind).toBe("log");
    expect(kindAndTitle(r.message_id)).toEqual({ kind: "log", title: HOURLY_EMAIL_RUN_MESSAGE_TITLE });
    expect(r.body).toContain("        notice: Held, not imported: A.pdf");
    expect(kindAndTitle(r.notice_message_id)).toEqual({ kind: "notification", title: HOURLY_EMAIL_RUN_NOTICES_TITLE });
  });

  it("a notice on a failed poll the rule only logs reaches the user and changes nothing after it", () => {
    recordHourlyEmailRun([{ label: "fetch broker e-mail", ok: false }], { activity: false });
    const withNotice = recordHourlyEmailRun(
      [
        { label: "fetch broker e-mail", ok: false },
        { label: "inbox pipeline", ok: true, notices: ["Held, not imported: A.pdf"] },
      ],
      { activity: true }
    );
    // The failure keeps the rule's decision: a continuing outage logs…
    expect(withNotice.kind).toBe("log");
    expect(kindAndTitle(withNotice.message_id)).toEqual({ kind: "log", title: HOURLY_EMAIL_RUN_FAILED_TITLE });
    const labels = db.prepare(`SELECT label FROM app_message_failed_steps WHERE message_id = ?`).all(withNotice.message_id);
    expect(labels).toEqual([{ label: "fetch broker e-mail" }]);
    // …and the notice is its own notification.
    const notice = db.prepare(`SELECT kind, body FROM app_messages WHERE id = ?`).get(withNotice.notice_message_id) as {
      kind: string;
      body: string;
    };
    expect(notice.kind).toBe("notification");
    expect(notice.body).toContain("inbox pipeline\n        Held, not imported: A.pdf");
    // The next failure of the same step still only logs, and the recovery is badged (the outage was).
    expect(recordHourlyEmailRun([{ label: "fetch broker e-mail", ok: false }], { activity: false }).kind).toBe("log");
    const recovered = recordHourlyEmailRun([{ label: "fetch broker e-mail", ok: true }], { activity: false });
    expect(recovered.kind).toBe("notification");
    expect(recovered.notice_message_id).toBeNull();
  });

  it("a notice on an unbadged outage leaves its recovery a log, as without the notice", () => {
    // An outage whose failures were all logs (recorded before the badge rule): its recovery is a log.
    const failed = recordHourlyEmailRun([{ label: "fetch broker e-mail", ok: false }], { activity: false });
    db.prepare(`UPDATE app_messages SET kind = 'log' WHERE id = ?`).run(failed.message_id);
    const withNotice = recordHourlyEmailRun(
      [
        { label: "fetch broker e-mail", ok: false },
        { label: "inbox pipeline", ok: true, notices: ["Held, not imported: A.pdf"] },
      ],
      { activity: false }
    );
    expect(withNotice.kind).toBe("log");
    const recovered = recordHourlyEmailRun([{ label: "fetch broker e-mail", ok: true }], { activity: false });
    expect(recovered.kind).toBe("log");
    expect(recovered.recovered_from).not.toBeNull();
  });

  it("a badged failure carries its notices itself", () => {
    const r = recordHourlyEmailRun(
      [
        { label: "fetch broker e-mail", ok: false },
        { label: "inbox pipeline", ok: true, notices: ["Held, not imported: A.pdf"] },
      ],
      { activity: false }
    );
    expect(r.kind).toBe("notification");
    expect(r.notice_message_id).toBeNull();
    expect(r.body).toContain("notice: Held, not imported: A.pdf");
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

  it("records a quiet success after a failed poll as a notification — the recovery must reach the tab", () => {
    recordHourlyEmailRun([{ label: "fetch broker e-mail", ok: false }], { activity: false });
    const recovered = recordHourlyEmailRun([{ label: "fetch broker e-mail", ok: true, seconds: 5 }], {
      activity: false,
    });
    expect(recovered.recorded).toBe(true);
    expect(recovered.kind).toBe("notification");
    expect(recovered.recovered_from).not.toBeNull();
    const row = db
      .prepare(`SELECT kind, title FROM app_messages WHERE id = ?`)
      .get(recovered.message_id) as { kind: string; title: string };
    expect(row.kind).toBe("notification");
    expect(row.title).toBe(HOURLY_EMAIL_RUN_MESSAGE_TITLE);
    expect(recovered.body).toMatch(/Recovered: the previous run/);

    // Back to the quiet rule once a success is on top.
    const quiet = recordHourlyEmailRun([{ label: "fetch broker e-mail", ok: true, seconds: 5 }], {
      activity: false,
    });
    expect(quiet.recorded).toBe(false);
  });

  it("notifies the recovery of a badged outage even when its last failure was a log", () => {
    recordHourlyEmailRun([{ label: "fetch broker e-mail", ok: false }], { activity: false });
    const repeat = recordHourlyEmailRun([{ label: "fetch broker e-mail", ok: false }], { activity: false });
    expect(repeat.kind).toBe("log");
    const recovered = recordHourlyEmailRun([{ label: "fetch broker e-mail", ok: true, seconds: 5 }], {
      activity: false,
    });
    expect(recovered.kind).toBe("notification");
    expect(recovered.recovered_from).not.toBeNull();
  });

  it("badges a second outage of the day, and its recovery", () => {
    recordHourlyEmailRun([{ label: "fetch broker e-mail", ok: false }], { activity: false });
    recordHourlyEmailRun([{ label: "fetch broker e-mail", ok: true, seconds: 5 }], { activity: false });
    // The first outage recovered: a new failure the same Chile day is a new outage.
    const again = recordHourlyEmailRun([{ label: "fetch broker e-mail", ok: false }], { activity: false });
    expect(again.kind).toBe("notification");
    const recovered = recordHourlyEmailRun([{ label: "fetch broker e-mail", ok: true, seconds: 5 }], {
      activity: false,
    });
    expect(recovered.kind).toBe("notification");
    expect(recovered.body).toMatch(/Recovered: the previous run/);
  });

  it("badges a step that starts failing during an outage, not one that keeps failing or recovers", () => {
    const first = recordHourlyEmailRun(
      [
        { label: "fetch Lider BCI (hourly)", ok: false },
        { label: "Santander balance poll", ok: true },
      ],
      { activity: false }
    );
    expect(first.kind).toBe("notification");
    const newStep = recordHourlyEmailRun(
      [
        { label: "fetch Lider BCI (hourly)", ok: false },
        { label: "Santander balance poll", ok: false },
      ],
      { activity: false }
    );
    expect(newStep.kind).toBe("notification");
    const fewer = recordHourlyEmailRun(
      [
        { label: "fetch Lider BCI (hourly)", ok: true },
        { label: "Santander balance poll", ok: false },
      ],
      { activity: false }
    );
    expect(fewer.kind).toBe("log");
  });

  it("deletes a failure's steps with its message", () => {
    const failed = recordHourlyEmailRun([{ label: "fetch broker e-mail", ok: false }], { activity: false });
    const count = () =>
      (db.prepare(`SELECT COUNT(*) AS c FROM app_message_failed_steps WHERE message_id = ?`).get(failed.message_id) as {
        c: number;
      }).c;
    expect(count()).toBe(1);
    db.prepare(`DELETE FROM app_messages WHERE id = ?`).run(failed.message_id);
    expect(count()).toBe(0);
  });

  it("stays invisible to the daily run's staleness reads", () => {
    recordHourlyEmailRun([{ label: "Lider boletas import", ok: true }], { activity: true });
    recordHourlyEmailRun([{ label: "fetch broker e-mail", ok: false }], { activity: false });
    expect(lastDailyRunAt()).toBeNull();
    expect(staleDailyRunDays()).toBeNull();
  });
});
