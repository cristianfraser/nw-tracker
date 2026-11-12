import express from "express";
import {
  INGEST_API_PATH,
  INGEST_KINDS,
  assertUniqueIngestKinds,
  findIngestKind,
  ingestEnvelopeSchema,
  ingestRunCompletionSchema,
  ingestTaskRequestSchema,
  INGEST_TASK_NAMES,
  CC_MANUAL_PAYMENT_TASK,
  ccManualPaymentRequestSchema,
  type IngestErrorBody,
  type IngestTaskName,
  type IngestKindDefinition,
} from "nw-tracker-contracts";
import { ingestAuthMiddleware, type IngestAuthConfig } from "../ingestAuth.js";
import { INGEST_HANDLERS, type IngestHandler } from "../ingestHandlers.js";
import { IngestRefusal, receiveIngestDocument } from "../ingestReceiver.js";
import { completeIngestRun, ingestRunById, listRecentIngestRuns } from "../ingestRuns.js";
import { runIngestTask } from "../ingestTasks.js";
import { recordManualCardPayment } from "../ccManualPayments.js";
import { pesosOrDollars } from "../ingestCurrencies.js";

export interface IngestRoutesOptions {
  kinds?: readonly IngestKindDefinition[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handlers?: Readonly<Record<string, IngestHandler<any>>>;
  auth?: IngestAuthConfig;
}

/**
 * `POST /api/ingest/<kind>`: the one way outside data is written (docs/ingest-split-plan.md).
 * The envelope, the version and the payload are checked before a handler sees anything; a
 * refusal is a 4xx with an `IngestErrorBody`. The receiver (`ingestReceiver.ts`) applies the
 * document — store-once, conflict and dry run are its rules — and a handler fault is a 500
 * from the error middleware. `GET /api/ingest/kinds` lists what is accepted, for a feeder to check.
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
        ref: k.ref,
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
    // not_started: the service took a request whose answer was lost, and its job went back to the queue.
    if (run.status !== "requested" && run.status !== "lost" && run.status !== "not_started") {
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

  // Server tasks a feeder run asks for (Phase 4): the run's steps that work on the server's data.
  // A card payment entered by hand (ccManualPayments.ts): its own typed body, so before `:task`.
  router.post(`/tasks/${CC_MANUAL_PAYMENT_TASK}`, (req, res) => {
    const request = ccManualPaymentRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      res.status(400).json({ error: "invalid_task_request", message: "Not a manual card payment.", issues: request.error.issues } satisfies IngestErrorBody);
      return;
    }
    let result: ReturnType<typeof recordManualCardPayment>;
    try {
      result = recordManualCardPayment({ ...request.data, currency: pesosOrDollars(request.data.currency, CC_MANUAL_PAYMENT_TASK) });
    } catch (err) {
      if (err instanceof IngestRefusal) {
        res.status(422).json({ error: err.code, message: err.message } satisfies IngestErrorBody);
        return;
      }
      res.status(422).json({ error: "task_refused", message: err instanceof Error ? err.message : String(err) } satisfies IngestErrorBody);
      return;
    }
    console.log(`ingest-tasks: ${CC_MANUAL_PAYMENT_TASK} — ${result.detail}`);
    res.json(result);
  });

  router.post("/tasks/:task", (req, res) => {
    const task = String(req.params.task);
    if (!(INGEST_TASK_NAMES as readonly string[]).includes(task)) {
      res.status(404).json({ error: "unknown_ingest_task", message: `Unknown ingest task: ${task}` } satisfies IngestErrorBody);
      return;
    }
    const request = ingestTaskRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      res.status(400).json({ error: "invalid_task_request", message: "Not a task request.", issues: request.error.issues } satisfies IngestErrorBody);
      return;
    }
    const result = runIngestTask(task as IngestTaskName, request.data);
    console.log(`ingest-tasks: ${task}${request.data.dry_run ? " (dry run)" : ""} — ${result.ok ? "ok" : "FAILED"}`);
    res.json(result);
  });

  // Synchronous: a handler fault reaches the error middleware as a thrown error.
  router.post("/:kind", (req, res) => {
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
    try {
      res.json(receiveIngestDocument(kind, { ...envelope.data, payload: payload.data }, (ctx) => handler.apply(ctx)));
    } catch (err) {
      if (!(err instanceof IngestRefusal)) throw err;
      refuse(422, { error: err.code, message: err.message });
    }
  });

  app.use(INGEST_API_PATH, router);
}
