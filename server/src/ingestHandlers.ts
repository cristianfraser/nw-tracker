import type {
  IngestEnvelope,
  IngestKindDefinition,
  IngestKindName,
  IngestPayloadOf,
  IngestResult,
} from "nw-tracker-contracts";

/** What a handler reports; the route adds the kind and version to make the IngestResult. */
export type IngestApplyOutcome = Omit<IngestResult, "kind" | "schema_version">;

export interface IngestApplyContext<P> {
  kind: IngestKindDefinition;
  /** The validated payload (the kind's schema output). */
  payload: P;
  envelope: IngestEnvelope<P>;
}

/**
 * Applies one validated document to the ledger. Throws on a server fault (→ 500); returns
 * `conflict` when the document disagrees with what the server holds.
 */
export interface IngestHandler<P = unknown> {
  apply(ctx: IngestApplyContext<P>): Promise<IngestApplyOutcome> | IngestApplyOutcome;
}

/** One handler per contract kind — the type makes a kind without a handler a compile error. */
export type IngestHandlerMap = { [K in IngestKindName]: IngestHandler<IngestPayloadOf<K>> };

/** Empty until the first source moves (docs/ingest-split-plan.md, Phase 1). */
export const INGEST_HANDLERS: IngestHandlerMap = {};
