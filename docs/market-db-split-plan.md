# Market database split

Status: plan, nothing built (2026-11-19).

## Goal

Move the tables that are true for everyone (prices, rates, indices, the instrument registry,
reference rows) out of the one SQLite file into a second file, `market.db`, that the server's
one connection attaches. The main file keeps everything a person owns. Nothing changes for the
user: same pages, same numbers, same sync.

Why: it is the first step toward several people over one market (the demo's extra fictional
people first), it makes the market/person boundary explicit and checked, and it lets the demo
ship its market as a file.

Not in this plan: several people in one process, `user_id` columns, Postgres. The last section
lists what a second person still needs after the split.

## What was checked (2026-11-19, test DB at the current schema: 161 tables, 486 triggers, no views)

- Unqualified table names resolve across attached files (main first, then attach order), and
  nothing in `server/src` qualifies a market table. Queries, joins and the ~100 test files that
  write market rows keep working unchanged.
- A trigger in one file cannot read or write a table in another (checked on a scratch
  in-memory DB: «no such table: market.log»). Market tables carry 72 triggers that write
  `mark_input_changes` in main; `equity_daily` and `equity_splits` also read `accounts`, and
  `equity_daily` reads `watchlist_composite_holdings`.
- No trigger on a person table mentions a market table.
- Foreign keys cannot cross files (the write fails, it is not ignored). No person table
  references a market table. Six market columns reference `currencies(code)`.
- `PRAGMA data_version`, `.backup()` and `VACUUM INTO` are per file. Cache freshness
  (`cacheRegistry.ts`), snapshots (`dbSnapshot.ts`) and the demo pristine copy see main only.
- A commit spanning both files is atomic per file, not across a crash. One transaction writes
  both sides today: recording a stock split (`equitySplits.ts`, the split row and price rescale
  plus `stock_split` movements).
- `ingest/` never opens the database.

## Decisions

1. **File and env.** `NW_TRACKER_MARKET_DB`; default is the main file's sibling
   `<main basename>.market.db` (`nw-tracker.market.db`, `nw-tracker.test.market.db`,
   `nw-tracker.demo.market.db`). A `:memory:` main attaches a `:memory:` market. Under Vitest and
   `DEMO_MODE` the market file must be derived from, or named beside, the dedicated main file —
   never the real one (same guard as the main path). `db.ts` attaches it as `market` right
   after opening, before `initSchema`, and sets WAL on it. `dbSnapshot.ts` resolves both paths
   through the same function.
2. **Tables in `market.db`** (the list lives in one constant, `MARKET_DB_TABLES`, and a check
   fails when a table of either file is unclassified):
   - prices and rates: `equity_daily`, `equity_dividends`, `equity_splits`, `fx_daily`,
     `fx_daily_bcentral`, `fx_daily_bid_ask`, `fx_daily_yahoo_rejected`, `fx_rates`,
     `eur_daily`, `uf_daily`, `utm_daily`, `ipc_daily`, `ipc_official_monthly`,
     `fund_unit_daily`, `pension_fund_unit_official`, `live_market_quotes`;
   - instruments: `market_symbols`, `market_symbol_fetch_errors`, `watchlist_composite_meta`,
     `watchlist_composite_holdings`, `watchlist_composite_positions`,
     `watchlist_composite_position_holdings` (one fund's public basket; moving them keeps the
     `equity_daily` trigger's basket test inside one file);
   - reference: `payroll_parameters`, `payroll_afp_rates`, `art107_instruments`, and a copy of
     `currencies`.
   Staying in main although they look market-like: `market_display_series` (the person's
   watchlist), `benchmarks` (personal rates and portfolio-group slugs), `broker_instruments`,
   `option_contracts`, `cc_expense_categories`, `vendor_catalog`, `account_sync_sources`.
3. **`currencies` lives in both files.** Both copies are seeded from one constant; boot throws
   when they differ. Person tables keep their reference to main's copy, market tables reference
   the market copy. A new currency is one change to the constant plus a migration on each track.
4. **Changes are logged inside `market.db` and resolved per reader.** `market.market_changes
   (id, source, key, raw_date, kind, created_at)`, written by plain triggers in `market.db`
   (so any connection, script or `sqlite3` repair logs). `key` is the ticker, series key or
   pair. A reader tails it with its own cursor next to the main log's cursor
   (`applyChangeLog`), and turns an `equity_daily` / `equity_splits` row into its holders from
   its own `accounts` (plus every account when the ticker is in the basket) in TypeScript.
   `ensureCacheFresh` compares both files' `data_version`; `dbStateMemo` reads both max ids.
   Same pruning rule on both logs (a reader whose next row was pruned drops everything).
   Not TEMP triggers: they fire only for the connection that made them, and could never reach a
   second person's file.
5. **Schema: a second migration track.** `server/market-migrations/` + `market.schema_migrations`
   + a market baseline generated from the tables' current shape (`regenerate-schema-baseline.ts`
   learns `--market`). The market file describes itself, so a copied or downloaded `market.db`
   carries its version. The existing main migrations are not edited.
6. **Existing databases move their rows once.** A main migration with a hook: for each market
   table still in main, replace the market copy's rows with main's and drop the main table; the
   main copy is the authority until it is dropped, so a crash between the two files' commits
   re-runs cleanly. A fresh database goes the same way (the main baseline still creates the
   tables, the migration moves them empty) until the next baseline squash removes them. Runs
   with foreign keys off (`FOREIGN_KEYS_OFF_MIGRATIONS`). The before-deploy snapshot is taken
   while main still holds the tables, so restoring it undoes the move.
7. **A split is two writes.** The market side (split row, price rescale) commits in
   `market.db`; each holder's `stock_split` movements are written from the split row on the
   person side, idempotently. No other transaction needs both files.
8. **Snapshots are pairs.** `<stamp>-<label>.db` and `<stamp>-<label>.market.db`, taken one
   after the other (market first; a market file newer than its main is harmless). Retention,
   the second-folder copy, `verify-db-backup` and the daily «already taken today» check treat
   the pair as one snapshot. `NW_TRACKER_TEST_FROM_DEV` and the «snapshot copy» dev workflow
   copy both.

## Phases

Each phase lands on `main` on its own and leaves the home server working (it deploys from
`main` within minutes). Phases 1–3 change no file layout.

### 1. The boundary, named and checked
- `MARKET_DB_TABLES` (+ the classification of every other table as person or operational) in
  one module; `DEMO_MARKET_TABLES` becomes a subset by construction.
- A test fails on an unclassified table and on a trigger or foreign key that crosses the
  boundary in a direction the plan does not allow (today's known crossings listed as the
  starting baseline, shrinking to none by phase 4).
- Done when: the check runs in `npm run test` and lists exactly the crossings found above.

### 2. Market change log by key (still one file)
- `market_changes` table and triggers for the market tables, replacing their
  `mark_input_*` / `write_log_*` triggers; two cursors in `applyChangeLog`; holders resolved in
  TypeScript; `cacheRegistry.test.ts` and the trigger-name checks follow.
- Done when: the cache tests pass, and on a rehearsal copy a price row written by a separate
  process (a script, then `sqlite3`) trims the same accounts' series and drops the same
  families as before the change.

### 3. Writes that straddle the boundary
- The split recorder writes the ledger rows from the split row (decision 7).
- `server/data/.global-sync-state.json` splits into market sync state (stored beside the market
  file) and the person's (Fintual goals poll, forced-stale flags).
- Trace the ingest handlers for any that write a market table inside the receiver's
  transaction (not yet traced); separate those the same way.
- Done when: phase 1's check lists no transaction or trigger that needs both sides.

### 4. The file
- `db.ts`: path resolution, attach, WAL, guards; market baseline + migration track; the
  move-out migration; `currencies` copy and its boot check; second `data_version`.
- Schema enumerators take a schema: trigger reinstall and lookup (`markInputTriggers.ts`,
  `tableTriggerReinstall.ts`), `countAllTables` / `assertOnlyMarketTablesChanged`,
  `regenerate-schema-baseline.ts`, `vitest.globalSetup.ts`, `test/tempCardMaster.ts`.
- Snapshots as pairs (decision 8), `server-deploy.sh`, `db:snapshot`, `db:prune-snapshots`,
  `db:verify-backup`.
- Demo, minimum: the pristine copy and reset cover main only (attach `market` before
  `pristine`), `render.yaml` removes both files before generating, the JSON artifact loads into
  the attached tables as today.
- Tests: the test DB's market file is its sibling; `globalSetup` generates or copies both.
- Rehearsal before merging: run the move on a copy of the newest home-server snapshot
  (`server-rehearsal`), compare the page bundle, nav snapshot, three group pages and three
  account bundles in CLP, USD and EUR byte for byte against the same build on the unsplit
  copy; time the move; `integrity_check` on both files.
- Done when: the home server has deployed it, both files exist, main holds no market table,
  the nightly sync and the next snapshot pair are clean.

### 5. The demo's market is a file
- The home server publishes `market.db` itself (compressed) in place of the JSON export;
  Render downloads it as the demo's market file. Removes the JSON export/import, the column
  checks and the row-by-row load from the build. The publish scratch database becomes a market
  file with an empty main.
- Done when: a demo release builds from the published file and the synthetic-market path
  (`--test`) still generates both files.

### 6. Rules and notes
- AGENTS.md («Server runtime modes», «Schema baseline», «Server Vitest», «Import sources vs
  runtime»), `.claude/rules/demo-ops.md`, `.claude/rules/market-data.md`,
  `.claude/rules/valuation-series.md` (the daily cache's trim rules), CLAUDE.md's test warning,
  `.claude/launch.json` (demo and rehearsal servers).

## Risks

- **The move-out on the home server** is the one irreversible step; it is covered by the
  before-deploy snapshot and rehearsed on a copy first (phase 4).
- **A stale market file beside a newer main** (restored snapshot, hand-copied file) reads old
  prices without failing. The market migration track catches schema drift, not data age; the
  existing fx-coverage and sync-staleness surfaces are what show it.
- **Scripts and repairs** that opened the database file directly (not through `db.ts`) will
  not see market tables. Known: `verify-db-backup.ts`, `regenerate-schema-baseline.ts`,
  `server-deploy.sh` (writes `app_messages`, main only, unaffected). Archive scripts are not
  migrated.
- **Not verified:** whether an unqualified `PRAGMA foreign_key_check` covers attached files;
  whether `writeSplitLedgerRows` is idempotent today; real-database sizes and the move's
  duration (the test DB's market tables are under 1 MB).

## After the split: what a second person still needs

Out of scope here; listed so the split does not paint over them.

- **Who decides what is synced.** The symbol set (holdings, watchlist, benchmarks, basket) and
  the history start are computed from one person's tables. A shared market needs the union,
  for example a subscriptions table in `market.db` that each person's file feeds.
- **Fintual goal series.** `fund_unit_daily` keys `fintual_cert_<goal>` are named after one
  person's goals, and the provisional daily bar is that person's valuation ÷ their share
  count. They need rekeying by public series id, with the person-derived bar kept on the
  person side.
- **One syncer.** Several processes over one market file must not each run the market sync;
  the per-file sync state from phase 3 is the seam.
- **Per-person market side effects**: the AFP step's spot `valuations` row, the split ledger
  rows (already separated in phase 3).
