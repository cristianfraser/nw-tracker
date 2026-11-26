import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import { runSyncStepIfStale, takeSyncStepOutcomes } from "./globalSyncStep.js";
import { chileWallClockNow } from "./chileDate.js";
import type { SyncStepError } from "./syncRunLog.js";
import {
  recordSyncSourceOutcomes,
  SYNC_SOURCE_FAILING_NOTIFY_AFTER_MS,
  SYNC_SOURCE_FAILING_RENOTIFY_AFTER_MS,
  SYNC_SOURCE_FAILING_TITLE_PREFIX,
  SYNC_SOURCE_RECOVERED_TITLE_PREFIX,
  syncSourceFailureStreak,
  type SyncSourceOutcome,
} from "./syncSourceFailures.js";
import type { GlobalSyncSource } from "./syncSourceIds.js";

// Synthetic labels, so the messages this file writes are its own whatever the fork's database holds.
const SOURCE: GlobalSyncSource = "crypto_eod";
const LABEL = "vitest-sync-failures Crypto EOD";
const DEMO_SOURCE: GlobalSyncSource = "cmf_rn_portfolio";
const DEMO_LABEL = "vitest-sync-failures CMF";

const T0 = new Date("2026-03-10T21:00:00Z");
const MIN = 60_000;
const at = (ms: number) => new Date(T0.getTime() + ms);

function fail(when: Date, message = "HTTP 503", source = SOURCE, label = LABEL): SyncSourceOutcome {
  return { source, label, at: when, ok: false, message };
}
function ok(when: Date, source = SOURCE, label = LABEL): SyncSourceOutcome {
  return { source, label, at: when, ok: true };
}

function messages(): { kind: string; title: string; body: string }[] {
  return db
    .prepare(`SELECT kind, title, body FROM app_messages WHERE title LIKE ? ORDER BY id`)
    .all(`%vitest-sync-failures%`) as { kind: string; title: string; body: string }[];
}

function cleanUp(): void {
  db.prepare(`DELETE FROM sync_source_failure_streaks WHERE source IN (?, ?)`).run(SOURCE, DEMO_SOURCE);
  db.prepare(`DELETE FROM app_messages WHERE title LIKE ?`).run(`%vitest-sync-failures%`);
}

/** A failing attempt every 15 minutes from `fromMs` to `toMs` (inclusive), as the stale poll makes. */
function failEvery15Min(fromMs: number, toMs: number): void {
  for (let t = fromMs; t <= toMs; t += 15 * MIN) recordSyncSourceOutcomes([fail(at(t))], { dryRun: false });
}

describe("recordSyncSourceOutcomes", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("escalates a failing streak once past the threshold, then once a day, and recovers", () => {
    failEvery15Min(0, SYNC_SOURCE_FAILING_NOTIFY_AFTER_MS - 15 * MIN);
    expect(messages()).toEqual([]);
    const streak = syncSourceFailureStreak(SOURCE)!;
    expect(streak.failing_since).toBe("2026-03-10 21:00:00");
    expect(streak.failures).toBe(48);
    expect(streak.notified_at).toBeNull();

    // The first attempt at the threshold notifies; the rest of the day does not.
    failEvery15Min(SYNC_SOURCE_FAILING_NOTIFY_AFTER_MS, SYNC_SOURCE_FAILING_NOTIFY_AFTER_MS + 20 * 60 * MIN);
    let msgs = messages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.kind).toBe("notification");
    expect(msgs[0]!.title).toBe(`${SYNC_SOURCE_FAILING_TITLE_PREFIX}${LABEL}`);
    // 21:00 UTC on 2026-03-10 is 18:00 in Chile (summer time, UTC−3).
    expect(msgs[0]!.body).toContain("since 2026-03-10 18:00");
    expect(msgs[0]!.body).toContain("Last error: HTTP 503");

    // A further day of failures: one more notification.
    const renotifyAt = SYNC_SOURCE_FAILING_NOTIFY_AFTER_MS + SYNC_SOURCE_FAILING_RENOTIFY_AFTER_MS;
    failEvery15Min(SYNC_SOURCE_FAILING_NOTIFY_AFTER_MS + 21 * 60 * MIN, renotifyAt + 60 * MIN);
    msgs = messages();
    expect(msgs.map((m) => m.kind)).toEqual(["notification", "notification"]);

    // Success ends the streak: a recovered notification (the streak had been badged).
    recordSyncSourceOutcomes([ok(at(renotifyAt + 2 * 60 * MIN))], { dryRun: false });
    expect(syncSourceFailureStreak(SOURCE)).toBeNull();
    msgs = messages();
    expect(msgs).toHaveLength(3);
    expect(msgs[2]!.kind).toBe("notification");
    expect(msgs[2]!.title).toBe(`${SYNC_SOURCE_RECOVERED_TITLE_PREFIX}${LABEL}`);
    expect(msgs[2]!.body).toContain("after failing since 2026-03-10 18:00");

    // Another success writes nothing.
    recordSyncSourceOutcomes([ok(at(renotifyAt + 3 * 60 * MIN))], { dryRun: false });
    expect(messages()).toHaveLength(3);
  });

  it("starts a second streak from scratch after a recovery", () => {
    failEvery15Min(0, SYNC_SOURCE_FAILING_NOTIFY_AFTER_MS);
    recordSyncSourceOutcomes([ok(at(SYNC_SOURCE_FAILING_NOTIFY_AFTER_MS + 15 * MIN))], { dryRun: false });
    expect(messages()).toHaveLength(2);

    const second = SYNC_SOURCE_FAILING_NOTIFY_AFTER_MS + 60 * MIN;
    failEvery15Min(second, second + SYNC_SOURCE_FAILING_NOTIFY_AFTER_MS - 15 * MIN);
    expect(messages()).toHaveLength(2);
    expect(syncSourceFailureStreak(SOURCE)!.notified_at).toBeNull();
    recordSyncSourceOutcomes([fail(at(second + SYNC_SOURCE_FAILING_NOTIFY_AFTER_MS), "timeout")], { dryRun: false });
    const msgs = messages();
    expect(msgs).toHaveLength(3);
    expect(msgs[2]!.kind).toBe("notification");
    expect(msgs[2]!.body).toContain("Last error: timeout");
  });

  it("a short outage recovers with a log line only", () => {
    recordSyncSourceOutcomes([fail(at(0)), fail(at(15 * MIN))], { dryRun: false });
    recordSyncSourceOutcomes([ok(at(30 * MIN))], { dryRun: false });
    const msgs = messages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.kind).toBe("log");
    expect(msgs[0]!.body).toContain("(2 attempts)");
  });

  it("a source attempted once a day notifies on its second failed day", () => {
    recordSyncSourceOutcomes([fail(at(0))], { dryRun: false });
    recordSyncSourceOutcomes([fail(at(24 * 60 * MIN - 10_000))], { dryRun: false });
    expect(messages()).toHaveLength(1);
    // The next day's attempt, a few seconds under 24 h after the notification, repeats it.
    recordSyncSourceOutcomes([fail(at(48 * 60 * MIN - 20_000))], { dryRun: false });
    expect(messages()).toHaveLength(2);
  });

  it("records nothing on a dry run or for a source the deployment never runs", () => {
    recordSyncSourceOutcomes([fail(at(0))], { dryRun: true });
    expect(syncSourceFailureStreak(SOURCE)).toBeNull();

    vi.stubEnv("DEMO_MODE", "1");
    recordSyncSourceOutcomes([fail(at(0), "x", DEMO_SOURCE, DEMO_LABEL)], { dryRun: false });
    recordSyncSourceOutcomes([fail(at(2 * SYNC_SOURCE_FAILING_NOTIFY_AFTER_MS), "x", DEMO_SOURCE, DEMO_LABEL)], {
      dryRun: false,
    });
    expect(syncSourceFailureStreak(DEMO_SOURCE)).toBeNull();
    expect(messages()).toEqual([]);
    vi.unstubAllEnvs();
  });
});

describe("runSyncStepIfStale outcomes", () => {
  it("keeps each attempted source's outcome with its run; a pushed step error is not a failure", async () => {
    const cl = chileWallClockNow();
    const errors: SyncStepError[] = [];
    const other: SyncStepError[] = [];
    await runSyncStepIfStale("stocks_nyse", ["stocks_nyse", "crypto_eod"], errors, {}, cl, async () => {
      throw new Error("Yahoo 429");
    });
    await runSyncStepIfStale("crypto_eod", ["stocks_nyse", "crypto_eod"], errors, {}, cl, async () => {
      errors.push({ step: "Crypto EOD", message: "a finding about the data" });
    });
    await runSyncStepIfStale("sbif_uf", ["stocks_nyse"], errors, {}, cl, async () => {});
    await runSyncStepIfStale("sbif_uf", ["sbif_uf"], other, {}, cl, async () => {});

    const outcomes = takeSyncStepOutcomes(errors);
    expect(outcomes.map((o) => [o.source, o.ok])).toEqual([
      ["stocks_nyse", false],
      ["crypto_eod", true],
    ]);
    expect(outcomes[0]).toMatchObject({ label: "NYSE stocks", message: "Yahoo 429" });
    expect(takeSyncStepOutcomes(errors)).toEqual([]);
    expect(takeSyncStepOutcomes(other).map((o) => o.source)).toEqual(["sbif_uf"]);
  });
});
