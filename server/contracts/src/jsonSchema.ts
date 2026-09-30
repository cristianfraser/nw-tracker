import { z } from "zod";
import { ingestEnvelopeSchema, ingestErrorSchema, ingestResultSchema } from "./envelope.js";
import { INGEST_KINDS, type IngestKindDefinition } from "./kinds.js";

export interface IngestJsonSchemas {
  envelope: unknown;
  result: unknown;
  error: unknown;
  kinds: Record<string, { schema_version: number; description: string; payload: unknown }>;
}

/**
 * The contract as JSON Schema, for a feeder that is not written in TypeScript: the envelope
 * every request carries, the result and error bodies, and each kind's payload.
 */
export function ingestJsonSchemas(
  kinds: readonly IngestKindDefinition[] = INGEST_KINDS
): IngestJsonSchemas {
  const out: IngestJsonSchemas = {
    envelope: z.toJSONSchema(ingestEnvelopeSchema),
    result: z.toJSONSchema(ingestResultSchema),
    error: z.toJSONSchema(ingestErrorSchema),
    kinds: {},
  };
  for (const k of kinds) {
    out.kinds[k.kind] = {
      schema_version: k.schema_version,
      description: k.description,
      payload: z.toJSONSchema(k.payload),
    };
  }
  return out;
}
