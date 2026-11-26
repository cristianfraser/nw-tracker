/** Request bodies of the import-sync panel's write routes (`server/src/routes/sync.ts`). */
import { z } from "zod";
import { INGEST_RUN_KINDS } from "../runs.js";

/** `POST /api/sync/force-stale`: a global sync source (which ones is the server's scheduler list). */
export const syncForceStaleSchema = z.object({ source: z.string().trim().default("") });
export type SyncForceStale = z.input<typeof syncForceStaleSchema>;

/** `POST /api/import-sync/ingest-runs`: run the hourly poll or the nightly now. */
export const manualIngestRunSchema = z.object({
  kind: z.enum(INGEST_RUN_KINDS, {
    error: (issue) => `Unknown ingest run kind: ${typeof issue.input === "string" && issue.input ? issue.input : "(none)"}`,
  }),
});
export type ManualIngestRun = z.input<typeof manualIngestRunSchema>;

/** `POST /api/import-sync/generic-unique-merchants`, `PATCH …/:id`: a merchant as printed (normalized by the server). */
export const genericUniqueMerchantSchema = z.object({ merchant: z.string({ error: "merchant required" }) });
export type GenericUniqueMerchant = z.input<typeof genericUniqueMerchantSchema>;
