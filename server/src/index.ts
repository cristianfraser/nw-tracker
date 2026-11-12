import cors from "cors";
import express from "express";
import { httpRequestLogMiddleware } from "./httpRequestLog.js";
import { apiInFlightMiddleware } from "./apiRequestsInFlight.js";
import { seedNavTree } from "./seedNavTree.js";
import { startGlobalSyncScheduler } from "./globalSyncScheduler.js";
import { startLiveMarketQuotesScheduler } from "./liveMarketQuotesScheduler.js";
import { loadRootDotenv } from "./rootDotenv.js";
import { ensureAccountSyncSourcesSeeded } from "./accountSyncSources.js";
import {
  demoReadOnlyMiddleware,
  resolveBindHost,
  resolveCorsOrigins,
} from "./httpSecurity.js";
import { bootstrapDemoModeIfEnabled } from "./demoMode.js";
import { describeServerConfig, initServerConfig } from "./config.js";
import { requestContext } from "./requestContext.js";
import { demoOwnerCookieMiddleware, demoVisitLogMiddleware } from "./demoAnalytics.js";
import { demoWriteQuotaMiddleware, startDemoResetScheduler } from "./demoWritable.js";
import { registerClientDistStatic, serveClientDistEnabled } from "./staticClientDist.js";
import { startDashboardCacheWarmer } from "./dashboardCacheWarmer.js";
import { ensureCacheFresh } from "./cacheRegistry.js";
import { startDbBackupScheduler } from "./dbBackupScheduler.js";
import { startDemoMarketPublishJob } from "./demoMarketPublishJob.js";
import { registerMetaRoutes } from "./routes/meta.js";
import { registerAccountsRoutes } from "./routes/accounts.js";
import { registerMortgageRoutes } from "./routes/mortgage.js";
import { registerCreditCardRoutes } from "./routes/creditCard.js";
import { registerMovementsRoutes } from "./routes/movements.js";
import { registerMovementMirrorsRoutes } from "./routes/movementMirrors.js";
import { registerGroceriesRoutes } from "./routes/groceries.js";
import { registerExportXlsxRoutes } from "./routes/exportXlsx.js";
import { registerProjectionsRoutes } from "./routes/projections.js";
import { registerBenchmarkRoutes } from "./routes/benchmarks.js";
import { registerTaxReturnRoutes } from "./routes/taxReturn.js";
import { registerTaxResidencyRoutes } from "./routes/taxResidency.js";
import { registerWealthPercentileRoutes } from "./routes/wealthPercentile.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerMarketRoutes } from "./routes/market.js";
import { registerFlowsRoutes } from "./routes/flows.js";
import { registerSyncRoutes } from "./routes/sync.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { startIngestRunScheduler } from "./ingestRunScheduler.js";
import { startJobQueueExecutor } from "./jobQueueExecutor.js";
import { syncCardToCardPaymentTransfersAtBoot } from "./cardToCardPayments.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { startUsageLogFlusher, usageLogEnabled, usageLogMiddleware } from "./usageLog.js";
import { jsonResponseMiddleware } from "./jsonResponse.js";
import { LIVE_INPUTS_HEADER, liveInputsMiddleware } from "./liveInputsHeader.js";
import { DisplayUnitRequestError } from "./displayUnits.js";

seedNavTree();

loadRootDotenv();
// Every flag is parsed once here, with the demo and background-jobs defaults in one declared order.
const config = initServerConfig();
console.log(describeServerConfig(config));
await bootstrapDemoModeIfEnabled();
ensureAccountSyncSourcesSeeded();
syncCardToCardPaymentTransfersAtBoot();

const app = express();
const PORT = config.port;
const HOST = resolveBindHost();


/** Safety net for rejections outside routes (schedulers catch their own; this logs stragglers). */
process.on("unhandledRejection", (reason) => {
  console.error(
    "[process] unhandled rejection:",
    reason instanceof Error ? (reason.stack ?? reason.message) : reason
  );
});

app.use(cors({ origin: resolveCorsOrigins(), exposedHeaders: [LIVE_INPUTS_HEADER] }));
// The cache warmer steps aside while a request is in flight (apiRequestsInFlight.ts).
app.use(apiInFlightMiddleware());
app.use(httpRequestLogMiddleware);
if (usageLogEnabled()) app.use(usageLogMiddleware());
// `res.json` on /api: serialized once per cached payload, gzip/brotli above 1 KB (jsonResponse.ts).
app.use(jsonResponseMiddleware());
app.use(liveInputsMiddleware());
if (config.profile.readOnlyApi) {
  // Render terminates TLS: without this every visitor's req.ip is the proxy's, so the
  // analytics visitor hash would collapse to a single id.
  app.set("trust proxy", 1);
  app.use(demoReadOnlyMiddleware());
  app.use(demoWriteQuotaMiddleware());
  app.use(demoOwnerCookieMiddleware());
  app.use(demoVisitLogMiddleware());
  console.log(
    "demo: /api is read-only but for a few counted edits, reset to the generated state when idle and nightly; " +
      "anonymous visit analytics + usage log in DEMO_ANALYTICS_DB (DEMO_MODE=1)"
  );
}
const jsonBody = express.json({ limit: "2mb" });
// An ingest payload can carry a whole document set (every parsed card statement is ~4 MB as
// columns); the ingest routes take local connections only (`ingestAuth.ts`).
const ingestJsonBody = express.json({ limit: "32mb" });
app.use((req, res, next) => (req.path.startsWith("/api/ingest/") ? ingestJsonBody : jsonBody)(req, res, next));
// Once a request that can write has answered (a person's write, or the ingest service and the
// deploy agent), apply the change log: the cache registry drops the families that read what the
// request wrote and the warmer schedules a rebuild. A heartbeat, a claim or a run report writes
// only the queue and the run log, which the log does not cover, so it drops nothing.
app.use((req, res, next) => {
  const { kind } = requestContext(req);
  if (kind === "api-write" || kind === "machine") res.on("finish", ensureCacheFresh);
  next();
});

/** Route registration order preserves the original monolithic file's order. */
registerMetaRoutes(app);
registerAccountsRoutes(app);
registerMortgageRoutes(app);
registerCreditCardRoutes(app);
registerMovementsRoutes(app);
registerMovementMirrorsRoutes(app);
registerGroceriesRoutes(app);
registerExportXlsxRoutes(app);
registerProjectionsRoutes(app);
registerBenchmarkRoutes(app);
registerTaxReturnRoutes(app);
registerTaxResidencyRoutes(app);
registerWealthPercentileRoutes(app);
registerDashboardRoutes(app);
registerMarketRoutes(app);
registerFlowsRoutes(app);
registerSyncRoutes(app);
registerIngestRoutes(app);
registerJobRoutes(app);
registerUsageRoutes(app);

if (serveClientDistEnabled()) {
  registerClientDistStatic(app);
  console.log("static: serving client/dist with SPA fallback (SERVE_CLIENT_DIST=1)");
}

app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[api] route error: ${err instanceof Error ? (err.stack ?? msg) : msg}`
    );
    if (res.headersSent) return;
    if (err instanceof DisplayUnitRequestError) {
      res.status(err.status).json({ error: msg });
      return;
    }
    res.status(500).json({ error: msg });
  }
);

app.listen(PORT, HOST, () => {
  console.log(`nw-tracker API http://${HOST}:${PORT}`);
  startGlobalSyncScheduler();
  startDemoResetScheduler();
  startLiveMarketQuotesScheduler();
  startDbBackupScheduler();
  startDemoMarketPublishJob();
  startDashboardCacheWarmer();
  startIngestRunScheduler();
  startJobQueueExecutor();
  if (usageLogEnabled()) startUsageLogFlusher();
});

