/**
 * The ingest service (docs/ingest-split-plan.md, Phase 2): an always-on local listener the
 * server asks to run the nightly bank run or the hourly e-mail poll. Runs as the LaunchAgent
 * `com.user.nw-tracker-ingest` in the GUI session — the Santander fetch needs a window server.
 *
 *   npm run service -w nw-tracker-ingest
 *
 * `INGEST_SERVICE_PORT` (default `DEFAULT_INGEST_SERVICE_PORT`); `SERVER_URL` / `INGEST_TOKEN` as for every ingest command.
 * The run gates (`runner/runGates.ts`: `INGEST_RUN_DRY`, the `NW_TRACKER_*_APPLY` switches) are read once, here.
 */
import { DEFAULT_INGEST_SERVICE_PORT } from "nw-tracker-contracts";
import { log } from "../log.js";
import { envValue, ingestClient } from "../serverApi.js";
import { createFeederServer, reportWithRetry } from "./feederServer.js";
import { readSantanderState, runRequestedRun } from "../runner/runRequest.js";
import { readLiderState } from "../runner/liderState.js";
import { PARSE_FORMATS } from "../parse/formats.js";
import { readRunGates, RUN_GATE_VARS } from "../runner/runGates.js";
import { parsePort } from "../numberArgs.js";

// A mistyped port or gate stops the service here, naming the variable (the LaunchAgent's log shows it).
const port = parsePort("INGEST_SERVICE_PORT", process.env.INGEST_SERVICE_PORT, DEFAULT_INGEST_SERVICE_PORT);
const gates = readRunGates();
const client = ingestClient();

const { server } = createFeederServer({
  run: (request) => runRequestedRun(request, { gates }),
  report: (runId, completion) => reportWithRetry((id, c) => client.completeRun(id, c), runId, completion, log),
  heartbeat: (jobId) => client.heartbeatJob(jobId),
  santanderState: readSantanderState,
  liderState: () => readLiderState(),
  log,
  token: envValue("INGEST_TOKEN") ?? null,
  parse: PARSE_FORMATS,
});

server.listen(port, "127.0.0.1", () => {
  const on = (Object.keys(RUN_GATE_VARS) as (keyof typeof RUN_GATE_VARS)[]).filter((g) => gates[g]).map((g) => RUN_GATE_VARS[g]);
  log(`ingest service listening on 127.0.0.1:${port}; gates on: ${on.length > 0 ? on.join(", ") : "none"}`);
});
