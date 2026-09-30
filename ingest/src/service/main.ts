/**
 * The ingest service (docs/ingest-split-plan.md, Phase 2): an always-on local listener the
 * server asks to run the nightly bank run or the hourly e-mail poll. Runs as the LaunchAgent
 * `com.user.nw-tracker-ingest` in the GUI session — the Santander fetch needs a window server.
 *
 *   npm run service -w nw-tracker-ingest
 *
 * `INGEST_SERVICE_PORT` (default 3002); `SERVER_URL` / `INGEST_TOKEN` as for every ingest command.
 */
import { log } from "../log.js";
import { envValue, ingestClient } from "../serverApi.js";
import { createFeederServer, reportWithRetry } from "./feederServer.js";
import { readSantanderState, runRequestedRun } from "../runner/runRequest.js";
import { runnerScriptRunningOutside } from "./runnerScripts.js";

const port = Number(process.env.INGEST_SERVICE_PORT ?? 3002);
const client = ingestClient();

const { server } = createFeederServer({
  run: (request) => runRequestedRun(request),
  report: (runId, completion) => reportWithRetry((id, c) => client.completeRun(id, c), runId, completion, log),
  runningOutside: runnerScriptRunningOutside,
  santanderState: readSantanderState,
  log,
  token: envValue("INGEST_TOKEN") ?? null,
});

server.listen(port, "127.0.0.1", () => log(`ingest service listening on 127.0.0.1:${port}`));
