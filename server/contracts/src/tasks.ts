import { z } from "zod";

/**
 * Server tasks a feeder run asks for (Phase 4): work on the server's own data that belongs in a
 * run's sequence — after the card feed lands, after the receipts are sent — and that only the
 * server may do, since it is the one process that writes the database.
 *
 *   feeder → server  POST /api/ingest/tasks/<task>   IngestTaskRequest → IngestTaskResult
 *
 * `cc_payment_mirrors`: pair checking debits with the card payments they paid and convert each
 * pair into a `pago_tarjeta` transfer. `synthetic_cc_payments_check`: fail when a card payment
 * synthesized from a receipt has no bank listing by its deadline. `cc_bank_cupo_check`: judge the
 * bank's latest stated cupo against what the app says each card owes.
 */
export const INGEST_TASKS_API_PATH = "/api/ingest/tasks";

export const INGEST_TASK_NAMES = ["cc_payment_mirrors", "synthetic_cc_payments_check", "cc_bank_cupo_check"] as const;
export type IngestTaskName = (typeof INGEST_TASK_NAMES)[number];

export const ingestTaskRequestSchema = z
  .object({
    /** Report what the task would do, change nothing. */
    dry_run: z.boolean().default(false),
    /** `cc_bank_cupo_check`: judge the latest capture again, against the ledger as it stands. */
    recheck: z.boolean().default(false),
  })
  .strict();

export type IngestTaskRequest = z.input<typeof ingestTaskRequestSchema>;

export const ingestTaskResultSchema = z
  .object({
    task: z.enum(INGEST_TASK_NAMES),
    /** False: the task found something wrong — the run's step fails. */
    ok: z.boolean(),
    /** What the task did, line by line, as the feeder prints it. */
    report: z.array(z.string()),
  })
  .strict();

export type IngestTaskResult = z.infer<typeof ingestTaskResultSchema>;
