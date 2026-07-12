import cors from "cors";
import express from "express";
import { httpRequestLogMiddleware } from "./httpRequestLog.js";
import { seedNavTree } from "./seedNavTree.js";
import { startGlobalSyncScheduler } from "./globalSyncScheduler.js";
import { startLiveMarketQuotesScheduler } from "./liveMarketQuotesScheduler.js";
import { loadRootDotenv } from "./rootDotenv.js";
import { ensureAccountSyncSourcesSeeded } from "./accountSyncSources.js";
import {
  resolveBindHost,
  resolveCorsOrigins,
  sharedAuthPasswordFromEnv,
  sharedPasswordAuthMiddleware,
} from "./httpSecurity.js";
import { bootstrapDemoModeIfEnabled } from "./demoMode.js";
import { registerClientDistStatic, serveClientDistEnabled } from "./staticClientDist.js";
import { startDashboardCacheWarmer } from "./dashboardCacheWarmer.js";
import { startDbBackupScheduler } from "./dbBackupScheduler.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerMetaRoutes } from "./routes/meta.js";
import { registerAccountsRoutes } from "./routes/accounts.js";
import { registerMortgageRoutes } from "./routes/mortgage.js";
import { registerCreditCardRoutes } from "./routes/creditCard.js";
import { registerMovementsRoutes } from "./routes/movements.js";
import { registerMovementMirrorsRoutes } from "./routes/movementMirrors.js";
import { registerExportXlsxRoutes } from "./routes/exportXlsx.js";
import { registerProjectionsRoutes } from "./routes/projections.js";
import { registerWealthPercentileRoutes } from "./routes/wealthPercentile.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerMarketRoutes } from "./routes/market.js";
import { registerFlowsRoutes } from "./routes/flows.js";
import { registerSyncRoutes } from "./routes/sync.js";

seedNavTree();

loadRootDotenv();
bootstrapDemoModeIfEnabled();
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
const authPassword = sharedAuthPasswordFromEnv();
if (authPassword) {
  app.use(sharedPasswordAuthMiddleware(authPassword));
  console.log("auth: shared-password mode enabled (AUTH_PASSWORD set)");
}
app.use(express.json({ limit: "2mb" }));

/** Route registration order preserves the original monolithic file's order. */
registerAuthRoutes(app);
registerMetaRoutes(app);
registerAccountsRoutes(app);
registerMortgageRoutes(app);
registerCreditCardRoutes(app);
registerMovementsRoutes(app);
registerMovementMirrorsRoutes(app);
registerExportXlsxRoutes(app);
registerProjectionsRoutes(app);
registerWealthPercentileRoutes(app);
registerDashboardRoutes(app);
registerMarketRoutes(app);
registerFlowsRoutes(app);
registerSyncRoutes(app);

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
});

