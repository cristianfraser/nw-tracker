import express from "express";
import {
  INGEST_API_PATH,
  INGEST_KINDS,
  assertUniqueIngestKinds,
  findIngestKind,
  ingestEnvelopeSchema,
  ingestRunCompletionSchema,
  type IngestErrorBody,
  type IngestKindDefinition,
  type IngestResult,
} from "nw-tracker-contracts";
import { ingestAuthMiddleware, type IngestAuthConfig } from "../ingestAuth.js";
import { INGEST_HANDLERS, type IngestHandler } from "../ingestHandlers.js";
import { completeIngestRun, ingestRunById, listRecentIngestRuns } from "../ingestRuns.js";
import { asyncHandler } from "./shared.js";

export interface IngestRoutesOptions {
  kinds?: readonly IngestKindDefinition[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handlers?: Readonly<Record<string, IngestHandler<any>>>;
  auth?: IngestAuthConfig;
}

/**
 * `POST /api/ingest/<kind>`: the one way outside data is written (docs/ingest-split-plan.md).
 * The envelope, the version and the payload are checked before a handler sees anything; a
 * refusal is a 4xx with an `IngestErrorBody`, a handler fault a 500 from the error
 * middleware. `GET /api/ingest/kinds` lists what is accepted, for a feeder to check.
 */
export function registerIngestRoutes(app: express.Express, options: IngestRoutesOptions = {}): void {
  const kinds = options.kinds ?? INGEST_KINDS;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers: Readonly<Record<string, IngestHandler<any>>> = options.handlers ?? INGEST_HANDLERS;
  assertUniqueIngestKinds(kinds);
  for (const k of kinds) {
    if (!handlers[k.kind]) throw new Error(`Ingest kind ${k.kind} has no server handler`);
  }
  for (const name of Object.keys(handlers)) {
    if (!findIngestKind(kinds, name)) throw new Error(`Ingest handler ${name} has no contract kind`);
  }

  const router = express.Router();
  router.use(ingestAuthMiddleware(options.auth));

  router.get("/kinds", (_req, res) => {
    res.json({
      kinds: kinds.map((k) => ({
        kind: k.kind,
        schema_version: k.schema_version,
        description: k.description,
      })),
    });
  });

  // The run protocol (Phase 2): recent runs, and the feeder's report when one is over.
  router.get("/runs", (_req, res) => {
    res.json({ runs: listRecentIngestRuns() });
  });

  router.post("/runs/:id/complete", (req, res) => {
    const refuse = (status: number, body: IngestErrorBody) => void res.status(status).json(body);
    const id = Number(req.params.id);
    const run = Number.isInteger(id) && id > 0 ? ingestRunById(id) : null;
    if (!run) {
      refuse(404, { error: "unknown_ingest_run", message: `No ingest run ${String(req.params.id)}` });
      return;
    }
    if (run.status !== "requested" && run.status !== "lost") {
      refuse(409, { error: "run_not_waiting", message: `Ingest run ${id} is ${run.status}, not waiting for a report` });
      return;
    }
    const completion = ingestRunCompletionSchema.safeParse(req.body);
    if (!completion.success) {
      refuse(400, { error: "invalid_run_report", message: "Not a run report.", issues: completion.error.issues });
      return;
    }
    const row = completeIngestRun(id, completion.data);
    console.log(
      `ingest-runs: ${row.kind} run ${row.id} ${row.status} (exit ${row.exit_code}, ${row.failed_steps ?? "?"} failed step(s))`
    );
    res.json({ run: row });
  });

  router.post(
    "/:kind",
    asyncHandler(async (req, res) => {
      const refuse = (status: number, body: IngestErrorBody) => void res.status(status).json(body);
      const name = String(req.params.kind);
      const kind = findIngestKind(kinds, name);
      const handler = handlers[name];
      if (!kind || !handler) {
        refuse(404, { error: "unknown_ingest_kind", message: `Unknown ingest kind: ${name}` });
        return;
      }
      const envelope = ingestEnvelopeSchema.safeParse(req.body);
      if (!envelope.success) {
        refuse(400, {
          error: "invalid_envelope",
          message: "The request body is not an ingest envelope.",
          issues: envelope.error.issues,
        });
        return;
      }
      if (envelope.data.schema_version !== kind.schema_version) {
        refuse(400, {
          error: "unsupported_schema_version",
          message: `${kind.kind} is at schema_version ${kind.schema_version}; got ${envelope.data.schema_version}.`,
        });
        return;
      }
      const payload = kind.payload.safeParse(envelope.data.payload);
      if (!payload.success) {
        refuse(400, {
          error: "invalid_payload",
          message: `The payload does not match ${kind.kind} v${kind.schema_version}.`,
          issues: payload.error.issues,
        });
        return;
      }
      const outcome = await handler.apply({
        kind,
        payload: payload.data,
        envelope: { ...envelope.data, payload: payload.data },
      });
      const result: IngestResult = {
        ...outcome,
        kind: kind.kind,
        schema_version: kind.schema_version,
      };
      res.json(result);
    })
  );

  app.use(INGEST_API_PATH, router);
}
