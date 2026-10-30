import express from "express";
import {
  jobClaimRequestSchema,
  jobCompleteRequestSchema,
  jobEnqueueRequestSchema,
  type IngestErrorBody,
} from "nw-tracker-contracts";
import { ingestAuthMiddleware, type IngestAuthConfig } from "../ingestAuth.js";
import { claimNextJob, completeClaimedJob, enqueueDeploy } from "../jobClaims.js";
import { heartbeatJob, jobById } from "../jobQueue.js";

/**
 * The job queue's worker endpoints (docs/job-queue-plan.md, contract `jobs.ts`), under
 * `/api/jobs` with the ingest access rules (local connections, optional bearer token, never the
 * demo): the workers are the ingest service and the deploy agent, on this machine.
 */
export function registerJobRoutes(app: express.Express, options: { auth?: IngestAuthConfig } = {}): void {
  const router = express.Router();
  router.use(ingestAuthMiddleware(options.auth));
  const refuse = (res: express.Response, status: number, body: IngestErrorBody) => void res.status(status).json(body);

  router.post("/", (req, res) => {
    const request = jobEnqueueRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      return refuse(res, 400, { error: "invalid_job_request", message: "Not a job request.", issues: request.error.issues });
    }
    const { job, coalesced } = enqueueDeploy(request.data, new Date());
    res.json({ job, coalesced });
  });

  router.post("/claim", (req, res) => {
    const request = jobClaimRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      return refuse(res, 400, { error: "invalid_job_request", message: "Not a claim request.", issues: request.error.issues });
    }
    res.json(claimNextJob(request.data.kind, request.data.worker, new Date()));
  });

  const jobParam = (req: express.Request): number | null => {
    const id = Number(req.params.id);
    return Number.isInteger(id) && id > 0 ? id : null;
  };

  router.post("/:id/heartbeat", (req, res) => {
    const id = jobParam(req);
    const job = id ? jobById(id) : null;
    if (!id || !job) return refuse(res, 404, { error: "unknown_job", message: `No job ${String(req.params.id)}` });
    if (!heartbeatJob(id, new Date())) return refuse(res, 409, { error: "job_not_running", message: `Job ${id} is ${job.status}` });
    res.json({ ok: true });
  });

  router.post("/:id/complete", (req, res) => {
    const id = jobParam(req);
    const job = id ? jobById(id) : null;
    if (!id || !job) return refuse(res, 404, { error: "unknown_job", message: `No job ${String(req.params.id)}` });
    const request = jobCompleteRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      return refuse(res, 400, { error: "invalid_job_request", message: "Not a job report.", issues: request.error.issues });
    }
    if (job.status !== "running" && job.status !== "lost") {
      return refuse(res, 409, { error: "job_not_running", message: `Job ${id} is ${job.status}, not waiting for a report` });
    }
    try {
      res.json({ job: completeClaimedJob(id, request.data, new Date()) });
    } catch (err) {
      refuse(res, 409, { error: "invalid_job_request", message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.use("/api/jobs", router);
}
