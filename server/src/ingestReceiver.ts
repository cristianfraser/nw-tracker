/**
 * The one way an ingest document is received (`POST /api/ingest/<kind>`, docs/untangle-plan.md
 * F13): a handler applies a validated payload and reports `{details, retry}`; this module decides
 * the status. It owns three rules no handler repeats:
 *
 * - **Store once.** A `document` kind's `source.ref` + payload hash is kept in `ingest_documents`
 *   once applied with a final outcome: the same payload again is `duplicate` (the first answer's
 *   details, nothing run), another payload under the ref a `conflict`. A handler storing rows that
 *   a resend must state the same (`storeOnce`) reports a disagreement the same way.
 * - **Conflict.** A handler throws `IngestConflict`; everything it wrote is rolled back and the
 *   feeder gets `conflict` with a pointer per disagreement — never a 500.
 * - **Dry run.** The envelope's `dry_run` applies the document inside the same transaction and
 *   rolls it back: the report is what a real send would write. Process caches are bypassed
 *   inside a transaction (`dbInTransaction`), so nothing a dry run read outlives it.
 */
import { createHash } from "node:crypto";
import type {
  IngestConflictEntry,
  IngestErrorCode,
  IngestEnvelope,
  IngestKindDefinition,
  IngestResult,
} from "nw-tracker-contracts";
import { db } from "./db.js";

/** What a handler reports; the receiver turns it into the IngestResult. */
export type IngestHandlerResult = {
  details?: Record<string, unknown>;
  /** The outcome may change if the same document is sent again (default false). */
  retry?: boolean;
  message?: string;
};

export interface IngestApplyContext<P> {
  kind: IngestKindDefinition;
  /** The validated payload (the kind's schema output). */
  payload: P;
  envelope: IngestEnvelope<P>;
}

/**
 * The document disagrees with what the server holds: nothing is written. `details` reach the
 * feeder beside the pointers (a full report the human needs).
 */
export class IngestConflict extends Error {
  constructor(
    message: string,
    readonly conflicts: IngestConflictEntry[],
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "IngestConflict";
  }
}

/**
 * The document cannot be applied as it stands (a currency the server does not know, or one the
 * kind's handler cannot take yet): nothing is written and the route answers a 4xx with `code` —
 * the payload is refused like an invalid one, never a 500.
 */
export class IngestRefusal extends Error {
  constructor(
    readonly code: Extract<IngestErrorCode, "unknown_currency" | "unsupported_currency">,
    message: string
  ) {
    super(message);
    this.name = "IngestRefusal";
  }
}

/** Ends the transaction of a dry run after the handler reported. */
class DryRunRollback extends Error {
  constructor(readonly result: IngestHandlerResult) {
    super("dry run");
  }
}

class RolledBack<T> extends Error {
  constructor(readonly value: T) {
    super("rolled back");
  }
}

/**
 * Runs `fn` in a transaction and rolls it back, returning what it returned: a report of what a
 * write would do (the receiver's dry run, report-only scripts and tests).
 */
export function rolledBack<T>(fn: () => T): T {
  try {
    db.transaction(() => {
      throw new RolledBack(fn());
    })();
  } catch (err) {
    if (err instanceof RolledBack) return err.value as T;
    throw err;
  }
  throw new Error("unreachable");
}

export function ingestPayloadSha256(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

type StoredDocument = { payload_sha256: string; details_json: string | null; applied_at: string };

/**
 * Receives one validated document. Throws `IngestRefusal` (→ 422 from the route) when a handler
 * refuses the payload, and otherwise only on a server fault (→ 500 from the error middleware); a
 * conflict is an answer.
 */
export function receiveIngestDocument<P>(
  kind: IngestKindDefinition,
  envelope: IngestEnvelope<P>,
  apply: (ctx: IngestApplyContext<P>) => IngestHandlerResult
): IngestResult {
  const dryRun = envelope.dry_run;
  const ref = envelope.source.ref;
  const sha = ingestPayloadSha256(envelope.payload);
  const answer = (status: IngestResult["status"], r: IngestHandlerResult & { conflicts?: IngestConflictEntry[] }): IngestResult => ({
    status,
    kind: kind.kind,
    schema_version: kind.schema_version,
    retry: status === "conflict" ? false : (r.retry ?? false),
    dry_run: dryRun,
    ...(r.message != null ? { message: r.message } : {}),
    ...(r.conflicts ? { conflicts: r.conflicts } : {}),
    ...(r.details ? { details: r.details } : {}),
  });
  try {
    return db.transaction((): IngestResult => {
      if (kind.ref === "document") {
        const stored = db
          .prepare(`SELECT payload_sha256, details_json, applied_at FROM ingest_documents WHERE kind = ? AND source_ref = ?`)
          .get(kind.kind, ref) as StoredDocument | undefined;
        if (stored?.payload_sha256 === sha) {
          return answer("duplicate", {
            message: `${ref} was applied ${stored.applied_at}`,
            ...(stored.details_json ? { details: JSON.parse(stored.details_json) as Record<string, unknown> } : {}),
          });
        }
        if (stored) {
          throw new IngestConflict(`${ref} was applied ${stored.applied_at} with another payload`, [
            { at: `ingest_documents:${kind.kind}|${ref}`, fields: ["payload_sha256"], message: `stored ${stored.payload_sha256.slice(0, 12)}, received ${sha.slice(0, 12)}` },
          ]);
        }
      }
      const result = apply({ kind, payload: envelope.payload, envelope });
      if (dryRun) throw new DryRunRollback(result);
      if (kind.ref === "document" && !result.retry) {
        db.prepare(
          `INSERT INTO ingest_documents (kind, source_ref, payload_sha256, details_json, applied_at) VALUES (?, ?, ?, ?, ?)`
        ).run(kind.kind, ref, sha, result.details ? JSON.stringify(result.details) : null, new Date().toISOString());
      }
      return answer("applied", result);
    }).immediate();
  } catch (err) {
    if (err instanceof DryRunRollback) return answer("applied", err.result);
    if (err instanceof IngestConflict) {
      return answer("conflict", { message: err.message, conflicts: err.conflicts, ...(err.details ? { details: err.details } : {}) });
    }
    throw err;
  }
}

/** Two stored values agree: numbers by value (SQLite hands back 1 for true, 5 for 5.0), the rest strictly. */
function sameValue(a: unknown, b: unknown): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (typeof x === "number" || typeof y === "number") return x != null && y != null && Number(x) === Number(y);
  if (typeof x === "boolean" || typeof y === "boolean") return x != null && y != null && Number(x) === Number(y);
  return x === y;
}

/** The fields of `incoming` whose value differs from `stored`. */
export function differingFields(stored: Record<string, unknown>, incoming: Record<string, unknown>, fields?: readonly string[]): string[] {
  return (fields ?? Object.keys(incoming)).filter((f) => !sameValue(stored[f], incoming[f]));
}

/**
 * Stores rows a resend must state the same (a mail's notice, a bill, a receipt): a new key is
 * inserted, a stored one compared field by field. Every disagreement of the batch is collected and
 * thrown as one `IngestConflict`, so the receiver rolls the whole document back. `update` lets a
 * row fill what the stored one lacked (it returns the fields it filled; they never count as a
 * conflict).
 */
export function storeOnce<T>(
  items: readonly T[],
  spec: {
    table: string;
    /** The row's identity, for the conflict pointer (`<table>:<key>`). */
    key(item: T): string;
    /** The stored row as comparable fields, or undefined when the key is new. */
    load(item: T): Record<string, unknown> | undefined;
    /** The incoming row as the same fields. */
    row(item: T): Record<string, unknown>;
    insert(item: T): void;
    /** Fields a resend may fill on the stored row: written here and left out of the comparison. */
    fill?(stored: Record<string, unknown>, item: T): string[];
  }
): { received: number; added: number } {
  return db.transaction(() => {
    const conflicts: IngestConflictEntry[] = [];
    let added = 0;
    for (const item of items) {
      const stored = spec.load(item);
      if (!stored) {
        spec.insert(item);
        added++;
        continue;
      }
      const filled = new Set(spec.fill?.(stored, item) ?? []);
      const fields = differingFields(stored, spec.row(item)).filter((f) => !filled.has(f));
      if (fields.length > 0) {
        const at = `${spec.table}:${spec.key(item)}`;
        conflicts.push({ at, fields, message: `${at} was already stored with other ${fields.join(", ")}` });
      }
    }
    if (conflicts.length > 0) {
      throw new IngestConflict(
        conflicts.length === 1 ? conflicts[0]!.message : `${conflicts.length} rows were already stored with other content (first: ${conflicts[0]!.message})`,
        conflicts
      );
    }
    return { received: items.length, added };
  })();
}
