/** Net-worth projections (/projections page). */
import express from "express";
import { buildProjectionsPayload, ProjectionParamError, projectionParamsFromQuery } from "../projections.js";
import { requestDisplayUnit } from "../displayUnits.js";

export function registerProjectionsRoutes(app: express.Express): void {
  app.get("/api/projections", (req, res) => {
    // Any core currency: the net-worth overview in it, its own inflation input.
    const unit = requestDisplayUnit(req.query, { surface: "/api/projections" });
    let params;
    try {
      params = projectionParamsFromQuery(req.query as Record<string, unknown>, unit);
    } catch (e) {
      if (e instanceof ProjectionParamError) {
        res.status(400).json({ error: e.message });
        return;
      }
      throw e;
    }
    res.json(buildProjectionsPayload(unit, params));
  });
}
