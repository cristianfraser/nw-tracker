/** FX (mid + bid/ask), market series/ticker, watchlist. Split verbatim from index.ts; paths unchanged. */
import express from "express";
import { listFxBidAskGaps, upsertManualFxBidAskRow } from "../fxBidAskGaps.js";
import { db } from "../db.js";
import { chileCalendarTodayYmd } from "../chileDate.js";
import { getMarketSeriesPayload } from "../marketSeries.js";
import { getMarketTickerPayload } from "../marketTicker.js";
import { liveQuoteMovesSince, liveQuotesStamp } from "../liveQuotesStamp.js";
import { servedClientBuildId } from "../clientBuild.js";
import {
  addManualWatchlistTickerFromYahoo,
  deleteManualWatchlistRow,
  getWatchlistPayload,
  patchWatchlistRow,
  searchWatchlistSymbols,
  watchlistDisplayUnitParam,
} from "../watchlist.js";
import { asyncHandler } from "./shared.js";
import { invalidateMarketDataAggregations } from "../cacheRegistry.js";
import { listEquitySplits, recordEquitySplit } from "../equitySplits.js";
import { isPositiveFiniteNumber, isYmdString } from "../requestValidation.js";

export function registerMarketRoutes(app: express.Express): void {
app.get("/api/fx/latest", (_req, res) => {
  const row = db
    .prepare(`SELECT date, clp_per_usd FROM fx_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`)
    .get(chileCalendarTodayYmd()) as { date: string; clp_per_usd: number } | undefined;
  res.json(row ?? null);
});

app.get("/api/fx/bid-ask/gaps", (_req, res) => {
  res.json({ gaps: listFxBidAskGaps() });
});

/** Upsert directional FX: body { date, buy_clp_per_usd, sell_clp_per_usd } */
app.post("/api/fx/bid-ask", (req, res) => {
  const { date, buy_clp_per_usd, sell_clp_per_usd } = req.body as {
    date?: string;
    buy_clp_per_usd?: number;
    sell_clp_per_usd?: number;
  };
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "date (YYYY-MM-DD) required" });
    return;
  }
  if (
    buy_clp_per_usd == null ||
    sell_clp_per_usd == null ||
    !Number.isFinite(buy_clp_per_usd) ||
    !Number.isFinite(sell_clp_per_usd) ||
    buy_clp_per_usd <= 0 ||
    sell_clp_per_usd <= 0
  ) {
    res.status(400).json({ error: "positive buy_clp_per_usd and sell_clp_per_usd required" });
    return;
  }
  if (buy_clp_per_usd < sell_clp_per_usd) {
    res.status(400).json({ error: "buy_clp_per_usd must be >= sell_clp_per_usd" });
    return;
  }
  try {
    const row = upsertManualFxBidAskRow(date, buy_clp_per_usd, sell_clp_per_usd);
    res.json({ ok: true, row });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/fx", (_req, res) => {
  const rows = db
    .prepare(`SELECT date, clp_per_usd FROM fx_daily ORDER BY date DESC LIMIT 365`)
    .all();
  res.json({ rates: rows });
});

/** Upsert FX: body { date: 'YYYY-MM-DD', clp_per_usd: number } */
app.post("/api/fx", (req, res) => {
  const { date, clp_per_usd } = req.body as { date?: unknown; clp_per_usd?: unknown };
  if (!isYmdString(date)) {
    res.status(400).json({ error: "date must be YYYY-MM-DD" });
    return;
  }
  if (!isPositiveFiniteNumber(clp_per_usd)) {
    res.status(400).json({ error: "positive clp_per_usd required" });
    return;
  }
  db.prepare(
    `INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, ?)
     ON CONFLICT(date) DO UPDATE SET clp_per_usd = excluded.clp_per_usd`
  ).run(date, clp_per_usd);
  res.json({ ok: true });
});

/** Upsert UF (CLF): body { date: 'YYYY-MM-DD', clp_per_uf: number } CLP per 1 UF */
app.get("/api/market-series", (_req, res) => {
  res.json(getMarketSeriesPayload());
});

// When the live prices last moved (published once the dashboard caches carry them); the client
// polls it and refetches on change. In-process state only — `null` until a poll moves a price.
// `?since=<stamp the client saw>`: also what moved since then (null when nothing did).
// `client_build`: the client build this server serves (null when it serves none), so an open
// tab running an older one reloads (client/src/clientBuild.ts).
app.get("/api/live-quotes/stamp", (req, res) => {
  const since = typeof req.query.since === "string" ? req.query.since : null;
  res.json({
    stamp: liveQuotesStamp(),
    moves: liveQuoteMovesSince(since),
    client_build: servedClientBuildId(),
  });
});

// `?unit=usd` returns values and changes in USD (the app's CLP/USD toggle); default CLP.
app.get("/api/market-ticker", (req, res) => {
  try {
    res.json(getMarketTickerPayload(new Date(), watchlistDisplayUnitParam(req.query.unit)));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "market_ticker_failed" });
  }
});

app.get("/api/equity-splits", (req, res) => {
  const ticker = typeof req.query.ticker === "string" ? req.query.ticker.trim() : "";
  if (!ticker) {
    res.status(400).json({ error: "ticker required" });
    return;
  }
  res.json({ splits: listEquitySplits(ticker) });
});

/**
 * Record a split by hand (`equitySplits.ts`): the prices before the ex-date are re-framed and
 * every holder gets its `stock_split` row, in one transaction. Body: ticker, ex_date,
 * numerator, denominator (3 and 1 for a 3-for-1).
 */
app.post("/api/equity-splits", (req, res) => {
  const b = (req.body ?? {}) as { ticker?: unknown; ex_date?: unknown; numerator?: unknown; denominator?: unknown };
  if (typeof b.ticker !== "string" || !b.ticker.trim() || !isYmdString(b.ex_date)) {
    res.status(400).json({ error: "ticker and ex_date (YYYY-MM-DD) required" });
    return;
  }
  if (!isPositiveFiniteNumber(b.numerator) || !isPositiveFiniteNumber(b.denominator)) {
    res.status(400).json({ error: "numerator and denominator must be positive numbers" });
    return;
  }
  try {
    const out = recordEquitySplit({
      ticker: b.ticker,
      ex_date: b.ex_date,
      numerator: b.numerator,
      denominator: b.denominator,
      source: "manual",
    });
    if (out.status === "recorded" || out.ledger.some((r) => r.status === "written")) {
      invalidateMarketDataAggregations("historical");
    }
    res.status(out.status === "recorded" ? 201 : 200).json(out);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "equity_split_failed" });
  }
});

// DB-only: history depth is maintained by the live-quotes scheduler, never on request.
app.get("/api/watchlist", (req, res) => {
  try {
    res.json(getWatchlistPayload(new Date(), watchlistDisplayUnitParam(req.query.unit)));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "watchlist_failed" });
  }
});

app.patch("/api/watchlist/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const body = req.body as { show_in_marquee?: number; sort_order?: number };
  try {
    res.json(patchWatchlistRow(id, body));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "watchlist_patch_failed";
    res.status(400).json({ error: msg });
  }
});

// The two Yahoo calls on a request path: the user's own typing and add, never a display read.
app.get(
  "/api/watchlist/search",
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      res.json({ results: [] });
      return;
    }
    try {
      res.json({ results: await searchWatchlistSymbols(q) });
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : "watchlist_search_failed" });
    }
  })
);

app.post(
  "/api/watchlist",
  asyncHandler(async (req, res) => {
    const ticker = typeof req.body?.ticker === "string" ? req.body.ticker : "";
    if (!ticker.trim()) {
      res.status(400).json({ error: "ticker required" });
      return;
    }
    try {
      res.status(201).json(await addManualWatchlistTickerFromYahoo(ticker));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "watchlist_add_failed";
      const status = msg.includes("already") ? 409 : 400;
      res.status(status).json({ error: msg });
    }
  })
);

app.delete("/api/watchlist/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  try {
    deleteManualWatchlistRow(id);
    res.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "watchlist_delete_failed";
    res.status(400).json({ error: msg });
  }
});

}
