import http from "node:http";
import {
  ingestAccessRefusal,
  FEEDER_PARSE_FORMATS,
  FEEDER_PARSE_PATH,
  FEEDER_RUNS_PATH,
  JOB_HEARTBEAT_INTERVAL_MS,
  feederParseRequestSchema,
  ingestRunRequestSchema,
  type FeederParseFormat,
  type FeederParseResult,
  type IngestRunCompletion,
  type IngestRunRequest,
  type LiderState,
  type SantanderState,
} from "nw-tracker-contracts";

/**
 * The ingest service's own HTTP side of the run protocol (docs/ingest-split-plan.md, Phase 2):
 * `POST /runs` takes one run at a time — 202 at once, the run in the background, its report
 * sent to the server when it ends — and `GET /health` says what is running. Local connections
 * only; `token` (optional, the same `INGEST_TOKEN` the server has) adds a bearer check.
 */

export type FeederDeps = {
  run: (request: IngestRunRequest) => Promise<IngestRunCompletion>;
  report: (runId: number, completion: IngestRunCompletion) => Promise<void>;
  /** Tell the server the run's queue job is alive (docs/job-queue-plan.md); a failure is logged, never fatal. */
  heartbeat?: (jobId: number) => Promise<void>;
  /** How often to heartbeat (default `JOB_HEARTBEAT_INTERVAL_MS`). */
  heartbeatMs?: number;
  /** The bank facts every report carries, also when the run could not start. */
  santanderState: () => SantanderState;
  /** The Lider BCI facts for a report written here (a run that could not start). */
  liderState: () => LiderState;
  log: (message: string) => void;
  token?: string | null;
  /** Upload formats (`POST /parse/<format>`); `NotThisFormatError` from one is a 422 `not_this_format`. */
  parse?: Partial<Record<FeederParseFormat, (content: Buffer, filename: string) => FeederParseResult | Promise<FeederParseResult>>>;
};

type Running = { run_id: number | null; kind: string; started_at: string };

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

export function createFeederServer(deps: FeederDeps): { server: http.Server; current: () => Running | null; idle: () => Promise<void> } {
  let current: Running | null = null;
  let finished: Promise<void> = Promise.resolve();
  // Run ids this process has run. The server repeats a request whose answer it missed; a finished
  // run must never start again (2026-10-02: run 50 ran twice, the second time into the bank's
  // 30-minute guard).
  const ran = new Set<number>();

  /** Heartbeat the run's job until `stop` is called; the server writes a silent job off as lost. */
  function heartbeatWhileRunning(request: IngestRunRequest): () => void {
    const jobId = request.job_id;
    if (jobId == null || !deps.heartbeat) return () => {};
    const beat = deps.heartbeat;
    const timer = setInterval(() => {
      beat(jobId).catch((err) => deps.log(`run ${request.run_id}: heartbeat for job ${jobId} failed — ${err instanceof Error ? err.message : String(err)}`));
    }, deps.heartbeatMs ?? JOB_HEARTBEAT_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async function execute(request: IngestRunRequest): Promise<void> {
    let completion: IngestRunCompletion;
    const stopHeartbeat = heartbeatWhileRunning(request);
    try {
      try {
        completion = await deps.run(request);
      } catch (err) {
        const now = new Date().toISOString();
        deps.log(`run ${request.run_id} could not start: ${err instanceof Error ? err.message : String(err)}`);
        // May throw too (an unreadable marker): then no report goes out, the job's lease runs out
        // and the server records the run as lost — but this service stays free for the next run.
        completion = {
          started_at: current?.started_at ?? now,
          finished_at: now,
          exit_code: 127,
          steps: null,
          dry_run: false,
          activity: false,
          santander: null,
          santander_state: deps.santanderState(),
          lider: null,
          lider_state: deps.liderState(),
        };
      }
    } finally {
      stopHeartbeat();
      // Whatever failed above, the run is over: a `current` left set answers every later request
      // «busy» until the service is restarted.
      current = null;
    }
    deps.log(`run ${request.run_id} (${request.kind}) finished — exit ${completion.exit_code}`);
    await deps.report(request.run_id, completion);
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const refusal = ingestAccessRefusal({
        remoteAddress: req.socket.remoteAddress,
        authorization: req.headers.authorization,
        token: deps.token ?? null,
        allowRemote: false,
      });
      if (refusal) return send(res, refusal.status, { error: refusal.reason === "remote" ? "local connections only" : "token" });
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, running: current });
      if (req.method === "POST" && url.pathname.startsWith(`${FEEDER_PARSE_PATH}/`)) {
        const format = decodeURIComponent(url.pathname.slice(FEEDER_PARSE_PATH.length + 1));
        const parser = (FEEDER_PARSE_FORMATS as readonly string[]).includes(format)
          ? deps.parse?.[format as FeederParseFormat]
          : undefined;
        if (!parser) return send(res, 404, { error: "unknown format", format });
        let content: Buffer;
        let filename: string;
        try {
          const body = feederParseRequestSchema.parse(await readJson(req, 40 * 1024 * 1024));
          content = Buffer.from(body.content_base64, "base64");
          filename = body.filename;
        } catch (err) {
          return send(res, 400, { error: "invalid parse request", message: err instanceof Error ? err.message : String(err) });
        }
        try {
          return send(res, 200, await parser(content, filename));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const notThis = err instanceof Error && err.name === "NotThisFormatError";
          deps.log(`parse ${format} ${filename}: ${notThis ? "not this format" : "unreadable"} — ${message}`);
          return send(res, 422, { error: notThis ? "not_this_format" : "unreadable", message });
        }
      }
      if (req.method !== "POST" || url.pathname !== FEEDER_RUNS_PATH) return send(res, 404, { error: "not found" });
      let request: IngestRunRequest;
      try {
        request = ingestRunRequestSchema.parse(await readJson(req));
      } catch (err) {
        return send(res, 400, { error: "invalid run request", message: err instanceof Error ? err.message : String(err) });
      }
      if (current?.run_id === request.run_id) return send(res, 202, { accepted: true, run_id: request.run_id });
      if (ran.has(request.run_id)) return send(res, 409, { error: "already_ran", run_id: request.run_id });
      if (current) return send(res, 409, { error: "busy", running: current });
      current = { run_id: request.run_id, kind: request.kind, started_at: new Date().toISOString() };
      ran.add(request.run_id);
      deps.log(`run ${request.run_id} (${request.kind}) accepted — ${request.reason}`);
      // Answer first: the run's synchronous start must not hold the server's request past its timeout.
      send(res, 202, { accepted: true, run_id: request.run_id });
      finished = new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => execute(request))
        .catch((err) => deps.log(`run ${request.run_id}: ${err instanceof Error ? err.message : String(err)}`));
    })().catch((err) => send(res, 500, { error: err instanceof Error ? err.message : String(err) }));
  });

  return { server, current: () => current, idle: () => finished };
}

/**
 * Send a run's report, retrying while the server is down (a restart mid-run): up to ~15 min, then
 * give up — the server writes the run off as lost, and the runner's own app message stands.
 */
export async function reportWithRetry(
  send: (runId: number, completion: IngestRunCompletion) => Promise<void>,
  runId: number,
  completion: IngestRunCompletion,
  log: (message: string) => void,
  delaysMs: readonly number[] = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 300_000]
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await send(runId, completion);
      return;
    } catch (err) {
      const delay = delaysMs[attempt];
      const message = err instanceof Error ? err.message : String(err);
      if (delay == null) {
        log(`run ${runId}: report not delivered, giving up — ${message}`);
        return;
      }
      log(`run ${runId}: report not delivered (${message}); retrying in ${delay / 1000} s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
