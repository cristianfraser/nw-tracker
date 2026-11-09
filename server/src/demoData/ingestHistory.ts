/**
 * The demo's ingest history (docs/demo-about-plan.md, step 4): what the scheduler and the ingest
 * service would have recorded while the fictional person's documents arrived, so «Import sync» and
 * «Notifications» show the pipeline. Generated, like everything else in the demo, from the same
 * story: a nightly run at 22:00 Chile every day, an hourly poll at :30 every hour (it records an
 * app message only when it imported something — a document's mail landed that hour — or failed),
 * the nightly bank checks (card cupo and deposit balances, set to what the ledger says that night,
 * so they agree), and a few rare failures that recover on the next run.
 *
 * Written through the real writers: the job queue (enqueue, claim, complete), the run rows
 * (`markIngestRunRequested`), the run messages (`recordDailyRun` / `recordHourlyEmailRun`, which
 * decide log vs notification and the «Recovered» line), the bank checks (`recordBankCupoCapture`,
 * `applyBankAccountBalances` and the nightly check task). Those writers stamp the wall clock, so
 * every row they write is re-dated to its run right after (oldest first, so «the previous run»
 * reads are right). The demo's scheduler is off, so nothing is appended after the build: the
 * history ends with the last hourly poll of the night before `today`.
 *
 * Deterministic: each month draws from its own stream (`stream(seed, "<month>|ingest")`).
 */
import { applyBankAccountBalances, ledgerBalanceInOwnCurrency } from "../bankAccountBalances.js";
import { ccOwedByCurrency } from "../ccOwedByCurrency.js";
import { chileCalendarAddDays, dateAtTimeZoneWallClock } from "../chileDate.js";
import { recordDailyRun, recordHourlyEmailRun, type DailyRunStep } from "../dailyRunLog.js";
import { db } from "../db.js";
import { markIngestRunRequested } from "../ingestRuns.js";
import { INGEST_SERVICE_WORKER, SCHEDULER_ENQUEUED_BY } from "../ingestRunScheduler.js";
import { INGEST_TASKS } from "../ingestTasks.js";
import { claimJob, completeJob, enqueueJob, heartbeatJob } from "../jobQueue.js";
import { isChileBusinessDay } from "../marketHolidays.js";
import { recordBankCupoCapture } from "../santanderBankCupo.js";
import { addMonths, monthOf, type Person, type Ymd } from "./person.js";
import { stream, type Rng } from "./rng.js";
import type { Acct, Ledger } from "./simulate.js";

const HOUR_MS = 3_600_000;

/** `app_messages.created_at` / SQLite `datetime('now')` format, UTC. */
function sqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function chileAt(ymd: Ymd, hour: number, minute = 0): Date {
  return dateAtTimeZoneWallClock(ymd, hour, minute, "America/Santiago");
}

/** A step of `lo`–`hi` seconds, rounded to tenths like the runners' timings. */
function step(r: Rng, label: string, lo: number, hi: number, ok = true): DailyRunStep {
  return { label, ok, seconds: Math.round(r.range(lo, hi) * 10) / 10 };
}

type MailDoc = { label: "Santander e-mail documents" | "BCI statement e-mail"; what: string };

/**
 * The hour (Chile, `YYYY-MM-DD HH`) each mail-borne document landed, from the documents the
 * generator rendered: card statements a day after their close, cartolas a few days into the next
 * month. The hourly poll at :30 of that hour imports it.
 */
function mailArrivals(ledger: Ledger, person: Person, fromYmd: Ymd, toYmd: Ymd): Map<string, MailDoc[]> {
  const out = new Map<string, MailDoc[]>();
  const add = (ymd: Ymd, r: Rng, doc: MailDoc) => {
    if (ymd < fromYmd || ymd > toYmd) return;
    const key = `${ymd} ${String(r.int(9, 19)).padStart(2, "0")}`;
    out.set(key, [...(out.get(key) ?? []), doc]);
  };
  for (const s of ledger.statements) {
    const card = person.cards.find((c) => c.key === s.card)!;
    const r = stream(person.seed, `${s.close}|ingest|statement|${s.card}|${s.currency}`);
    const label = card.issuer === "bci" ? "BCI statement e-mail" : "Santander e-mail documents";
    add(chileCalendarAddDays(s.close, r.int(1, 2)), r, { label, what: `${card.displayName} ${s.currency.toUpperCase()} statement` });
  }
  // One cartola mail a month (cuenta corriente and cuenta vista together), from the account's first month.
  const firstBankMonth = ledger.bank.reduce<string | null>((m, b) => (m == null || b.date < m ? b.date : m), null);
  if (firstBankMonth) {
    for (let m = monthOf(firstBankMonth); `${addMonths(m, 1)}-01` <= toYmd; m = addMonths(m, 1)) {
      const r = stream(person.seed, `${m}|ingest|cartola`);
      let d = `${addMonths(m, 1)}-01`;
      for (let k = r.int(2, 4); k > 0; ) {
        d = chileCalendarAddDays(d, 1);
        if (isChileBusinessDay(d)) k -= 1;
      }
      add(d, r, { label: "Santander e-mail documents", what: `cartolas ${m}` });
    }
  }
  return out;
}

/** The checks' rows carry `datetime('now')`; give them the run's instant. */
function redateChecks(at: Date, firstMessageId: number): void {
  const stamp = sqliteUtc(at);
  db.prepare(`UPDATE app_messages SET created_at = ? WHERE id > ?`).run(stamp, firstMessageId);
  db.prepare(`UPDATE cc_bank_cupo_captures SET checked_at = ? WHERE checked_at IS NOT NULL AND observed_at = ?`).run(stamp, at.toISOString());
  db.prepare(
    `UPDATE cc_bank_cupo_checks SET checked_at = ? WHERE snapshot_id IN (
       SELECT s.id FROM cc_bank_cupo_snapshots s JOIN cc_bank_cupo_captures c ON c.id = s.capture_id WHERE c.observed_at = ?)`
  ).run(stamp, at.toISOString());
  db.prepare(
    `UPDATE bank_account_balance_checks SET checked_at = ? WHERE snapshot_id IN (
       SELECT id FROM bank_account_balance_snapshots WHERE observed_at = ?)`
  ).run(stamp, at.toISOString());
  db.prepare(`UPDATE bank_account_balance_snapshots SET created_at = ? WHERE observed_at = ?`).run(stamp, at.toISOString());
}

function maxMessageId(): number {
  return (db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM app_messages`).get() as { m: number }).m;
}

/**
 * The night's bank checks, as the nightly's «CC bank cupo check» step runs them after the session:
 * the Santander card's cupo per currency and the declared deposit accounts' balances, each stated
 * as what the ledger holds that night (they agree; a mismatch would be a fiction nobody can fix).
 */
function nightlyBankChecks(ids: Map<Acct, number>, person: Person, ymd: Ymd, observedAt: Date): void {
  const card = person.cards.find((c) => c.issuer === "santander");
  const cardId = card ? ids.get(`card:${card.key}` as Acct) : undefined;
  const source = `demo-card-movements-${observedAt.toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`;
  if (card && cardId != null) {
    const cfg = db.prepare(`SELECT cupo_clp, cupo_usd FROM credit_card_account_config WHERE account_id = ?`).get(cardId) as {
      cupo_clp: number;
      cupo_usd: number;
    };
    const owed = ccOwedByCurrency(cardId, ymd);
    const bankAccount = `8000${card.last4}`;
    const row = (currency: "clp" | "usd", used: number, limit: number) => ({
      account_id: cardId,
      currency,
      bank_account: bankAccount,
      plastic_last4: card.last4,
      cupo_total: Math.max(limit, used),
      cupo_utilizado: used,
      cupo_disponible: Math.max(limit, used) - used,
    });
    recordBankCupoCapture(
      source,
      {
        status: "present",
        observed_at: observedAt.toISOString(),
        rows: [
          row("clp", Math.round(owed.clp.total), cfg.cupo_clp),
          row("usd", Math.round(owed.usd.total * 100) / 100, cfg.cupo_usd),
        ],
      },
      new Map(owed.close_iso ? [[bankAccount, { close_iso: owed.close_iso }]] : [])
    );
  }
  const declared = db
    .prepare(`SELECT account_id, number, currency FROM bank_account_numbers WHERE issuer = 'santander' ORDER BY account_id`)
    .all() as { account_id: number; number: string; currency: "clp" | "usd" }[];
  if (declared.length > 0) {
    applyBankAccountBalances(
      {
        issuer: "santander",
        observed_at: observedAt.toISOString(),
        accounts: declared.map((d) => ({
          number: d.number,
          product: "checking" as const,
          currency: d.currency,
          // The reader the check uses, so the stated balance is the ledger's to the cent.
          balance: ledgerBalanceInOwnCurrency(d.account_id, d.currency, ymd),
          label: d.currency === "usd" ? "Cuenta Corriente USD" : "Cuenta Corriente",
          status: "active",
        })),
      },
      source
    );
  }
  INGEST_TASKS.cc_bank_cupo_check({ dry_run: false, recheck: false });
}

type RunPlan = {
  kind: "nightly" | "hourly";
  slot: Date;
  reason: string;
  steps: DailyRunStep[];
  activity: boolean;
  santander: { request: "balance-poll" | null; reason: string | null; outcome: "ok" | "failed" | null };
  /** Run after the steps' first ~minute: the night's bank checks. */
  bankChecks?: Ymd;
};

function nightlyPlan(r: Rng, ymd: Ymd, payslipNight: boolean, hasMortgage: boolean, bankFails: boolean): RunPlan {
  const steps: DailyRunStep[] = [
    step(r, "fetch Santander", bankFails ? 92 : 64, bankFails ? 96 : 110, !bankFails),
    step(r, "Santander e-mail documents", 3, 8),
    step(r, "BCI statement e-mail", 2, 6),
    step(r, "AFC cartolas e-mail", 2, 5),
    step(r, "inbox pipeline", 11, 26),
    step(r, "Santander movements", 2, 5),
    step(r, "Santander USD movements", 1, 3),
    step(r, "Convert CC payment mirrors after card feed", 1, 3),
    step(r, "CC bank cupo check", 2, 5),
    ...(hasMortgage ? [step(r, "Mortgage card match check", 1, 2)] : []),
    step(r, "Transfer mails", 6, 13),
    step(r, "Payment receipt mails", 5, 11),
    step(r, "Utility bill mails", 4, 9),
    step(r, "fetch broker e-mail", 3, 7),
    step(r, "broker e-mail check", 1, 2),
    step(r, "AFP UNO (apply)", 24, 41),
    ...(payslipNight ? [step(r, "parse payslips", 3, 6), step(r, "payroll parameters", 2, 4), step(r, "import payslips", 2, 5)] : []),
    step(r, "Santander statements (apply)", 2, 6),
  ];
  return {
    kind: "nightly",
    slot: chileAt(ymd, 22),
    reason: "22:00 slot, on time",
    steps,
    activity: true,
    santander: { request: null, reason: null, outcome: bankFails ? "failed" : "ok" },
    bankChecks: bankFails ? undefined : ymd,
  };
}

function hourlyPlan(r: Rng, slot: Date, docs: readonly MailDoc[], balancePoll: boolean, mailFails: boolean): RunPlan {
  const failing = mailFails ? r.pick(["Santander e-mail documents", "Transfer mails"] as const) : null;
  const has = (label: MailDoc["label"]) => docs.some((d) => d.label === label);
  const steps: DailyRunStep[] = [
    step(r, "Santander e-mail documents", has("Santander e-mail documents") ? 5 : 2, has("Santander e-mail documents") ? 9 : 5, failing !== "Santander e-mail documents"),
    step(r, "BCI statement e-mail", has("BCI statement e-mail") ? 4 : 1.5, has("BCI statement e-mail") ? 7 : 4),
    step(r, "fetch broker e-mail", 2, 4),
    ...(balancePoll ? [step(r, "Santander balance poll", 24, 37)] : []),
    ...(docs.length > 0 ? [step(r, "inbox pipeline", 14, 38)] : []),
    step(r, "Transfer mails", 3, 7, failing !== "Transfer mails"),
  ];
  return {
    kind: "hourly",
    slot,
    reason: ":30 slot, on time",
    steps,
    activity: docs.length > 0,
    santander: balancePoll
      ? { request: "balance-poll", reason: "hourly: the bank's balances against the app", outcome: "ok" }
      : { request: null, reason: null, outcome: null },
  };
}

/** One run through the queue, the run row and its message, re-dated to the run. */
function writeRun(plan: RunPlan, r: Rng, onStarted: (start: Date) => void): void {
  const enqueuedAt = new Date(plan.slot.getTime() + r.int(1, 25) * 1000);
  const { job } = enqueueJob(
    {
      kind: plan.kind === "nightly" ? "ingest.nightly" : "ingest.hourly",
      dedupe_key: plan.kind === "nightly" ? "ingest.nightly" : "ingest.hourly",
      payload: { slot: plan.slot.toISOString() },
      enqueued_by: SCHEDULER_ENQUEUED_BY,
      reason: plan.reason,
      not_before: plan.slot,
      stale_after: plan.kind === "hourly" ? new Date(plan.slot.getTime() + HOUR_MS) : null,
    },
    enqueuedAt
  );
  const start = new Date(enqueuedAt.getTime() + r.int(1, 4) * 1000);
  if (!claimJob(job.id, INGEST_SERVICE_WORKER, start)) throw new Error(`demo: ingest job ${job.id} could not be claimed`);
  const runId = markIngestRunRequested(
    plan.kind,
    plan.slot,
    plan.reason,
    start,
    plan.santander.request ? { mode: plan.santander.request, reason: plan.santander.reason ?? "" } : null,
    job.id
  );
  onStarted(start);
  const seconds = plan.steps.reduce((s, x) => s + (x.seconds ?? 0), 0);
  const finished = new Date(start.getTime() + Math.round((seconds + r.range(2, 6)) * 1000));
  heartbeatJob(job.id, new Date(Math.min(finished.getTime(), start.getTime() + 60_000)));
  const failedSteps = plan.steps.filter((s) => !s.ok).length;
  const ok = failedSteps === 0;
  db.prepare(
    `UPDATE ingest_runs SET status = ?, started_at = ?, finished_at = ?, exit_code = ?, failed_steps = ?,
       steps_json = ?, santander_outcome = ?, activity = ?, dry_run = 0
     WHERE id = ?`
  ).run(
    ok ? "done" : "failed",
    start.toISOString(),
    finished.toISOString(),
    failedSteps,
    failedSteps,
    JSON.stringify(plan.steps),
    plan.santander.outcome,
    plan.activity ? 1 : 0,
    runId
  );
  completeJob(
    job.id,
    {
      ok,
      result: { ingest_run_id: runId, exit_code: failedSteps, failed_steps: failedSteps, dry_run: false },
      error: ok ? null : `exit ${failedSteps}, ${failedSteps} failed step(s)`,
    },
    finished
  );
  const nowYmd = chileYmd(finished);
  const recorded =
    plan.kind === "nightly"
      ? recordDailyRun(plan.steps, { nowYmd }).message_id
      : recordHourlyEmailRun(plan.steps, { activity: plan.activity, nowYmd }).message_id;
  if (recorded != null) db.prepare(`UPDATE app_messages SET created_at = ? WHERE id = ?`).run(sqliteUtc(finished), recorded);
}

function chileYmd(d: Date): Ymd {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/**
 * Write `person.ingestHistoryDays` days of runs ending the night before `today`. Notifications
 * older than two days are marked read (a visitor's badge shows only the latest).
 */
export function writeIngestHistory(ledger: Ledger, ids: Map<Acct, number>, person: Person, today: Ymd): void {
  const days = person.ingestHistoryDays;
  if (days <= 0) return;
  const lastNight = chileCalendarAddDays(today, -1);
  const firstDay = chileCalendarAddDays(today, -days);
  const arrivals = mailArrivals(ledger, person, firstDay, lastNight);
  const payslipNights = new Set(ledger.payslips.map((p) => p.payDate));
  const hasMortgage = ledger.mortgage != null;

  const seenSlots = new Set<number>();
  db.transaction(() => {
    for (let ymd = firstDay; ymd <= lastNight; ymd = chileCalendarAddDays(ymd, 1)) {
      // One stream per day, drawn in a fixed order: a day's runs never depend on another day's.
      const r = stream(person.seed, `${monthOf(ymd)}|ingest|${ymd}`);
      const bankFails = r.chance(1 / 28);
      const writeNightly = (): void => {
        const plan = nightlyPlan(r, ymd, payslipNights.has(ymd), hasMortgage, bankFails);
        writeRun(plan, r, (start) => {
          if (!plan.bankChecks) return;
          const before = maxMessageId();
          // The checks run once the session's movements are in, about two minutes in.
          const at = new Date(start.getTime() + 2 * 60_000);
          nightlyBankChecks(ids, person, plan.bankChecks, at);
          redateChecks(at, before);
        });
      };
      for (let hour = 0; hour < 24; hour++) {
        const slot = new Date(chileAt(ymd, hour).getTime() + 30 * 60_000);
        if (slot.getTime() > chileAt(lastNight, 23, 59).getTime()) break;
        // A daylight-saving change repeats or skips an hour of the wall clock; a slot runs once.
        if (seenSlots.has(slot.getTime())) continue;
        seenSlots.add(slot.getTime());
        // The nightly runs between the 21:30 and 22:30 polls; the 21:30 poll leaves the bank to it.
        if (hour === 22) writeNightly();
        const docs = arrivals.get(`${ymd} ${String(hour).padStart(2, "0")}`) ?? [];
        const balancePoll = hour !== 21;
        writeRun(hourlyPlan(r, slot, docs, balancePoll, r.chance(1 / 240)), r, () => {});
      }
    }
    db.prepare(
      `UPDATE app_messages SET read_at = datetime(created_at, '+1 hour')
       WHERE kind = 'notification' AND read_at IS NULL AND created_at < ?`
    ).run(sqliteUtc(chileAt(chileCalendarAddDays(today, -2), 0)));
  })();
}
