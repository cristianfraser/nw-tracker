import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import {
  FEEDER_RUNS_PATH,
  ingestRunRequestSchema,
  type IngestRunCompletion,
  type IngestRunRequest,
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
  /** A runner this service did not start (by hand, or a LaunchAgent still installed). */
  runningOutside: () => boolean;
  /** The bank facts every report carries, also when the run could not start. */
  santanderState: () => SantanderState;
  log: (message: string) => void;
  token?: string | null;
};

type Running = { run_id: number | null; kind: string; started_at: string };

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function tokenOk(header: string | undefined, token: string): boolean {
  const given = /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1]?.trim() ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

export function createFeederServer(deps: FeederDeps): { server: http.Server; current: () => Running | null; idle: () => Promise<void> } {
  let current: Running | null = null;
  let finished: Promise<void> = Promise.resolve();

  async function execute(request: IngestRunRequest): Promise<void> {
    let completion: IngestRunCompletion;
    try {
      completion = await deps.run(request);
    } catch (err) {
      const now = new Date().toISOString();
      deps.log(`run ${request.run_id} could not start: ${err instanceof Error ? err.message : String(err)}`);
      completion = {
        started_at: current?.started_at ?? now,
        finished_at: now,
        exit_code: 127,
        steps: null,
        dry_run: false,
        activity: false,
        santander: null,
        santander_state: deps.santanderState(),
      };
    }
    current = null;
    deps.log(`run ${request.run_id} (${request.kind}) finished — exit ${completion.exit_code}`);
    await deps.report(request.run_id, completion);
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return send(res, 403, { error: "local connections only" });
      if (deps.token && !tokenOk(req.headers.authorization, deps.token)) return send(res, 401, { error: "token" });
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, running: current });
      if (req.method !== "POST" || url.pathname !== FEEDER_RUNS_PATH) return send(res, 404, { error: "not found" });
      let request: IngestRunRequest;
      try {
        request = ingestRunRequestSchema.parse(await readJson(req));
      } catch (err) {
        return send(res, 400, { error: "invalid run request", message: err instanceof Error ? err.message : String(err) });
      }
      if (current) return send(res, 409, { error: "busy", running: current });
      if (deps.runningOutside()) {
        return send(res, 409, { error: "busy", running: { run_id: null, kind: "outside", started_at: new Date().toISOString() } });
      }
      current = { run_id: request.run_id, kind: request.kind, started_at: new Date().toISOString() };
      deps.log(`run ${request.run_id} (${request.kind}) accepted — ${request.reason}`);
      finished = execute(request).catch((err) =>
        deps.log(`run ${request.run_id}: ${err instanceof Error ? err.message : String(err)}`)
      );
      send(res, 202, { accepted: true, run_id: request.run_id });
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
