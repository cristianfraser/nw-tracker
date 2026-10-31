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

**A. Rebuild only today's part of a dropped payload.** (Done 2026-10-31 for the card billing detail, the daily series, the ledger monthly rows and the valuation series' past marks; see «A-F as built» below.) A dropped entry is rebuilt whole, on top of
the history tier. Split the expensive builders into a past part (every day / month before today,
cached like the history tier: survives ticks, dropped by writes and historical data) and a today
part recomputed per tick: daily series = cached past points + today's point; monthly payloads =
cached closed months + the current-month row; valuation series = cached past points + live last
point (`patchAccountLiveLastPoint` already isolates it). Expected: the three Pasivos rebuilds
(~1,9 s) to well under 0,3 s, and the same on every page during the fx day, which is the case
phases 3-4 do not help. Risk: the past part must never read today (the history-tier rule);
parity tests per builder against a whole build. Largest change; do it builder by builder,
starting with the daily series (biggest and simplest: the grid already ends at today).

**B. One dashboard row per account, cached with its own dependencies.** (Done 2026-10-31: `account_row|<id>|<unit>` over a shared `account_rows_ctx|<unit>`.) `account_rows|<unit>`
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
*Done 2026-10-31* (`jsonResponse.ts`, see AGENTS «JSON responses are serialized once and
compressed»): cached response objects keep their bytes, ETag and gzip/brotli forms in a WeakMap
keyed by the object; every `/api` JSON body of 1 KB or more is compressed. Synthetic demo DB, warm
hits, median of 20 over loopback:

| Request | Identity | gzip | brotli | Before (identity) | After (identity / gzip) |
| --- | --- | --- | --- | --- | --- |
| `daily-series?portfolio_group=liabilities&days=1096` | 366 KB | 27 KB | 17 KB | 4,1 ms | 0,9 / 0,5 ms |
| `daily-series?portfolio_group=liabilities&days=0` | 982 KB | 74 KB | 31 KB | 6,8 ms | 1,5 / 0,5 ms |
| `daily-series?portfolio_group=net_worth&days=0` | 3,3 MB | 506 KB | 458 KB | 29,6 ms | 3,8 / 1,7 ms |
| `dashboard/page-bundle` | 648 KB | 67 KB | 62 KB | 4,5 ms | 1,5 / 0,4 ms |
| `dashboard/nav-context` | 90 KB | 11 KB | 10 KB | 1,1 ms | 0,9 / 1,0 ms |

Compressing a 982 KB body costs gzip 1 ~5 ms, gzip 6 ~10 ms, brotli 1 ~1 ms, brotli 5 ~6 ms: cached
payloads pay gzip 6 / brotli 5 once per build, uncached ones gzip 1 / brotli 1 per response.

**E. Reference lines from their own cached parts.** (Done 2026-10-31 for the valuation series: each source's totals are a cached group-response part; the daily reference lines already read each source's own cached daily series.) The Pasivos valuation and daily series rebuild
the liabilities' own lines when only the «Disponible» sources moved. Keep the host's own lines
and each source's lines as separate cached parts and assemble on read, so a coin tick recomputes
the brokerage source only. Smaller gain than A (which subsumes most of it); worth it only if A
stops short of the reference lines.

**F. Quieter polls outside market hours.** (Not implemented: a product decision; numbers below.) Crypto is the only mover at night and on weekends: a
15-minute crypto cadence then (product choice) cuts the rebuilds by 3x where A-B do not reach.

Suggested order: B and C (small, independent), then A starting with the daily series, then D;
E and F only if measurements after A still call for them.

### A-F as built (2026-10-31, SYNTHETIC: demo preset DB, Linux sandbox, 4 cores)

Measured with `server/scripts/measure-pasivos-tick.ts` (in-process server on a copy, background
jobs and warmer off, clock shifted to a trading afternoon; the eight Pasivos requests one after
another; medians of 3-5 rounds; other jobs shared the CPU, so ±15 %). Intel / real-DB numbers
are still to be taken by a local session.

| Pasivos, one after another | Before (cae189c) | After |
| --- | --- | --- |
| cold | 5,4 s | 2,5 s |
| warm | 36 ms | 38 ms |
| after a coin-only tick | 321 ms | 228 ms |
| after a tick that moves the dollar | 1,33 s | 0,40 s |
| `meta/sidebar-nav` after a dollar tick | 856 ms | 32 ms |
| `valuation-timeseries?portfolio_group=liabilities` after a coin tick | 116 ms | 47 ms |
| `daily-series?…liabilities&days=1096` after a coin tick | 55 ms | 35 ms |

What each piece did (one commit each):

- **Card billing detail (A).** Profiling the rebuild after a dollar tick showed ~90 % of it was
  not the daily series at all: group pages order their rows by today's value, a card reads its
  balance through its billing detail, and the whole detail went with every dollar tick because an
  unpaid facturación prices its dollars live. The bundle is now a base part (ledger payload,
  detalle, facturaciones without rates; dependency-tracked, so it survives a dollar tick) plus the
  rates applied on top; a card's statement list (read thousands of times per build) is memoized in
  the history tier. Four full-history group daily series rebuilt per dollar tick: 1348 -> 389 ms.
- **Daily series (A).** The past part of `getBucketDailySeries` (per-account values in the unit on
  every day but today, flow legs, deposit cumulatives, market-day flags) lives in the history tier
  (`daily_series_past`), built under `buildHistoryTierValue`, which throws if a history-tier part
  reads any live input. Deposit-event buy rates memoized too. 389 -> 273 ms.
- **Ledger monthly rows (A).** The closed months' rows of checking / cash / book accounts are kept
  (`ledger_closed_month_rows`); only the current month's row is rebuilt. 273 -> 178 ms.
- **Valuation series (A).** A plain account's raw mark on a past chart date is memoized
  (`valuation_chart_past_raw_clp`). Not under the guard: an equity's past MTM consults the
  live-dollar gate (`fxForLiveMtm`) even for a past day, though it reads the stored close; the
  existing `equity_mtm_clp` memo relies on the same rule. Coin-tick rebuild of the Pasivos
  valuation series 95 -> 80 ms.
- **Reference sources (E).** Each «Disponible» source's totals are a cached part; 122 -> 91 ms.
- **B** (per-account rows), **C** (warmer steps aside for in-flight requests), **D** (JSON
  serialized once, gzip/brotli): see their entries above and their commits. On synthetic data B
  shows little (most of a row's cost was already in the history tier); the real DB has more rows.

Parity: `liveTickIncrementalRebuild.test.ts` now runs four ticks (unscoped every price + dollar,
scoped every price + dollar, a ticker nothing reads, and a coin-only tick on a Bitcoin account it
adds), each comparing every payload with an empty-cache rebuild at the same frozen instant and
asserting the kept parts; `requestPathCaches.test.ts` adds the statement memo (writes inside and
outside a transaction, frozen rows); `cacheDependencies.test.ts` the history-tier guard.

What is left, from the profiles:

- **Freshness checks.** Every history-tier memo access runs `ensureCacheFreshForChileDay` (two
  SQLite statements); in a rebuild after a tick that is ~35-40 % of the time. One combined statement
  did not help (it is per-execution overhead). Reducing the number of accesses (fetch a memo map
  once per build loop instead of per value) is the next cheap win; skipping the check within a
  synchronous turn would need a way to see same-connection writes.
- **The dollar gate on past days.** `fxForLiveMtm` and the equity gates report a live read even for
  a past date; with that split (report only when the date can use the live row) the valuation memo
  could run under the guard, and a dollar tick would stop dropping entries that only read past
  marks (B's agent saw nearly every dashboard row read the dollar gate).
- **The nav tree** (`buildNavForest`) is rebuilt per call (~14 ms each, several per page).
- **nav-context** after a tick (~110-180 ms synthetic): bucket totals, the overview block and the
  value map, which read today's values of every account.

F, numbers only (not implemented): with the 5-minute off-session cadence a night has 12 coin
ticks an hour; each drops what reads the coin, and the warmer then rebuilds the bundles and visited
pages (the Pasivos requests alone cost ~0,23 s synthetic per tick after A-E, vs ~0,32 s before).
A 15-minute crypto cadence at night would cut that 3x (4 ticks an hour); the price shown would be
up to 15 minutes old instead of 5.

### Profile after A-F (2026-10-31, SYNTHETIC demo DB, merged main ad59046)

Pasivos one after another: cold 2,5 s, warm 42 ms, coin tick 206 ms, dollar tick 375 ms. What is
left after a tick is mostly `nav-context` (89 ms coin, 196 ms dollar) and the Pasivos valuation
series (49 / 72 ms); cold, the daily series (1,2 s), nav-context (0,6 s) and the sidebar (0,36 s).
CPU profiles of those rebuilds (in-process, clock on a trading afternoon) show five causes, in
order of size:

1. **Freshness checks on every memo access — ~38 % of a nav-context rebuild after a tick, ~18 % of
   a cold build.** Every `getAggregationCached` / `historyTierMemo` / `liveTierCached` call runs
   `ensureCacheFreshForChileDay`: two SQLite statements (the mark-input log's `MAX(id)` and
   `PRAGMA data_version`), each O(1), ~2 µs, but ~15 000 of them per nav-context rebuild. 80 %
   come from `accountMarkClpAtYmd`'s `account_marks` memo, asked once per account and date inside
   loops. Merging the two statements into one saved nothing (per-execution overhead). Options:
   (a) skip the check when it already ran in the same macrotask and this connection wrote nothing
   since — a JS counter bumped by a wrapper on `Statement.run` / `Database.exec` catches every
   same-connection write; a write from another connection inside one synchronous turn reads as if
   it had arrived a moment later, which is already the case between turns; (b) hoist the memo map
   out of the hot loops (fetch once per loop, as `pastDayUnitConverter` does). (a) removes nearly
   all of it with one change; (b) is local and safe but has to be repeated per loop.
2. **Per-account constants read by SQL on every call — ~13 % of a cold build.**
   `portfolioGroupBySlug` (via `accountBucketKindSlug`), `bucketSlugForAccountId` (via
   `isClpCashAccount`, `isUsdCashAccount`, the equity MTM), `accountUsesCryptoMtm`: each a
   statement per account per day. Their tables (accounts, asset_groups, portfolio_groups) are
   mark-input tables, so a history-tier memo (or a per-process map dropped with it) is exact.
3. **The nav tree is rebuilt on every call — ~11 % of nav-context after a tick.**
   `getNavChartGroupNodeBySlug`, `getNetWorthNavGroupNode` and `getLiabilitiesNavRootNode` re-read
   groups, items and account names and rebuild the forest each time (several times per request,
   via `orderGroupTabRowsBucketMajor` and the snapshot). It reads chart-inactive flags, which read
   no price for units-valued accounts; caching it as a tracked entry (page-bundle lifetime, API
   writes drop it) keeps it across most ticks.
4. **`accountChartInactive` and `listAccountsForGroupTab` are uncached.** Chart-inactive runs per
   account per caller (`finishGroupTabRows`, the nav tree, the snapshot), and for ledger accounts
   reads the month closes; the group-tab row list is re-ordered by today's value on every call.
   Both fit a tracked entry per account / per group: dropped by a tick only when they read a
   moved price.
5. **After a dollar tick nearly every dashboard row rebuilds (47 ms of the 157 ms)**, although
   peso accounts do not move with the dollar: the live-dollar gates (`shouldUseLiveFxQuote`,
   `fxForLiveMtm`) report a read even for a past date or a peso-only path, so B's per-row entries
   all depend on the dollar. Reporting only when the answer can depend on the live row (the date
   is the live row's session or later — the post-midnight window where yesterday's session row is
   still live included) would let the peso rows survive; it would also let the valuation-chart
   past-mark memo run under the history-tier guard. Needs a parity test per gate.

Cold builds remain dominated by building the per-account mark series (`buildRange`, ~1,5 s of the
cold Pasivos daily series, its reference sources included) — the warmer's job, or a worker thread
(phase 7). Items 1-2 also shorten every cold build.

Suggested order: 1 (largest, one change, needs a careful write-detection test), then 3-4 (small,
tracked entries), then 5 (gate semantics, needs parity tests), then 2.

### The profile's fixes, benchmarked (2026-10-31, SYNTHETIC demo DB, Linux sandbox, 4 cores)

Each fix was measured against the commit before it with `scripts/measure-pasivos-tick.ts`
(5 rounds, medians) run three times alternating between two checkouts, plus in-process rebuild
timings. Noise is ~10 % run to run, so a single run decides nothing; what stayed below that was
dropped.

| Fix | Pasivos cold | coin tick | dollar tick | Kept |
| --- | --- | --- | --- | --- |
| 1. Freshness checked once per synchronous stretch unless this connection wrote (`dbWriteCounter.ts`) | ~2470 → ~2000 ms | ~220 → ~200 | ~365 → ~306 | yes |
| 2. Statements shared per SQL text (in `db.ts`; not in the profile, found after fix 1) | ~2020 → ~1620 | ~190 → ~145 | ~308 → ~245 | yes |
| 3. Nav trees memoized until the database changes (`dbStateMemo.ts`) | unchanged | ~136 → ~113 | ~236 → ~201 | yes |
| 4. Per-account lookups (movement bounds, ticker, crypto flag, bucket, card flag, live-close meta, card group) and month-end dates memoized | within noise | within noise | ~192 → ~167 | yes |
| `accountChartInactive` memoized | within noise | within noise | within noise | no |
| `listAccountsForGroupTab` memoized | — | — | — | no: its rows read live figures (the memo's guard refused it) |
| 5. `fxForLiveMtm` reports no live read for a date no fresh row can match | within noise | within noise | ~183 → ~164 (daily series rebuild ~75 → ~64) | yes |

All together, against e38a76e: Pasivos cold ~2510 → ~1310 ms (−48 %), coin tick ~219 → ~108
(−51 %), dollar tick ~373 → ~162 (−57 %). In-process rebuilds after a tick: Pasivos valuation
~76 → ~26 ms (coin) and ~124 → ~50 (dollar), nav-context ~94 → ~26 and ~138 → ~41, the Pasivos +
net-worth daily series ~108 → ~56 (dollar). Cold builds: sidebar ~545 → ~388 ms, nav-context
~1095 → ~578, the Pasivos daily series ~1970 → ~1210.

- **Fix 1** wraps every statement better-sqlite3 does not report as read-only (and `exec`) when
  it is prepared, counting this connection's writes; the check reruns in the same stretch only
  after one. Another connection's commit inside a stretch is seen at the next microtask.
- **Fix 2:** many readers call `db.prepare` inside the function that runs the query, and
  compiling cost more than running. A shared statement never changes: `pluck` / `raw` /
  `expand` / `safeIntegers` / `bind` return a private copy, and a statement still iterating is
  not handed out again (`dbSharedStatements.test.ts`).
- **`dbStateMemo`** (fixes 3-4): a result of the database alone, kept until this connection
  writes, another commits or the Chile day turns; not inside a transaction (a rollback undoes
  writes without a new one), frozen, and a build that reads a live input throws.
- **F (crypto cadence) stays unimplemented:** at ~0,11 s of Pasivos rebuild per coin tick, the
  5-minute crypto cadence costs ~1,3 s an hour; 15 minutes would save ~0,9 s an hour.
- One full-suite run failed `ccInstallmentLedgerDb.test.ts` «persists a today valuation equal to
  the live balance» once; it passed alone 16 times and in the next two full runs.

### 5. Daily views

- Reference lines on Pasivos (`dailyReferenceLines.ts`): each «Disponible» source group's daily
  series is built per `days` key — build each source once over full history and slice it per
  Rango; 3y and full then share one build.
- Mortgage daily marks (7 s / 25 s): trace the depto mark per day; make it one pass over the
  ledger and the UF series instead of a lookup per day.
- Cache the serialized JSON of large daily payloads (the 548 KB / 1,4 MB responses are
  re-stringified on every request). *Done 2026-10-31, see D.*

### 6. Transport

- gzip/brotli responses (`compression` middleware): ~548 KB → ~60–80 KB for the daily series;
  matters most on the phone over Tailscale. *Done 2026-10-31 with `node:zlib` (no dependency), see D.*

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
