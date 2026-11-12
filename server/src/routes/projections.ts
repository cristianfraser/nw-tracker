/** Net-worth projections (/projections page). */
import express from "express";
import {
  buildProjectionsPayload,
  defaultMonthlyAporteClp,
  PROJECTION_DEFAULTS,
  PROJECTION_PARAM_BOUNDS,
  type ProjectionParams,
} from "../projections.js";
import { requestDisplayUnit } from "../displayUnits.js";

export function registerProjectionsRoutes(app: express.Express): void {
  app.get("/api/projections", (req, res) => {
    // EUR projects from the EUR net-worth overview; its inflation is the USD input (projections.ts).
    const unit = requestDisplayUnit(req.query, { surface: "/api/projections", supported: ["clp", "usd", "eur"] });
    const params: ProjectionParams = {
      ...PROJECTION_DEFAULTS,
      monthly_aporte_clp: defaultMonthlyAporteClp(),
    };
    for (const key of Object.keys(PROJECTION_PARAM_BOUNDS) as (keyof ProjectionParams)[]) {
      const raw = req.query[key];
      if (raw == null || raw === "") continue;
      const n = Number(raw);
      const [min, max] = PROJECTION_PARAM_BOUNDS[key];
      if (!Number.isFinite(n) || n < min || n > max) {
        res.status(400).json({ error: `${key} must be a number in [${min}, ${max}]` });
        return;
      }
      params[key] = n;
    }
    res.json(buildProjectionsPayload(unit, params));
  });
}
