import type { z } from "zod";

/**
 * One kind of document the server accepts. A kind describes what the data MEANS (a card's
 * open-cycle listing, a card statement, a brokerage event), never which bank printed it:
 * bank-specific decoding happens in the feeder, so any feeder that can produce the payload
 * can feed the app. The server implements exactly one `schema_version` per kind; a change
 * that old payloads would not satisfy bumps it.
 */
export interface IngestKindDefinition<
  K extends string = string,
  S extends z.ZodType = z.ZodType,
> {
  readonly kind: K;
  readonly schema_version: number;
  readonly description: string;
  /**
   * What the envelope's `source.ref` names. `document`: one immutable document (a mail's message
   * id, a dated capture file, a file's sha256) — the server keeps ref + payload hash once applied,
   * answers a resend of the same payload `duplicate` (with the first answer's details) without
   * applying it again, and a different payload under the same ref `conflict`. `read`: a read the
   * feeder restates under the same ref (a fetch window, a file replaced in place, a whole staged
   * set sent every run) — every send is applied.
   */
  readonly ref: IngestRefMode;
  readonly payload: S;
}

export type IngestRefMode = "document" | "read";

export function defineIngestKind<const K extends string, S extends z.ZodType>(
  def: IngestKindDefinition<K, S>
): IngestKindDefinition<K, S> {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(def.kind)) {
    throw new Error(`Invalid ingest kind name: ${JSON.stringify(def.kind)}`);
  }
  if (!Number.isInteger(def.schema_version) || def.schema_version < 1) {
    throw new Error(`Invalid schema_version for ${def.kind}: ${def.schema_version}`);
  }
  if (def.ref !== "document" && def.ref !== "read") throw new Error(`Invalid ref mode for ${def.kind}: ${String(def.ref)}`);
  return def;
}
