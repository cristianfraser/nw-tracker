import express from "express";
import { type IngestErrorBody } from "nw-tracker-contracts";
import { ingestAuthMiddleware, type IngestAuthConfig } from "../ingestAuth.js";
import { heartbeatJob, jobById } from "../jobQueue.js";

/**
 * The job queue's worker endpoints (docs/job-queue-plan.md), under `/api/jobs` with the ingest
 * access rules (local connections, optional bearer token, never the demo): the workers are the
 * ingest service and the deploy agent, on this machine.
 */
export function registerJobRoutes(app: express.Express, options: { auth?: IngestAuthConfig } = {}): void {
  const router = express.Router();
  router.use(ingestAuthMiddleware(options.auth));
  const refuse = (res: express.Response, status: number, body: IngestErrorBody) => void res.status(status).json(body);

  router.post("/:id/heartbeat", (req, res) => {
    const id = Number(req.params.id);
    const job = Number.isInteger(id) && id > 0 ? jobById(id) : null;
    if (!job) return refuse(res, 404, { error: "unknown_job", message: `No job ${String(req.params.id)}` });
    if (!heartbeatJob(id, new Date())) return refuse(res, 409, { error: "job_not_running", message: `Job ${id} is ${job.status}` });
    res.json({ ok: true });
  });

  app.use("/api/jobs", router);
}
