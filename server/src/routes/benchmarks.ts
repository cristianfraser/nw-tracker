/** Benchmarks and the Rentabilidad comparison row (shadow portfolio). */
import express from "express";
import { benchmarkComparisonForAccount, benchmarkComparisonForGroup } from "../benchmarkComparison.js";
import { getBenchmark, listBenchmarks } from "../benchmarkLevels.js";
import { computeMortgagePrepaymentComparison } from "../mortgagePrepaymentComparison.js";
import {
  isInvestmentPerformanceGroupSlug,
  isResolvablePortfolioGroupSlug,
  normalizeLegacyTabSubgroup,
  resolvePortfolioGroupSlugForLegacyTab,
} from "../portfolioGroupTree.js";
import { isKnownClassTabGroup } from "./shared.js";

export function registerBenchmarkRoutes(app: express.Express): void {
  app.get("/api/benchmarks", (_req, res) => {
    res.json({
      benchmarks: listBenchmarks().map((b) => ({
        slug: b.slug,
        label_i18n_key: b.label_i18n_key,
        rate_pct: b.rate_pct,
      })),
    });
  });

  /**
   * `?benchmark=<slug>&unit=clp|usd` plus `account_id=<id>` or `portfolio_group=<slug>`
   * (same slug resolution as `/api/groups/:slug/consolidated-tables`). `null` body: the page
   * has no Rentabilidad table.
   */
  app.get("/api/benchmark-comparison", (req, res) => {
    const slug = typeof req.query.benchmark === "string" ? req.query.benchmark : "";
    const benchmark = getBenchmark(slug);
    if (!benchmark) {
      res.status(400).json({ error: "unknown benchmark" });
      return;
    }
    const unit = req.query.unit === "usd" ? ("usd" as const) : ("clp" as const);

    if (req.query.account_id != null) {
      const id = Number(req.query.account_id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: "invalid account_id" });
        return;
      }
      res.json(benchmarkComparisonForAccount(id, benchmark, unit));
      return;
    }

    const group = typeof req.query.portfolio_group === "string" ? req.query.portfolio_group.trim() : "";
    const subRaw = normalizeLegacyTabSubgroup(req.query.subgroup);
    if (!group || subRaw === null) {
      res.status(400).json({ error: "account_id or portfolio_group required" });
      return;
    }
    const tabSlug =
      resolvePortfolioGroupSlugForLegacyTab(group, subRaw) ??
      (isResolvablePortfolioGroupSlug(group) ? group : null);
    if (!tabSlug || !isKnownClassTabGroup(tabSlug)) {
      res.status(400).json({ error: "unknown group slug" });
      return;
    }
    if (!isInvestmentPerformanceGroupSlug(tabSlug)) {
      res.json(null);
      return;
    }
    res.json(benchmarkComparisonForGroup(tabSlug, benchmark, unit));
  });

  /**
   * `?account_id=<mortgage account>&benchmark=<slug>&unit=clp|usd`: the mortgage's payments above
   * the minimum, prepaid vs invested in the benchmark. `null` body: no such payments.
   */
  app.get("/api/mortgage-prepayment-comparison", (req, res) => {
    const benchmark = getBenchmark(typeof req.query.benchmark === "string" ? req.query.benchmark : "");
    if (!benchmark) {
      res.status(400).json({ error: "unknown benchmark" });
      return;
    }
    const id = Number(req.query.account_id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "invalid account_id" });
      return;
    }
    const unit = req.query.unit === "usd" ? ("usd" as const) : ("clp" as const);
    res.json(computeMortgagePrepaymentComparison({ accountId: id, benchmark, unit }));
  });
}
