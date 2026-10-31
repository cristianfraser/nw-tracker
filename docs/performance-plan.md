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
| Pasivos, one after another, after a crypto-only tick (no warmer) | 6,4 s | 2,4 s |
| First Pasivos + ·0781 visit after a boot warm | 6,1 s | 0,23 s |
| cc-ledger, warm | 1,3 s | 5 ms |
| ·0781 account bundle | 1,64 MB, 156 ms warm | 169 KB, 8 ms |
| Brokerage page endpoints, all at once, warm | 431 ms | 50 ms |

What a crypto tick still rebuilds on Pasivos: nav context (0,8 s, every account's today value),
the valuation series and daily series (the «Disponible» lines include the brokerage), each on
top of the history tier. The four group endpoints already shared the per-account rows; what each
re-ran was the group consolidation (~90 ms), now cached once. Not done: a quieter crypto cadence
(product choice); rebuilding only the reference lines of a Pasivos payload.

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
