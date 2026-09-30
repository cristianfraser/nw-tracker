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
    payload: z.unknown(),
  })
  .strict();

export type IngestEnvelope<P = unknown> = Omit<z.infer<typeof ingestEnvelopeSchema>, "payload"> & {
  payload: P;
};

/**
 * What the server did with a document. `duplicate`: already applied, nothing written.
 * `conflict`: the document disagrees with what the server holds and was not applied — the
 * message says why; the feeder keeps the document for a later retry or a human.
 */
export const ingestResultSchema = z
  .object({
    status: z.enum(["applied", "duplicate", "conflict"]),
    kind: z.string(),
    schema_version: z.number().int().positive(),
    message: z.string().optional(),
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
