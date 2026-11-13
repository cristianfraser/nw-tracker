import { z } from "zod";

/** Every ingest route lives under this prefix: `POST <prefix>/<kind>`. */
export const INGEST_API_PATH = "/api/ingest";

/**
 * Where a document came from, as the feeder saw it. `ref` is the document's stable identity
 * (file sha256, e-mail message id, capture file name): the server keeps it as provenance and
 * a feeder resending the same document sends the same ref.
 */
export const ingestSourceSchema = z
  .object({
    /** How the document reached the feeder. */
    channel: z.enum(["file", "email", "web_session", "api", "manual"]),
    ref: z.string().min(1).max(512),
    /** Human label: a filename, a mail subject. Never used for matching. */
    label: z.string().max(512).optional(),
    fetched_at: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export type IngestSource = z.infer<typeof ingestSourceSchema>;

/** Who is feeding: `ingest` for this repo's package; another feeder picks its own id. */
export const feederIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

/**
 * The body of every `POST /api/ingest/<kind>`. The kind is in the path; `schema_version`
 * must be the version the server implements for that kind, and `payload` is checked against
 * that kind's schema.
 */
export const ingestEnvelopeSchema = z
  .object({
    schema_version: z.number().int().positive(),
    feeder_id: feederIdSchema,
    source: ingestSourceSchema,
    /**
     * Run the document through the server and report, writing nothing: the server applies it
     * inside a transaction it rolls back. The only way to ask for a report-only send.
     */
    dry_run: z.boolean().default(false),
    payload: z.unknown(),
  })
  .strict();

export type IngestEnvelope<P = unknown> = Omit<z.infer<typeof ingestEnvelopeSchema>, "payload"> & {
  payload: P;
};

/**
 * One disagreement behind a `conflict`: `at` names what was compared (`<table>:<key>`, or
 * `ingest_documents:<kind>|<ref>` for a resent document), `fields` the fields that differ.
 */
export const ingestConflictEntrySchema = z
  .object({
    at: z.string(),
    fields: z.array(z.string()),
    message: z.string(),
  })
  .strict();

export type IngestConflictEntry = z.infer<typeof ingestConflictEntrySchema>;

/**
 * What the server did with a document. `applied`: the handler ran (and wrote, unless `dry_run`).
 * `duplicate`: a `document` kind's ref was already applied with this payload; nothing ran, and
 * `details` are the first answer's. `conflict`: the document disagrees with what the server holds
 * and nothing was written — `conflicts` point at each disagreement, `message` sums them up.
 * `retry`: the outcome may change if the same document is sent again later (a card line not
 * imported yet, a pairing still ambiguous): the feeder keeps it staged. False: the feeder is done
 * with it (archive it, or hand a conflict to a human).
 */
export const ingestResultSchema = z
  .object({
    status: z.enum(["applied", "duplicate", "conflict"]),
    kind: z.string(),
    schema_version: z.number().int().positive(),
    retry: z.boolean(),
    dry_run: z.boolean(),
    message: z.string().optional(),
    conflicts: z.array(ingestConflictEntrySchema).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type IngestResult = z.infer<typeof ingestResultSchema>;

/** Error bodies of a refused request (4xx), keyed by `error`. */
export const INGEST_ERROR_CODES = [
  "ingest_forbidden",
  "ingest_disabled",
  "unknown_ingest_kind",
  "unsupported_schema_version",
  "invalid_envelope",
  "invalid_payload",
  /** A currency the server's `currencies` table does not know. */
  "unknown_currency",
  /** A known currency the kind's handler cannot apply yet (it handles pesos and dollars only). */
  "unsupported_currency",
  /** A kind whose handler dates rows by when the document was read, sent without `source.fetched_at`. */
  "missing_fetched_at",
  "unknown_ingest_run",
  "invalid_run_report",
  "run_not_waiting",
  "unknown_ingest_task",
  "invalid_task_request",
  /** A task request the server checked and refused (e.g. a transfer that cannot be adopted). */
  "task_refused",
  /** Job queue (`jobs.ts`): no such job, or it is not in the state the request needs. */
  "unknown_job",
  "job_not_running",
  "invalid_job_request",
] as const;

export type IngestErrorCode = (typeof INGEST_ERROR_CODES)[number];

export const ingestErrorSchema = z
  .object({
    error: z.enum(INGEST_ERROR_CODES),
    message: z.string(),
    issues: z.array(z.unknown()).optional(),
  })
  .strict();

export type IngestErrorBody = z.infer<typeof ingestErrorSchema>;
