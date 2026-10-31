import type express from "express";
import { chileCalendarTodayYmd } from "../chileDate.js";
import { demoVisitorForRequest, noteDemoVisitSrc } from "../demoAnalytics.js";
import { demoModeEnabled } from "../demoMode.js";
import { recordUsagePageView, usageLogEnabled, type UsagePageViewSample } from "../usageLog.js";
import { normalizeUsagePagePath, USAGE_PAGE_VIEW_PATH, usagePageRoute } from "../usagePagePath.js";
import { buildUsageEndpointTrend, buildUsageReport, parseUsageReportWindow } from "../usageReport.js";

type BeaconOutcome = Exclude<UsagePageViewSample["outcome"], "untimed">;
const PAGE_VIEW_OUTCOMES = new Set<BeaconOutcome>(["settled", "left", "hidden", "timeout"]);

/** A page-view beacon body, or the reason it is not one (our own client sends it). */
export function parseUsagePageViewBody(
  body: unknown,
  now: Date,
  visitor: string | null
): { ok: true; sample: UsagePageViewSample } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const path = normalizeUsagePagePath(b.path);
  if (!path) return { ok: false, error: "path must be an app route" };
  const outcome = b.outcome as BeaconOutcome;
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
      visitor,
      initial: b.initial,
      outcome,
      settle_ms: outcome === "settled" ? (settle as number) : null,
      fetched_queries: fetched,
    },
  };
}

/** The demo's usage figures are the owner's (`npm run demo:visits`), never served publicly. */
function refuseOnDemo(res: express.Response): boolean {
  if (!demoModeEnabled()) return false;
  res.status(404).json({ error: "usage_report_not_public" });
  return true;
}

/**
 * Usage log (usageLog.ts): the client's page-view beacon and the `/panel/usage` reports. The
 * beacon answers 204 and records nothing while the log is off (secondary dev servers). On the
 * demo each view carries the visitor hash, a bot's view is not recorded, and the reports are
 * refused.
 */
export function registerUsageRoutes(app: express.Express): void {
  app.post(USAGE_PAGE_VIEW_PATH, (req, res) => {
    if (!usageLogEnabled()) {
      res.status(204).end();
      return;
    }
    let visitor: string | null = null;
    if (demoModeEnabled()) {
      const day = chileCalendarTodayYmd();
      const identity = demoVisitorForRequest(req, day);
      if (!identity) {
        res.status(204).end();
        return;
      }
      visitor = identity.visitor;
      noteDemoVisitSrc(day, visitor, req.body?.src);
    }
    const parsed = parseUsagePageViewBody(req.body, new Date(), visitor);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    recordUsagePageView(parsed.sample);
    res.status(204).end();
  });

  app.get("/api/usage/report", (req, res) => {
    if (refuseOnDemo(res)) return;
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
    if (refuseOnDemo(res)) return;
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
