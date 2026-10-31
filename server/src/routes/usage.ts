import type express from "express";
import {
  normalizeUsagePagePath,
  recordUsagePageView,
  usageLogEnabled,
  usagePageRoute,
  type UsagePageViewSample,
} from "../usageLog.js";
import { buildUsageEndpointTrend, buildUsageReport, parseUsageReportWindow } from "../usageReport.js";

const PAGE_VIEW_OUTCOMES = new Set<UsagePageViewSample["outcome"]>(["settled", "left", "hidden", "timeout"]);

/** A page-view beacon body, or the reason it is not one (our own client sends it). */
export function parseUsagePageViewBody(
  body: unknown,
  now: Date
): { ok: true; sample: UsagePageViewSample } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const path = normalizeUsagePagePath(b.path);
  if (!path) return { ok: false, error: "path must be an app route" };
  const outcome = b.outcome as UsagePageViewSample["outcome"];
  if (!PAGE_VIEW_OUTCOMES.has(outcome)) return { ok: false, error: "unknown outcome" };
  const settle = b.settle_ms;
  if (outcome === "settled") {
    if (typeof settle !== "number" || !Number.isFinite(settle) || settle < 0) {
      return { ok: false, error: "a settled view needs settle_ms ≥ 0" };
    }
  } else if (settle !== null) {
    return { ok: false, error: "only a settled view carries settle_ms" };
  }
  const fetched = b.fetched_queries;
  if (typeof fetched !== "number" || !Number.isInteger(fetched) || fetched < 0) {
    return { ok: false, error: "fetched_queries must be a non-negative integer" };
  }
  if (typeof b.initial !== "boolean") return { ok: false, error: "initial must be a boolean" };
  return {
    ok: true,
    sample: {
      viewed_at: now.toISOString(),
      route: usagePageRoute(path),
      path,
      initial: b.initial,
      outcome,
      settle_ms: outcome === "settled" ? (settle as number) : null,
      fetched_queries: fetched,
    },
  };
}

/**
 * Usage log (usageLog.ts): the client's page-view beacon and the `/panel/usage` reports. The
 * beacon answers 204 and records nothing while the log is off (demo, secondary dev servers).
 */
export function registerUsageRoutes(app: express.Express): void {
  app.post("/api/usage/page-view", (req, res) => {
    if (!usageLogEnabled()) {
      res.status(204).end();
      return;
    }
    const parsed = parseUsagePageViewBody(req.body, new Date());
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    recordUsagePageView(parsed.sample);
    res.status(204).end();
  });

  app.get("/api/usage/report", (req, res) => {
    let days;
    try {
      days = parseUsageReportWindow(req.query.days);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
      return;
    }
    res.json(buildUsageReport(days));
  });

  app.get("/api/usage/endpoint-trend", (req, res) => {
    const { method, route } = req.query;
    const params = req.query.params ?? "";
    if (typeof method !== "string" || typeof route !== "string" || typeof params !== "string") {
      res.status(400).json({ error: "method, route and params are required" });
      return;
    }
    let days;
    try {
      days = parseUsageReportWindow(req.query.days);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
      return;
    }
    res.json(buildUsageEndpointTrend({ method, route, params }, days));
  });
}
