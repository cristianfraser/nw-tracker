/** Wealth percentile vs country distributions (/wealth-percentile page). */
import express from "express";
import { buildWealthPercentilePayload } from "../wealthPercentile.js";

export function registerWealthPercentileRoutes(app: express.Express): void {
  app.get("/api/wealth-percentile", (_req, res) => {
    res.json(buildWealthPercentilePayload());
  });
}
