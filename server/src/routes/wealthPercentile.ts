/** Wealth percentile vs country distributions (/wealth-percentile page).
 * Hidden in the hosted demo: the sidebar-nav route drops the link and this endpoint 404s. */
import express from "express";
import { demoModeEnabled } from "../demoMode.js";
import { buildWealthPercentilePayload } from "../wealthPercentile.js";

export function registerWealthPercentileRoutes(app: express.Express): void {
  app.get("/api/wealth-percentile", (_req, res) => {
    if (demoModeEnabled()) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(buildWealthPercentilePayload());
  });
}
