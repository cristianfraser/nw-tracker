/**
 * Live prices from Yahoo's price stream (2026-11-04), with the REST poll as the backstop.
 *
 * The poll fetched every ticker at once, so every moved balance changed — and flashed — in the
 * same render. The server now keeps one socket to `wss://streamer.finance.yahoo.com/?version=2`
 * (no key; frames decoded by `yahooPricingData.ts`) subscribed to every symbol it prices plus
 * CLP=X, keeps the latest in-session price per symbol, and writes them by the rule in
 * `liveQuotesFlushPolicy.ts`: a holding is written when its price really moved, then not again
 * for 30–60 s (random, so holdings drift apart), so each flash is a real move at its own moment. Writes go through `writeStreamQuotes`,
 * the poll's own rows, stamp and scoped invalidation.
 *
 * Only regular-session prices inside the app's own gates are kept (NYSE / Santiago session,
 * crypto always, the dollar while its fx day is open); pre- and post-market prints are dropped,
 * so the post-close held print and the fx day end keep their poll-based rules. A symbol with a
 * kept tick in the last {@link STREAM_COVER_MS} is "covered": the poll does not fetch it
 * (`liveStreamCoverage`), and its row is re-stamped so readers never see it stale. Anything
 * uncovered — a disconnected stream, a quiet symbol, a closed market — is the poll's.
 *
 * The browser never talks to Yahoo. The hosted demo connects only while a visitor is browsing.
 */
import { demoMarketAwake, onDemoMarketWake } from "./demoMarketActivity.js";
import { equityMarketKind, isEquityRegularSessionOpen } from "./equityQuote.js";
import { yahooBarYmdFromUnix } from "./equityYahooEod.js";
import { LIVE_FX_YAHOO_SYMBOL, shouldUseLiveFxQuote } from "./fxLive.js";
import { liveQuotesFlushGapMs, liveQuotesStreamEnabled, liveQuotesStreamUrl } from "./liveMarketQuotesConfig.js";
import { writeStreamQuotes } from "./liveMarketQuotesSync.js";
import { nextUnitDueAtMs, pickNextFlush, type StreamPrice, type WrittenPrice } from "./liveQuotesFlushPolicy.js";
import { listWatchlistEquitySeriesKeys } from "./watchlist.js";
import { listCompositeConstituentTickers, RISKY_NORRIS_PROXY_BUCKET } from "./watchlistComposite.js";
import { decodeYahooStreamFrame, type YahooPricingTick } from "./yahooPricingData.js";

/** A symbol with a kept tick this recent is the stream's, not the poll's. */
export const STREAM_COVER_MS = 5 * 60_000;
/** A holding is written again after this, plus a random share of the spread (30–60 s). */
const UNIT_MIN_INTERVAL_MS = 30_000;
const UNIT_INTERVAL_SPREAD_MS = 30_000;
/** A covered symbol's row is written again this old (readers' freshness window is 10 min). */
const RESTAMP_AFTER_MS = 3 * 60_000;
/** No frame at all for this long while connected: the socket is dead without saying so. */
const SILENCE_RECONNECT_MS = 3 * 60_000;
const RECONNECT_DELAYS_MS = [2_000, 10_000, 30_000, 60_000];
const SYMBOL_REFRESH_MS = 5 * 60_000;
const FLUSH_CHECK_MS = 1_000;
const BASKET_UNIT = `basket:${RISKY_NORRIS_PROXY_BUCKET}`;

let running = false;
let ws: WebSocket | null = null;
let connected = false;
let reconnectAttempt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let lastFrameAtMs = 0;
let subscribed = new Set<string>();
let unitOf = new Map<string, string>();
const pending = new Map<string, StreamPrice>();
const lastKeptAtMs = new Map<string, number>();
const written = new Map<string, WrittenPrice>();
const unitDueAtMs = new Map<string, number>();
let lastChangeWriteAtMs: number | null = null;

/**
 * Whether a streamed tick is a live price the app reads now: a regular-session print of the
 * current session, inside the gate the readers apply (the poll stores only those too).
 */
export function streamTickInSession(tick: YahooPricingTick, now: Date): boolean {
  if (tick.marketHours !== "regular") return false;
  if (tick.symbol === LIVE_FX_YAHOO_SYMBOL) return shouldUseLiveFxQuote(now);
  const kind = equityMarketKind(tick.symbol);
  if (kind === "crypto24") return true;
  if (!isEquityRegularSessionOpen(kind, now)) return false;
  // A print from an earlier session (the subscribe snapshot of a symbol that has not traded
  // today) is not today's price.
  return (
    yahooBarYmdFromUnix(tick.symbol, Math.floor(tick.timeMs / 1000)) ===
    yahooBarYmdFromUnix(tick.symbol, Math.floor(now.getTime() / 1000))
  );
}

/** What the stream covers now: the poll skips these (`liveMarketQuotesScheduler.ts`). */
export function liveStreamCoverage(nowMs = Date.now()): { tickers: Set<string>; fx: boolean } {
  const tickers = new Set<string>();
  let fx = false;
  if (!connected) return { tickers, fx };
  for (const [symbol, at] of lastKeptAtMs) {
    if (nowMs - at > STREAM_COVER_MS || !subscribed.has(symbol)) continue;
    if (symbol === LIVE_FX_YAHOO_SYMBOL) fx = true;
    else tickers.add(symbol);
  }
  return { tickers, fx };
}

export function liveStreamConnected(): boolean {
  return connected;
}

function desiredSymbols(): Set<string> {
  return new Set([...listWatchlistEquitySeriesKeys().map((s) => s.toUpperCase()), LIVE_FX_YAHOO_SYMBOL]);
}

function refreshSymbols(): void {
  const desired = desiredSymbols();
  unitOf = new Map(listCompositeConstituentTickers(RISKY_NORRIS_PROXY_BUCKET).map((t) => [t.toUpperCase(), BASKET_UNIT]));
  const added = [...desired].filter((s) => !subscribed.has(s));
  const removed = [...subscribed].filter((s) => !desired.has(s));
  for (const s of removed) {
    pending.delete(s);
    lastKeptAtMs.delete(s);
    written.delete(s);
  }
  subscribed = desired;
  if (ws != null && connected) {
    if (added.length > 0) ws.send(JSON.stringify({ subscribe: added }));
    if (removed.length > 0) ws.send(JSON.stringify({ unsubscribe: removed }));
    if (added.length + removed.length > 0) {
      console.log(`live-quotes:stream — symbols +${added.length} −${removed.length} (${subscribed.size} subscribed)`);
    }
  }
}

function onFrame(text: string): void {
  lastFrameAtMs = Date.now();
  reconnectAttempt = 0;
  const tick = decodeYahooStreamFrame(text);
  if (tick == null || !subscribed.has(tick.symbol)) return;
  const now = new Date(lastFrameAtMs);
  if (!streamTickInSession(tick, now)) return;
  pending.set(tick.symbol, {
    symbol: tick.symbol,
    price: tick.price,
    timeMs: tick.timeMs,
    previousClose: tick.previousClose,
  });
  lastKeptAtMs.set(tick.symbol, lastFrameAtMs);
}

function scheduleReconnect(): void {
  if (!running || reconnectTimer != null || !demoMarketAwake()) return;
  const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]!;
  reconnectAttempt += 1;
  console.log(`live-quotes:stream — reconnecting in ${delay / 1000}s`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
  reconnectTimer.unref();
}

function connect(): void {
  if (!running || ws != null || !demoMarketAwake()) return;
  refreshSymbols();
  let socket: WebSocket;
  try {
    socket = new WebSocket(liveQuotesStreamUrl());
  } catch (e) {
    console.error(`live-quotes:stream — cannot open: ${e instanceof Error ? e.message : e}`);
    scheduleReconnect();
    return;
  }
  ws = socket;
  socket.onopen = () => {
    connected = true;
    lastFrameAtMs = Date.now();
    socket.send(JSON.stringify({ subscribe: [...subscribed] }));
    console.log(`live-quotes:stream — connected, ${subscribed.size} symbols`);
  };
  socket.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    try {
      onFrame(event.data);
    } catch (e) {
      // A frame the app cannot read means the stream changed: drop it and let the poll cover
      // every symbol until a reconnect reads again.
      console.error(`live-quotes:stream — unreadable frame (${e instanceof Error ? e.message : e}); disconnecting`);
      socket.close();
    }
  };
  socket.onerror = () => {
    // `onclose` follows; the error event carries no detail worth more than the close code.
  };
  socket.onclose = (event) => {
    const wasConnected = connected;
    if (ws === socket) ws = null;
    connected = false;
    lastKeptAtMs.clear();
    console.log(`live-quotes:stream — ${wasConnected ? "disconnected" : "could not connect"} (code ${event.code})`);
    scheduleReconnect();
  };
}

function disconnect(reason: string): void {
  if (ws == null) return;
  console.log(`live-quotes:stream — closing (${reason})`);
  ws.close();
}

/** Whether a subscribed symbol trades now, i.e. silence means a dead socket. */
function subscribedMarketOpen(now: Date): boolean {
  for (const symbol of subscribed) {
    if (symbol === LIVE_FX_YAHOO_SYMBOL) {
      if (shouldUseLiveFxQuote(now)) return true;
      continue;
    }
    if (isEquityRegularSessionOpen(equityMarketKind(symbol), now)) return true;
  }
  return false;
}

function flushCheck(): void {
  const nowMs = Date.now();
  if (!demoMarketAwake(nowMs)) {
    disconnect("the demo is asleep");
    return;
  }
  if (connected && nowMs - lastFrameAtMs > SILENCE_RECONNECT_MS && subscribedMarketOpen(new Date(nowMs))) {
    disconnect(`no frame for ${Math.round((nowMs - lastFrameAtMs) / 1000)}s`);
    return;
  }
  const covered = liveStreamCoverage(nowMs);
  if (covered.fx) covered.tickers.add(LIVE_FX_YAHOO_SYMBOL);
  const plan = pickNextFlush({
    nowMs,
    pending,
    written,
    unitOf,
    unitDueAtMs,
    lastChangeWriteAtMs,
    covered: covered.tickers,
    minFlushGapMs: liveQuotesFlushGapMs(),
    restampAfterMs: RESTAMP_AFTER_MS,
  });
  if (plan.changes.length === 0 && plan.restamps.length === 0) return;
  try {
    const result = writeStreamQuotes([...plan.changes, ...plan.restamps], new Date(nowMs));
    for (const quote of [...plan.changes, ...plan.restamps]) written.set(quote.symbol, { quote, atMs: nowMs });
    for (const unit of plan.units) {
      unitDueAtMs.set(unit, nextUnitDueAtMs(nowMs, UNIT_MIN_INTERVAL_MS, UNIT_INTERVAL_SPREAD_MS, Math.random()));
    }
    if (plan.changes.length > 0) {
      lastChangeWriteAtMs = nowMs;
      const moved = [...result.changedTickers, ...(result.fxChanged ? [LIVE_FX_YAHOO_SYMBOL] : [])];
      if (moved.length > 0) console.log(`live-quotes:stream — wrote ${moved.join(", ")}`);
    }
  } catch (e) {
    console.error(`live-quotes:stream — write failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** Opens the stream beside the live-quotes scheduler (which stays on as the backstop). */
export function startYahooPriceStream(): void {
  if (running) return;
  if (!liveQuotesStreamEnabled()) {
    console.log("live-quotes:stream — disabled (LIVE_QUOTES_STREAM_ENABLED=0); polling only.");
    return;
  }
  running = true;
  onDemoMarketWake(() => connect());
  connect();
  setInterval(flushCheck, FLUSH_CHECK_MS).unref();
  setInterval(() => {
    try {
      refreshSymbols();
    } catch (e) {
      console.error(`live-quotes:stream — symbol refresh failed: ${e instanceof Error ? e.message : e}`);
    }
  }, SYMBOL_REFRESH_MS).unref();
}
