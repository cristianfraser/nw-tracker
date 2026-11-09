# Demo health-check stalls — plan

Status: plan, 2026-11-09. Nothing built yet.

## What Render reports

Render probes `GET /api/health` every few seconds and alerts when a probe gets no answer within
5 seconds (its fixed timeout; the path is `healthCheckPath` in `render.yaml`). The alerts so far:

| When (Chile) | What |
| --- | --- |
| 2026-11-06 00:01 | «HTTP health check failed (timed out after 5 seconds)», recovered 00:02 |
| 2026-11-07 00:01 | same, recovered a minute later |
| 2026-11-09 17:22 | same, on the instance still serving 91a1a4c while the two releases of the day failed to build |

The two midnight ones line up with the Chile day rollover; the afternoon one with a rebuild
after a market tick (the demo was awake: someone was browsing). The service recovered on its own
every time, nothing was lost, and a deploy does not change it. It is a symptom of how the server
spends its CPU, not of a fault — but each alert is a mail, and a visitor during those seconds
waits as long as the probe did.

## What the 2026-11-09 release found: it was memory first

The release of the US chapter (6da22346) did not stall — it died. The Render instance restarted
every ~3 minutes with `FATAL ERROR: Ineffective mark-compacts near heap limit … JavaScript heap
out of memory` about 50 s after boot, in the first warm step. V8 sizes its heap from the
machine's memory, ~256 MB on the Starter (512 MB), and the boot warm needed ~290 MB on the
longer US-chapter history: every % the app shows compounds its scope's own daily returns, and
the readers held the whole cached daily payload of every account and group (48 scopes × 2
units; the CLP home bundle alone retained 98 MB). `dailyPctSeries.ts` now keeps only each
day's pct for those readers (56 MB; the full warm ~200 MB) and `render.yaml` sets
`NODE_OPTIONS=--max-old-space-size=320`; the warm's log line prints the heap it used, and
`server/scripts/profile-cache-memory.ts` lists what each step retains. The stalls below are the
same mechanism one notch down: a warm that fits in memory but holds the loop.

## Why the probe times out

The server is one Node process. The health route itself costs nothing
(`server/src/routes/meta.ts` line 10), but it only runs when the event loop is free, and three
things hold the loop for seconds at a time on the demo's half-CPU Starter instance:

1. **The day rollover drops everything but the mark series.** `ensureCacheFresh()`
   (`cacheRegistry.ts`) runs before every cached read; when the Chile day has changed it calls
   `dropAllButMarkSeries()`: the aggregation cache, the live tier AND the history tier (`hist.`
   families) go. The first request after midnight — a visitor, or the 00:05 warm — rebuilds every
   page bundle from the month-end marks up, and the history tier (merged deposit timelines, past
   marks, month closes, past-day MTM) is rebuilt with it. On the home server that warm is ~35 s cold
   against ~3,5 s after a price tick (`AGENTS.md` «A live-quote tick rebuilds only today»); the
   Starter instance is slower still.
2. **A warm step is one synchronous build.** `runWarm` (`dashboardCacheWarmer.ts`) waits
   `whenNoApiRequestsInFlight()` between steps, never inside one: each
   `buildDashboardPageBundle(unit)`, `getDashboardOverviewDaily`, `buildFlowsOverviewPayload`,
   each visited page and each Rentabilidad scope is a block of synchronous SQLite reads and
   arithmetic. The health probe (deliberately not counted as a request in flight,
   `apiRequestsInFlight.ts`) lands inside one and waits for its end. A block longer than 5 s is
   an alert.
3. **A visitor's cold request does the same.** With the warmer behind (or the cache just
   dropped), the request that needs a payload builds it itself, holding the loop as long.

So the midnight alerts are (1) + (2); the afternoon one is (2) or (3) after a tick that dropped
more than the live tier (a `historical` market notice — the EOD syncs run while the demo is awake,
`demoMarketActivity.ts`).

## Options

### A. Keep the history tier across the day rollover

Nothing historical changes at midnight: an entry the tier holds was built from evidence dated
strictly before the day it was built on, and that evidence is still strictly before the new day.
Keeping the tier turns the midnight rebuild into the shape of a live-tick rebuild (every payload
rebuilt on top of its inputs: ~3,5 s instead of ~35 s on the home server).

Where it is not true, and what to do:

- An entry whose key means «through yesterday» is stale once yesterday moves: the ledger
  accounts' closed-month rows (`ledger_closed_month_rows`) gain a month when the rollover crosses
  a month end; a past-day converter keyed on the day is fine, one keyed on «yesterday» is not.
  Audit every `historyTierMemo` name and `buildHistoryTierValue` call for a key that depends on
  today's date rather than on the date it describes; the fix is to put the date in the key or to
  drop that one memo on the rollover (a `dropOnDayRollover` flag on the memo).
- The month-end marks a monthly builder walks: the day that just ended may be a month end, and its
  mark was computed as «today» (live, never cached) — the first read after midnight must compute it
  as a past day, which the mark series already does (today is never in the store). The history
  tier's `accountMarkClpAtYmd` memo for a past day is keyed on the day, so the new day is a plain
  miss.
- `liveTickIncrementalRebuild.test.ts` is the parity harness: add a simulated day rollover (clock
  moved past Chile midnight, no writes) and assert the 308 payloads equal a rebuild from an empty
  cache, on the synthetic DB and on a real-DB copy.

Cost: a day's worth of history-tier entries stays resident one more day (it is bounded by what
the pages read; it is dropped by every write anyway). This is the fix with the biggest effect on
both the alert and the first visitor after midnight.

### B. Yield inside the long synchronous steps

The warmer yields between steps only. Inside, the Rentabilidad warm already runs one scope per
macrotask (`rentabilidadDailyWarm.ts`), which is the shape to copy: break the page bundle warm
into its parts (the account rows, each card metric node, the overview block, the value map) with
a `setImmediate` between parts, and the visited-pages warm per page. A request arriving between
parts is answered then; the probe too.

Limits: a part is still synchronous — the biggest ones (the Pasivos daily series full history,
the group consolidation of net worth) are several seconds alone on the Starter instance, so B
shortens the stall but cannot bound it under 5 s on its own. It also cannot help a visitor's own
cold request (3). Do it after A, for the steps A leaves long.

### C. A front process that answers the probe on its own

A tiny proxy (Node, in the same service) listening on `PORT`, answering `/api/health` itself and
forwarding everything else to the app on another port. The probe then never waits on the event
loop. But a probe that always passes tells Render nothing: a hung app would pass it too, and
Render's restart-on-failure is the one recovery the demo has. Only worth it if the proxy forwards
a lightweight liveness check with its own generous timeout (say 30 s) — at which point it is a
timeout extension, not a health check, and Render's own 5 s cannot be configured. Not recommended
on its own.

### D. A bigger instance

Standard (1 CPU, 2 GB) roughly halves the cold rebuild and the stall with it, for about twice the
monthly cost. It does not change the shape of the problem (a 15 s block becomes 8 s, still over
the probe), so it only pays after A and B.

## Recommendation

1. **A** first: keep the history tier across the rollover, with the key audit and the parity
   test. It fixes the midnight alerts at their cause and makes the 00:05 warm and the first
   visitor's page a live-tick-sized rebuild.
2. **B** for what is still long after A: measure each warm step on a Starter-sized box (the
   Render shell, `DEBUG_PERF=1`), and chunk the ones over ~2 s.
3. Re-check the alerts for a week. If the afternoon kind persists (a visitor's cold request after
   an EOD sync), the remaining lever is D; C is not worth its blind spot.

Not in scope: the home server, which has no probe (its deploy agent polls `/api/health` with its
own timeout and never alerts on a slow answer).
