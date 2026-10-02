import cors from "cors";
import express from "express";
import { httpRequestLogMiddleware } from "./httpRequestLog.js";
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
import { bootstrapDemoModeIfEnabled, demoModeEnabled } from "./demoMode.js";
import { demoVisitLogMiddleware, registerDemoAnalyticsRoutes } from "./demoAnalytics.js";
import { applyBackgroundJobsEnvDefaults } from "./backgroundJobsEnv.js";
import { registerClientDistStatic, serveClientDistEnabled } from "./staticClientDist.js";
import { startDashboardCacheWarmer } from "./dashboardCacheWarmer.js";
import { startDbBackupScheduler } from "./dbBackupScheduler.js";
import { registerMetaRoutes } from "./routes/meta.js";
import { registerAccountsRoutes } from "./routes/accounts.js";
import { registerMortgageRoutes } from "./routes/mortgage.js";
import { registerCreditCardRoutes } from "./routes/creditCard.js";
import { registerMovementsRoutes } from "./routes/movements.js";
import { registerMovementMirrorsRoutes } from "./routes/movementMirrors.js";
import { registerGroceriesRoutes } from "./routes/groceries.js";
import { registerExportXlsxRoutes } from "./routes/exportXlsx.js";
import { registerProjectionsRoutes } from "./routes/projections.js";
import { registerTaxReturnRoutes } from "./routes/taxReturn.js";
import { registerWealthPercentileRoutes } from "./routes/wealthPercentile.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerMarketRoutes } from "./routes/market.js";
import { registerFlowsRoutes } from "./routes/flows.js";
import { registerSyncRoutes } from "./routes/sync.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { startIngestRunScheduler } from "./ingestRunScheduler.js";

seedNavTree();

loadRootDotenv();
bootstrapDemoModeIfEnabled();
applyBackgroundJobsEnvDefaults();
ensureAccountSyncSourcesSeeded();

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const HOST = resolveBindHost();


/** Safety net for rejections outside routes (schedulers catch their own; this logs stragglers). */
process.on("unhandledRejection", (reason) => {
  console.error(
    "[process] unhandled rejection:",
    reason instanceof Error ? (reason.stack ?? reason.message) : reason
  );
});

app.use(cors({ origin: resolveCorsOrigins() }));
app.use(httpRequestLogMiddleware);
if (demoModeEnabled()) {
  // Render terminates TLS: without this every visitor's req.ip is the proxy's, so the
  // analytics visitor hash would collapse to a single id.
  app.set("trust proxy", 1);
  app.use(demoReadOnlyMiddleware());
  app.use(demoVisitLogMiddleware());
  console.log("demo: /api is read-only, anonymous visit analytics enabled (DEMO_MODE=1)");
}
const jsonBody = express.json({ limit: "2mb" });
// An ingest payload can carry a whole document set (every parsed card statement is ~4 MB as
// columns); the ingest routes take local connections only (`ingestAuth.ts`).
const ingestJsonBody = express.json({ limit: "32mb" });
app.use((req, res, next) => (req.path.startsWith("/api/ingest/") ? ingestJsonBody : jsonBody)(req, res, next));

/** Route registration order preserves the original monolithic file's order. */
if (demoModeEnabled()) registerDemoAnalyticsRoutes(app);
registerMetaRoutes(app);
registerAccountsRoutes(app);
registerMortgageRoutes(app);
registerCreditCardRoutes(app);
registerMovementsRoutes(app);
registerMovementMirrorsRoutes(app);
registerGroceriesRoutes(app);
registerExportXlsxRoutes(app);
registerProjectionsRoutes(app);
registerTaxReturnRoutes(app);
registerWealthPercentileRoutes(app);
registerDashboardRoutes(app);
registerMarketRoutes(app);
registerFlowsRoutes(app);
registerSyncRoutes(app);
registerIngestRoutes(app);

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
    res.status(500).json({ error: msg });
  }
);

app.listen(PORT, HOST, () => {
  console.log(`nw-tracker API http://${HOST}:${PORT}`);
  startGlobalSyncScheduler();
  startLiveMarketQuotesScheduler();
  startDbBackupScheduler();
  startDashboardCacheWarmer();
  startIngestRunScheduler();
});

