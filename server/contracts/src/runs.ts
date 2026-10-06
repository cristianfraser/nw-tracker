import { z } from "zod";

/**
 * The run protocol (docs/ingest-split-plan.md, Phase 2): the server decides WHEN a feeder runs
 * and asks it to; the feeder answers at once and reports back when the run is over.
 *
 *   server → feeder  POST <feeder>/runs                          IngestRunRequest → 202 | 409 busy | 409 already_ran
 *
 * A request is idempotent per run id: the server cannot tell a request the feeder never got from
 * one whose answer it missed (a timeout right after a wake), so it asks again with the same id.
 * The run in progress answers 202 again; a finished one answers `already_ran`, never runs twice.
 *   feeder → server  POST /api/ingest/runs/<run_id>/complete     IngestRunCompletion
 */

/** `nightly`: the 22:00 run (bank sessions, every import). `hourly`: the :30 e-mail poll. */
export const INGEST_RUN_KINDS = ["nightly", "hourly"] as const;
export type IngestRunKind = (typeof INGEST_RUN_KINDS)[number];

export const INGEST_RUNS_API_PATH = "/api/ingest/runs";

/** The feeder's own endpoint for run requests. */
export const FEEDER_RUNS_PATH = "/runs";

/**
 * An hourly poll may also fetch the bank: `catch-up` retries a nightly fetch that failed or never
 * ran (once per nightly slot), `payday` fetches movements on the month's last business day so the
 * salary shows the same morning. The nightly always fetches.
 */
export const SANTANDER_FETCH_MODES = ["catch-up", "payday"] as const;
export type SantanderFetchMode = (typeof SANTANDER_FETCH_MODES)[number];

export const ingestRunRequestSchema = z
  .object({
    run_id: z.number().int().positive(),
    kind: z.enum(INGEST_RUN_KINDS),
    /** Why the server asked now (the slot, a wake after a missed slot…), for the feeder's log. */
    reason: z.string().min(1),
    /** Hourly only: a bank fetch the server wants in this poll, and why. */
    santander_fetch: z
      .object({ mode: z.enum(SANTANDER_FETCH_MODES), reason: z.string().min(1) })
      .strict()
      .nullable(),
    /**
     * Nightly only: read the pension fund manager's certificates this run, and why (from the 10th
     * of a month until a read imports new rows cleanly). Absent = no.
     */
    afp_uno_fetch: z.object({ reason: z.string().min(1) }).strict().nullable().default(null),
    /**
     * Nightly only: import the payslips this run, and first read the payroll portal when `fetch`
     * (from the 1st of a month until the previous month's payslip is stored). Absent = no.
     */
    payslips: z.object({ fetch: z.boolean(), reason: z.string().min(1) }).strict().nullable().default(null),
  })
  .strict()
  .refine((r) => r.kind === "hourly" || r.santander_fetch === null, {
    message: "only an hourly run takes a santander_fetch",
  })
  .refine((r) => r.kind === "nightly" || r.afp_uno_fetch === null, {
    message: "only a nightly run takes an afp_uno_fetch",
  })
  .refine((r) => r.kind === "nightly" || r.payslips === null, {
    message: "only a nightly run takes payslips",
  });

export type IngestRunRequest = z.infer<typeof ingestRunRequestSchema>;

/** 409 body: the feeder is already running something. */
export const feederBusySchema = z
  .object({
    error: z.literal("busy"),
    running: z
      .object({ run_id: z.number().int().positive().nullable(), kind: z.string(), started_at: z.iso.datetime({ offset: true }) })
      .strict(),
  })
  .strict();

/** 409 body: the feeder already ran this run id; its report is on the way (or was delivered). */
export const feederAlreadyRanSchema = z
  .object({ error: z.literal("already_ran"), run_id: z.number().int().positive() })
  .strict();

export const ingestRunStepSchema = z
  .object({ label: z.string().min(1), ok: z.boolean(), seconds: z.number().nonnegative() })
  .strict();

export type IngestRunStep = z.infer<typeof ingestRunStepSchema>;

/**
 * The feeder's own facts about the bank, read when the run ends; the server decides the next
 * catch-up / payday fetch from them. `last_attempt_at`: the newest login attempt (any outcome);
 * `last_success_at`: the newest successful card-feed fetch; `login_latched`: the stored password
 * was rejected and logins are off until it is replaced; `last_catch_up_attempt_at` /
 * `last_payday_attempt_ymd`: the feeder's own markers of the latest catch-up and payday fetch
 * (written by every runner that makes one, the shell fallback included), so attempts made
 * outside this server's run history still count.
 */
export const santanderStateSchema = z
  .object({
    last_attempt_at: z.iso.datetime({ offset: true }).nullable(),
    last_success_at: z.iso.datetime({ offset: true }).nullable(),
    login_latched: z.boolean(),
    last_catch_up_attempt_at: z.iso.datetime({ offset: true }).nullable(),
    last_payday_attempt_ymd: z.iso.date().nullable(),
  })
  .strict();

export type SantanderState = z.infer<typeof santanderStateSchema>;

/**
 * What became of the run's bank fetch. `vetoed`: the feeder declined a fetch the server asked for
 * (the login is latched, or the bank was tried moments ago) — it did not count as an attempt.
 */
export const santanderFetchOutcomeSchema = z
  .object({
    mode: z.enum(["nightly", ...SANTANDER_FETCH_MODES]),
    outcome: z.enum(["ok", "failed", "vetoed"]),
    note: z.string().nullable(),
  })
  .strict();

export type SantanderFetchOutcome = z.infer<typeof santanderFetchOutcomeSchema>;

export const ingestRunCompletionSchema = z
  .object({
    started_at: z.iso.datetime({ offset: true }),
    finished_at: z.iso.datetime({ offset: true }),
    /** The runner's exit status: its count of failed steps, or a crash code. */
    exit_code: z.number().int(),
    /** Each step the runner reported; null when it died before reporting any. */
    steps: z.array(ingestRunStepSchema).nullable(),
    /** A rehearsal: nothing fetched or written, and nothing to record. */
    dry_run: z.boolean(),
    /** Hourly: something was fetched or imported (a quiet poll is not recorded). */
    activity: z.boolean(),
    /** Null when the run did not try the bank. */
    santander: santanderFetchOutcomeSchema.nullable(),
    santander_state: santanderStateSchema,
  })
  .strict();

export type IngestRunCompletion = z.infer<typeof ingestRunCompletionSchema>;
