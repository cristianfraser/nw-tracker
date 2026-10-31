# Performance plan

Status: phases 1–2 merged (2026-10-30); phases 3–4 on branch `claude/perf-phases-3-4-2f95ae`
(2026-10-31, measured below). The primary instance runs on a 2019 Intel MacBook Pro
(i5-8279U); pages that felt instant on the M-series laptop are slow there. This plan orders the
known fixes by what a person feels, starting with a warm reload of the Pasivos daily view.

## Where we are

### Measured on the live server (2026-10-30, ~23:00, warm, no restart)

A Cmd+R of `/liabilities` (Diario, 3y) takes **~6,8 s** until every request has answered, the
same on consecutive reloads. Even trivial requests wait the whole time
(`/api/live-quotes/stamp`: 6,7 s): the server is one Node process, so concurrent requests run one
after another, and each page waits for the sum of its handlers.

Each request alone (second run in brackets):

| Request | Time alone | Size | Cached across requests? |
| --- | --- | --- | --- |
| `groups/liabilities/performance-monthly` | 5,4 s (0,14 s) | 43 KB | yes, but dropped by every price tick |
| `dashboard/valuation-timeseries?portfolio_group=liabilities` | 3,1 s (2,0 s) | 85 KB | no (per-request only) |
| `portfolio-groups/liabilities/cc-ledger` | 1,3 s (1,7 s) | 129 KB | no |
| `dashboard/nav-context` | 1,05 s (1,03 s) | 130 KB | no |
| `daily-series?portfolio_group=liabilities&days=1096` | 0,52 s (0,50 s) | 548 KB | yes |
| `meta/sidebar-nav` | 0,25 s | 79 KB | no |
| everything else | < 0,06 s | | |

- **Price ticks every 5 minutes, all day and night.** Bitcoin and Ether move around the clock,
  so `live-quotes:sync` invalidates the market aggregations every poll (2 min during market
  hours, 5 min otherwise) — 1 519 rewarms logged so far. Every page cache the warmer does not
  rebuild (group pages, Pasivos) is cold again a few minutes after it was built.
- **The warmer only rebuilds the home page bundle and the Rentabilidad daily series.** Group
  pages, Pasivos, the card ledger and the daily chart of any non-home page are rebuilt by the
  first request that needs them.
- **No response compression.** `daily-series` sends 548 KB (3y) / 1,4 MB (full history) of JSON
  uncompressed; over Tailscale from a phone that is the transfer, not the server.

### Uncached first builds (profile on a copy, 2026-10-30)

Pasivos daily series 49 s (3y) / 124 s (full history); mortgage daily 7 s / 25 s; card ·0781
detail bundle 34 s and 1,6 MB; mortgage detail bundle 30 s; nav context / snapshot 33–35 s; four
group endpoints (valuation, tables, monthly performance, monthly detail) 6–11 s each, each
rebuilding the same group consolidation. These are what a restart, a deploy or a data write
costs.

### Already done or in flight

- **Incremental rewarm after a price tick** — merged, deployed: the warmer rebuild went from
  ~110 s to 13–19 s per tick.
- **Request-path caches** — branch `claude/great-visvesvaraya-723713`, 7 commits, not merged:
  nav snapshot / nav context / overview / sidebar / group valuation series kept for the page
  bundle's lifetime; per-account prefix sums for ledger balances; one indexed UF lookup; static
  account and group metadata from a shared index; Fintual position meta memoised; Expenses page
  payloads cached; parity tests against uncached builds.
- **Usage and timing log** — branch `claude/laughing-ardinghelli-b70a44`, not merged: per-endpoint
  p50/p95 and page-visit timings, `/panel/usage`.

## Plan

Each phase ships on its own, keeps payloads byte-identical (parity tests against an uncached
build), and is measured on the MacBook before and after.

### 1. Measure what you actually do

- Merge the usage log, so every later phase is judged by real p50/p95 per endpoint and per page,
  not one-off profiles.
- Label the unlabelled heavy paths with `[heavy]` spans: `getBucketDailySeries`, the reference
  lines, `cc-ledger`, `buildAccountDetailBundle`, the group consolidation — the last profile
  could only attribute 4 spans.

### 2. Land the request-path caches

Merge the speed-up branch (after re-running its timings on the MacBook). Expected on the Pasivos
reload: the valuation series (2–3 s) and nav context (1 s) become cache reads; the per-mark
costs shrink every cold build.

### 3. Stop a price tick from emptying caches it does not affect

A tick changes today's value of market-priced accounts only. Pasivos' card ledger, mortgage
ledger and the liabilities' monthly performance depend on no live price, yet a Bitcoin move at
3 a.m. drops them.

- Record, for each cached aggregate, the accounts it reads (the mark-input waterfall already
  knows account → series); a `live_tail` invalidation dirties only aggregates holding an account
  whose live price moved, and only their today / current-month tail (the incremental rewarm's
  mechanism).
- Consider a quieter crypto cadence outside market hours (e.g. 15 min) — a product choice, not a
  fix.

### 4. Cache and warm what is still built per request

- `cc-ledger` (1,3–1,7 s every call): aggregation-cache key per group and unit, under
  `invalidateCcBillingDetail`; not market-dependent except the dollar rate on today's lines.
- Card detail bundle (34 s cold, 1,6 MB): cache it, and find what makes it 1,6 MB (likely every
  statement line) — send what the page shows, page the rest.
- One group consolidation per (group, unit), shared by the four group endpoints.
- Warm the pages you use: once the usage log exists, the warmer rebuilds the most visited group
  pages (and their daily series at the Rango you use) after each invalidation, most visited first.

### Phases 3–4 as built (2026-10-31, Intel home server, copy of the real DB)

| Path | Before | After |
| --- | --- | --- |
| Pasivos, all requests at once, warm | 1,9 s | 0,11 s |
| Pasivos, one after another, after a crypto-only tick (no warmer) | 6,4 s | 2,1 s |
| First Pasivos + ·0781 visit after a boot warm | 6,1 s | 0,23 s |
| cc-ledger, warm | 1,3 s | 5 ms |
| ·0781 account bundle | 1,64 MB, 156 ms warm | 169 KB, 8 ms |
| Brokerage page endpoints, all at once, warm | 431 ms | 50 ms |

Chart-inactive now reads units and dollars instead of building each account's peso series
(flags identical on all 40 accounts; sidebar cold 2,1 s -> 1,0 s).

### What is still slow after phases 3-4 (measured 2026-10-31, Intel, copy of the real DB)

Pasivos after a crypto-only tick (warmer off), 2,1 s one after another:

| Request | After a tick | Why it rebuilds |
| --- | --- | --- |
| `dashboard/nav-context` | 0,75 s | every account's dashboard row (today's value, current-month perf) in one cached build |
| `valuation-timeseries?portfolio_group=liabilities` | 0,65 s | the «Disponible» lines sum brokerage, crypto included |
| `daily-series?portfolio_group=liabilities&days=1096` | 0,48 s | same reference lines, daily |
| `meta/sidebar-nav` | 0,16 s | orders chart buckets by today's value (a real price dependency) |

Also: on weekdays while the fx day is open the dollar moves on almost every poll, and nearly every
payload reads it (USD units, card dollars), so most caches still go every 2-5 minutes; with the
warmer on, requests right after a tick wait behind the rewarm (seen at 1,5-2,5 s); cold builds
after a boot or a write (nav-context 11 s, Pasivos daily 7 s, a group's tables 15 s) are covered
by the warmer but block every request while it runs (~47 s at boot).

Possible improvements, by expected gain:

**A. Rebuild only today's part of a dropped payload.** A dropped entry is rebuilt whole, on top of
the history tier. Split the expensive builders into a past part (every day / month before today,
cached like the history tier: survives ticks, dropped by writes and historical data) and a today
part recomputed per tick: daily series = cached past points + today's point; monthly payloads =
cached closed months + the current-month row; valuation series = cached past points + live last
point (`patchAccountLiveLastPoint` already isolates it). Expected: the three Pasivos rebuilds
(~1,9 s) to well under 0,3 s, and the same on every page during the fx day, which is the case
phases 3-4 do not help. Risk: the past part must never read today (the history-tier rule);
parity tests per builder against a whole build. Largest change; do it builder by builder,
starting with the daily series (biggest and simplest: the grid already ends at today).

**B. One dashboard row per account, cached with its own dependencies.** `account_rows|<unit>`
is one entry, so any moved price rebuilds all 40 rows (nav-context 0,75 s, the bundles, the
account pages). Cache each row (`account_row|<id>|<unit>`) so a coin tick rebuilds the two coin
rows; the card metrics and bucket totals are sums over rows and stay cheap. Expected:
nav-context after a coin tick 0,75 s -> ~0,1 s, the home bundle rebuild after a tick shorter too.
Small change, low risk (rows are already independent).

**C. Keep requests ahead of the warmer.** (Done 2026-10-31: `apiRequestsInFlight.ts`; synthetic demo DB, Pasivos requests landing during the bundle rewarm 0,95-1,5 s -> 0,47-1,0 s.) The warmer yields between pages, but one page build
blocks for up to ~1 s. Count in-flight API requests in a middleware; the warmer awaits zero
in-flight requests before each step and reorders: a page requested while it waits is built by
the request, the warmer then hits the cache. Expected: a reload right after a tick costs what the
request needs, never the rest of the warm (seen 1,5-2,5 s). Small change. Longer term (plan
phase 7): build caches in a worker thread.

**D. Serialize big payloads once.** The Pasivos daily series is 548 KB (1,4 MB full history) and is
`JSON.stringify`ed on every request (~15 ms on a hit, more on the phone over Tailscale because it
is uncompressed). Cache the serialized string next to the object and add gzip (plan phases 5-6).
Expected: ~10 ms per request on the server, 548 KB -> ~70 KB on the wire. Small change.

**E. Reference lines from their own cached parts.** The Pasivos valuation and daily series rebuild
the liabilities' own lines when only the «Disponible» sources moved. Keep the host's own lines
and each source's lines as separate cached parts and assemble on read, so a coin tick recomputes
the brokerage source only. Smaller gain than A (which subsumes most of it); worth it only if A
stops short of the reference lines.

**F. Quieter polls outside market hours.** Crypto is the only mover at night and on weekends: a
15-minute crypto cadence then (product choice) cuts the rebuilds by 3x where A-B do not reach.

Suggested order: B and C (small, independent), then A starting with the daily series, then D;
E and F only if measurements after A still call for them.

### 5. Daily views

- Reference lines on Pasivos (`dailyReferenceLines.ts`): each «Disponible» source group's daily
  series is built per `days` key — build each source once over full history and slice it per
  Rango; 3y and full then share one build.
- Mortgage daily marks (7 s / 25 s): trace the depto mark per day; make it one pass over the
  ledger and the UF series instead of a lookup per day.
- Cache the serialized JSON of large daily payloads (the 548 KB / 1,4 MB responses are
  re-stringified on every request).

### 6. Transport

- gzip/brotli responses (`compression` middleware): ~548 KB → ~60–80 KB for the daily series;
  matters most on the phone over Tailscale.

### 7. Keep requests from queueing behind heavy work

Even after phases 2–5, a cold build or a warm pass blocks every other request for its duration.

- Short term: the warmer yields between units of work (it already does per scope) and pauses
  while a user request is in flight.
- Longer term: move cache building to a `worker_threads` worker with its own read-only SQLite
  connection, so request handlers only read finished results. Check better-sqlite3 in worker
  threads under the production process (Vitest saw segfaults at worker teardown, which is a test
  harness issue but must be ruled out).

## Targets

| Path | Now | Target |
| --- | --- | --- |
| Warm reload of `/liabilities` (Diario, 3y) | ~6,8 s | < 1,5 s |
| Same page, first load after a price tick | up to ~12 s | < 2 s |
| Pasivos daily, uncached (3y / full) | 49 s / 124 s | < 10 s / < 20 s |
| Any page, after a deploy (cold) | 30–35 s | warmed before the first visit |
