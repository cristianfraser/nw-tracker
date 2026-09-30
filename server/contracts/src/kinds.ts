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
  readonly payload: S;
}

export function defineIngestKind<const K extends string, S extends z.ZodType>(
  def: IngestKindDefinition<K, S>
): IngestKindDefinition<K, S> {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(def.kind)) {
    throw new Error(`Invalid ingest kind name: ${JSON.stringify(def.kind)}`);
  }
  if (!Number.isInteger(def.schema_version) || def.schema_version < 1) {
    throw new Error(`Invalid schema_version for ${def.kind}: ${def.schema_version}`);
  }
  return def;
}

/**
 * Every kind the server accepts. Empty until the first source moves (the Santander card feed,
 * see docs/ingest-split-plan.md, Phase 1).
 */
export const INGEST_KINDS = [] as const satisfies readonly IngestKindDefinition[];

export type IngestKind = (typeof INGEST_KINDS)[number];
export type IngestKindName = IngestKind["kind"];
export type IngestPayloadOf<K extends IngestKindName> = z.infer<
  Extract<IngestKind, { kind: K }>["payload"]
>;

/** Looks a kind up by name among `kinds`; null when the name is unknown. */
export function findIngestKind(
  kinds: readonly IngestKindDefinition[],
  name: string
): IngestKindDefinition | null {
  return kinds.find((k) => k.kind === name) ?? null;
}

/** Throws when two definitions share a name — a registry must be unambiguous. */
export function assertUniqueIngestKinds(kinds: readonly IngestKindDefinition[]): void {
  const seen = new Set<string>();
  for (const k of kinds) {
    if (seen.has(k.kind)) throw new Error(`Duplicate ingest kind: ${k.kind}`);
    seen.add(k.kind);
  }
}
