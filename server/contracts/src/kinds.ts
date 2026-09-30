import type { z } from "zod";
import type { IngestKindDefinition } from "./defineKind.js";
import { cardUnbilledMovementsKind } from "./kinds/cardUnbilledMovements.js";

export { defineIngestKind, type IngestKindDefinition } from "./defineKind.js";

/** Every kind the server accepts. */
export const INGEST_KINDS = [cardUnbilledMovementsKind] as const satisfies readonly IngestKindDefinition[];

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
