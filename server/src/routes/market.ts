/** FX (mid + bid/ask), UF, market series/ticker, watchlist. Split verbatim from index.ts; paths unchanged. */
import express from "express";
import { buildFxCoverage } from "../fxCoverage.js";
import { listFxBidAskGaps, upsertManualFxBidAskRow } from "../fxBidAskGaps.js";
import { db } from "../db.js";
import { chileCalendarTodayYmd } from "../chileDate.js";
import { getMarketSeriesPayload } from "../marketSeries.js";
import { getMarketTickerPayload } from "../marketTicker.js";
import {
  addManualWatchlistTicker,
  deleteManualWatchlistRow,
  getWatchlistPayload,
  patchWatchlistRow,
} from "../watchlist.js";
import { isPositiveFiniteNumber, isYmdString } from "../requestValidation.js";

export function registerMarketRoutes(app: express.Express): void {
app.get("/api/fx/latest", (_req, res) => {
  const row = db
    .prepare(`SELECT date, clp_per_usd FROM fx_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`)
    .get(chileCalendarTodayYmd()) as { date: string; clp_per_usd: number } | undefined;
  res.json(row ?? null);
});

app.get("/api/fx/coverage", (_req, res) => {
  res.json(buildFxCoverage());
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

app.get("/api/uf/latest", (_req, res) => {
  const row = db
    .prepare(`SELECT date, clp_per_uf FROM uf_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`)
    .get(chileCalendarTodayYmd()) as { date: string; clp_per_uf: number } | undefined;
  res.json(row ?? null);
});

app.get("/api/uf", (_req, res) => {
  const rows = db.prepare(`SELECT date, clp_per_uf FROM uf_daily ORDER BY date DESC LIMIT 500`).all();
  res.json({ rates: rows });
});

/** Upsert UF (CLF): body { date: 'YYYY-MM-DD', clp_per_uf: number } CLP per 1 UF */
app.post("/api/uf", (req, res) => {
  const { date, clp_per_uf } = req.body as { date?: unknown; clp_per_uf?: unknown };
  if (!isYmdString(date)) {
    res.status(400).json({ error: "date must be YYYY-MM-DD" });
    return;
  }
  if (!isPositiveFiniteNumber(clp_per_uf)) {
    res.status(400).json({ error: "positive clp_per_uf required" });
    return;
  }
  db.prepare(
    `INSERT INTO uf_daily (date, clp_per_uf) VALUES (?, ?)
     ON CONFLICT(date) DO UPDATE SET clp_per_uf = excluded.clp_per_uf`
  ).run(date, clp_per_uf);
  res.json({ ok: true });
});

app.get("/api/market-series", (_req, res) => {
  res.json(getMarketSeriesPayload());
});

app.get("/api/market-ticker", (_req, res) => {
  try {
    res.json(getMarketTickerPayload());
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "market_ticker_failed" });
  }
});

// DB-only: history depth is maintained by the live-quotes scheduler, never on request.
app.get("/api/watchlist", (_req, res) => {
  try {
    res.json(getWatchlistPayload());
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

app.post("/api/watchlist", (req, res) => {
  const ticker = typeof req.body?.ticker === "string" ? req.body.ticker : "";
  if (!ticker.trim()) {
    res.status(400).json({ error: "ticker required" });
    return;
  }
  try {
    res.status(201).json(addManualWatchlistTicker(ticker));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "watchlist_add_failed";
    const status = msg.includes("already") ? 409 : 400;
    res.status(status).json({ error: msg });
  }
});

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
