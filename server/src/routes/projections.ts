/** Net-worth projections (/projections page). */
import express from "express";
import {
  buildProjectionsPayload,
  defaultMonthlyAporteClp,
  PROJECTION_DEFAULTS,
  PROJECTION_PARAM_BOUNDS,
  type ProjectionDrawdownBase,
  type ProjectionParams,
} from "../projections.js";

export function registerProjectionsRoutes(app: express.Express): void {
  app.get("/api/projections", (req, res) => {
    const unit = req.query.unit === "usd" ? ("usd" as const) : ("clp" as const);
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
    const baseRaw = req.query.drawdown_base;
    if (baseRaw != null && baseRaw !== "" && baseRaw !== "invested" && baseRaw !== "total") {
      res.status(400).json({ error: "drawdown_base must be invested or total" });
      return;
    }
    const drawdownBase: ProjectionDrawdownBase = baseRaw === "total" ? "total" : "invested";
    res.json(buildProjectionsPayload(unit, params, drawdownBase));
  });
}
