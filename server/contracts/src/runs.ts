import { z } from "zod";

/**
 * The run protocol (docs/ingest-split-plan.md, Phase 2): the server decides WHEN a feeder runs
 * and asks it to; the feeder answers at once and reports back when the run is over.
 *
 *   server → feeder  POST <feeder>/runs                          IngestRunRequest → 202 | 409 busy
 *   feeder → server  POST /api/ingest/runs/<run_id>/complete     IngestRunCompletion
 */

/** `nightly`: the 22:00 run (bank sessions, every import). `hourly`: the :30 e-mail poll. */
export const INGEST_RUN_KINDS = ["nightly", "hourly"] as const;
export type IngestRunKind = (typeof INGEST_RUN_KINDS)[number];

export const INGEST_RUNS_API_PATH = "/api/ingest/runs";

/** The feeder's own endpoint for run requests. */
export const FEEDER_RUNS_PATH = "/runs";

export const ingestRunRequestSchema = z
  .object({
    run_id: z.number().int().positive(),
    kind: z.enum(INGEST_RUN_KINDS),
    /** Why the server asked now (the slot, a wake after a missed slot…), for the feeder's log. */
    reason: z.string().min(1),
  })
  .strict();

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

export const ingestRunStepSchema = z
  .object({ label: z.string().min(1), ok: z.boolean(), seconds: z.number().nonnegative() })
  .strict();

export type IngestRunStep = z.infer<typeof ingestRunStepSchema>;

export const ingestRunCompletionSchema = z
  .object({
    started_at: z.iso.datetime({ offset: true }),
    finished_at: z.iso.datetime({ offset: true }),
    /** The runner's exit status: its count of failed steps, or a crash code. */
    exit_code: z.number().int(),
    /** Each step the runner reported; null when it died before reporting any. */
    steps: z.array(ingestRunStepSchema).nullable(),
  })
  .strict();

export type IngestRunCompletion = z.infer<typeof ingestRunCompletionSchema>;
