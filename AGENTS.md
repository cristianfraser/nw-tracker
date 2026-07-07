# Agent notes (nw-tracker)

## Language and i18n

- **Code in English**: identifiers, comments, commit messages, and TypeScript/React source should be written in English.
- **UI copy in Spanish**: user-facing strings belong in `client/src/i18n/locales/es.json` only. Do not hardcode Spanish (or English) labels in components except via `t('…')` / `i18n.t('…')`.
- **Translation keys in English**: use dotted paths such as `dashboard.cards.netWorth`, `brokerage.groups.mutual_funds`. Code identifiers use English slugs (`mutual_funds`, `real_estate`); Spanish labels live in `es.json`.
- **Shared labels**: use helpers in `client/src/i18n/index.ts` (e.g. `brokerageGroupLabel`) so the sidebar, dashboard cards, and charts read the same keys.
- When adding UI text, add the key to `es.json` first, then reference it from code. Migrate existing hardcoded strings when touching an area.
- **Enforced by `npm run check:conventions`** (root; also runs at the end of root `npm run typecheck`): flags accented Spanish in client string literals/JSX (comments exempt), `Intl.NumberFormat` outside `format.ts`, and hardcoded-locale `toLocaleString` without date options. Escape hatch: `// convention-ok: <reason>` on the line.
- **Number formatting**: all numbers (CLP, USD, UF, units, percents) share one decimal-separator convention from `client/src/numberFormatPreference.ts` (localStorage `nw-tracker.decimalSeparator`, seeded from the IANA timezone; toolbar toggle overrides). Always format via `client/src/format.ts` helpers — never `Intl.NumberFormat` / `toLocaleString` with a hardcoded locale for numbers (dates stay `es-CL`). A separator change re-renders (not remounts) the tree via `AppTree`; **do not cache formatted strings** in `useMemo`/state unless `decimalSeparator` is in the deps — memoize raw numbers and format at render time.

## Fail fast — no runtime fallbacks

- **Fix data, don’t paper over it**: missing links, mismatched totals, ambiguous parse fields, and inconsistent imports are data or pipeline problems. Repair imports, migrations, or source files — do not add runtime fallbacks, `try/catch` swallowing, or “best guess” edge-case branches to keep the UI green.
- **Throw on mismatch**: when parsing, importing, or reconciling two sources (e.g. statement vs ledger, cert vs units, card breakdown vs NAV), invalid or inconsistent input should **throw** (or return a hard error to the client). Do not return `null`, `0`, empty arrays, or alternate code paths as silent defaults.
- **Avoid fallbacks**: no filename/statement-date guesses when a canonical field is required; no alternate formulas when the primary calc fails; no `catch { return fallback }`. Existing docs (e.g. CC matrix month = `period_to` only) follow this rule — extend it to new code.
- **Legitimate exceptions**: user-facing validation messages, optional UI features that are truly optional by product design, and infrastructure retries (network, file locks) — not business-logic substitutes for bad DB state.

## Personal data pipeline (cfraser) — see PARSERS.md

Docs for the personal import pipeline — credit-card PDF parsing quirks, cuenta-ahorro
forensic deposits, DAP ledger, Fintual certificado — live in **untracked `PARSERS.md`**
(gitignored, imported by CLAUDE.md; main checkout only, like the `cfraser/` data it
documents). If missing, restore from `~/Documents/backups/nw-tracker/`.

## CC chart / Pasivos convention

**"owed on that date", not billing-month totals.** Per-card chart lines, the Pasivos group Total, `accountMarkClpAtYmd`, and the net-worth dashboard Pasivos line all read stored `valuations` for historical dates (live billing balance for today) via `latestCreditCardValuationRowAsOf`; there is no separate "Saldo pasivos" ref line (removed — Total carries the same series). The month-end points `upsertCreditCardValuationsFromLedger` writes are billing-detail `balance_total` = owed-at-cierre (the `− cuota a pagar next mes` term de-dups the cuota counted in both facturado and cupo) + post-cierre window activity (charges +, PAGOs −) — evidence-based, re-synced after web-paste repairs in `mergeCcAccountFromParsedRows`. Facturación framing lives only in facturaciones views (`Detalle por mes`, `Historial`). **Months after the open facturación are plan-only projections** (`projected: true` rows from `appendProjectedBillingDetailRows`): facturado is null (nothing billed yet) and saldo = remaining cuotas del plan — nothing mirrors the open month forward — and `latestBillingDetailRow` skips projected rows so the live «Balance total» / today's Pasivos point stays the open-month rolled balance.

## Global sync scheduler

- In-process scheduler (`server/src/globalSyncScheduler.ts`): polls every 15 minutes **only while any source is stale**; when all are fresh, stops polling and wakes at the earliest source `next_sync` wall time.
- **Crypto EOD** (`crypto_eod`): due from 23:55 Chile; `equity_daily` trade dates are **UTC** days. Source: CoinGecko daily USD (includes weekends; Yahoo skipped gaps). Due close = last **completed** UTC day at sync time (never the in-progress UTC calendar day). Stale carryover persists after midnight Chile until that day is in DB (see `cryptoEodDueUtcYmd` in `equityEodSync.ts`). Backfill: `npm run backfill:crypto-coingecko-eod -w nw-tracker-server`.
- Manual “Marcar desactualizado” calls `notifyGlobalSyncScheduler()` to start polling immediately.

## Live market quotes (intraday)

- **Scheduler** (`server/src/liveMarketQuotesScheduler.ts`): polls Yahoo on a fixed interval (default **5 min**). HTTP handlers read **`live_market_quotes` only** — no on-demand Yahoo from client requests.
- **Manual backfill:** `npm run live-quotes:sync -w nw-tracker-server`
- **Env:** `LIVE_QUOTES_SYNC_ENABLED` (default on), `LIVE_QUOTES_INTERVAL_MS` (default `300000`), `LIVE_QUOTES_RETENTION_HOURS` (default `48`), `LIVE_QUOTES_MAX_AGE_MS` (default `2 × INTERVAL_MS`).
- **EOD** (`stocks_nyse` / `crypto_eod` in global sync) still writes `equity_daily` after the close; live quotes are for intraday MTM / marquee / current-month P/L.
- **Cache invalidation:** same-connection sync writes don't bump `data_version`, so both the live-quotes poll (when a value actually changed) and `runGlobalSyncAll` (when a live run applied changes) call `invalidateMarketDataAggregations()` (`aggregationCache.ts`) — drops `account.monthly_perf|` / `group.consolidated_monthly|` / `group.valuation_closing_by_date|` / `dashboard.page_bundle|` (keeps `cc.billing_detail|`) and notifies the warmer. Otherwise dashboard bucket totals / overview live point stay pinned at cache-build-time prices while per-account rows track live marks (they read quotes fresh per request).
- **USD/CLP:** During NYSE regular session, scheduler fetches Yahoo **`CLP=X`** into `live_market_quotes`; MTM/marquee use that via `fxForLiveMtm`. After **17:30 Chile**, all CLP↔USD conversions read Yahoo CLP=X EOD in **`fx_daily`** (NYSE trade dates; synced by `yahoo_fx_usd`). Banco Central dólar observado is stored separately in **`fx_daily_bcentral`** (reference only; synced by `sbif_usd` from 18:00 Chile). Backfill: `npm run backfill:yahoo-fx-usd -w nw-tracker-server` (conversions) and `npm run backfill:sbif-fx-eur -w nw-tracker-server` (BCentral reference + EUR).

## Equity / crypto tickers (`accounts.equity_ticker`)

- Yahoo symbols (e.g. `SPY`, `OILK`, `BTC-USD`, `CFIETFIPSA.SN`) live on **`accounts.equity_ticker`**, set at **`import:excel`** or **panel stock create** — not parsed from `notes` or asset-group slug at runtime.
- Read via `equityTickerForAccount` / `requireEquityTicker` in `server/src/accountEquityTicker.ts`. Equity-MTM accounts without a ticker should throw (fix the `accounts.equity_ticker` data; the one-time backfill migration 089 was squashed into the schema baseline).
- Marquee / stock EOD sync: `listDistinctEquityTickersForSync()` / `listWatchlistStockTickersForEodSync()` from DB. `notes` remains import provenance only (`import:excel|key=…`, `import:panel|…`).
- **Watchlist multi-year anchors (3y/5y/10y):** the per-request backfill only reaches ~400 days. Deeper history for all watchlist equity/crypto tickers (top-level + RN proxy constituents, `.SN` skipped): **`npm run backfill:watchlist-equity-history -w nw-tracker-server`** (default 11y Yahoo; `--years N`, `--dry-run`; drops the in-progress UTC day for crypto so only completed EOD is stored). Ran 2026-07-03 (Yahoo depth reaches ~2015-06). UF / FX history for the same anchors: `npm run backfill:bcentral-uf` (BCentral, needs `BCENTRAL_*` creds) and `npm run backfill:yahoo-fx-usd` — both fill from `portfolioStartYmd` (2016-05-31).

## Quote currency / Santiago (`.SN`) tickers

- **`equity_daily` stores `close` + `currency` ('usd' | 'clp')** (migration 152); `live_market_quotes` rows are `kind='equity'` + `currency`. Writers stamp `equityQuoteCurrency(ticker)` (`server/src/equityQuote.ts`, single source of truth: `.SN` → clp, else usd); readers **throw on stored-currency mismatch** — fix rows, don't coerce.
- **`.SN` = Bolsa de Santiago = `EquityMarketKind "santiago"`**: session = Chile calendar day (live window ≈ 09:30–17:05 Chile weekdays); EOD display = latest bar ≤ Chile today (on-or-before absorbs Chilean holidays).
- **MTM**: clp-quoted → `value_clp = units × close`, **no fx** (`computeEquityMtmClp`, `equityBrokeragePositionMeta`, `ccInvestmentProxy`, `marketSeries` derives `equity_usd = close / clp_per_usd`). USD composites throw if a clp ticker sneaks in (`watchlistComposite`).
- **EOD sync**: `.SN` piggybacks the `stocks_nyse` source (Santiago closes before NYSE) but is **excluded from `equityNyseEodCaughtUp()`** — a Chilean holiday must never mark `stocks_nyse` stale. NYSE-only list: `listWatchlistNyseTickersForEodSync()`.
- **CLP-funded trades**: `stock_buy`/`stock_sell` on a clp-quoted stock transfer against **CLP cash** with `amount_clp` (no `amount_usd`; enforced in `validateBrokerageTransferEndpoints`). They count as `clp_wire` capital flows (`equityBrokerageCapitalFlows`) and the funding CLP-cash leg feeds the aportes line (`accountDeposits`). `dividend_payout` stays USD-only (throws for clp stocks until needed).
- Client: account summary / detail-bundle expose **`equity_quote_currency`**; the stock movement form shows Monto CLP + CLP-cash counterpart for clp-quoted tickers (`stockQuoteCurrencyForTicker`, `brokerageFlowKindNeeds{Clp,Usd}ForQuote`).
- Yahoo has **no EOD history for `CFIETFIPSA.SN`** before 2026-07-02 (bars accumulate from there onward); on-or-before quote lookups tolerate the gaps. Older history: **`npm run backfill:bolsa-santiago-eod -w nw-tracker-server`** pulls daily closes per `.SN` ticker from the Bolsa de Santiago point-history API — up to ~10 years, capped at the instrument's listing date (`server/src/equityBolsaSantiagoEod.ts`; run 2026-07-03, filled CFIETFIPSA.SN 2025-05-12 → 2026-07-02 = full history since its Mayo 2025 inception).

## Deferred: value + currency refactor

**Goal (decided 2026-07):** reduce per-currency *code branching* with straightforward `amount` + `currency` splits where the new shape propagates through readers — not storage-pattern consistency for its own sake. A DTO/derived field named `value_clp` that is definitionally a CLP display value is **not** a violation (most of the ~360 `value_clp` string hits are this); the convention targets DB storage plus parallel `_clp`/`_usd` logic branches. Storage precedent: `equity_daily` / `live_market_quotes` (migration 152) — readers select `value` + `currency` and **throw on unexpected currency**, never coerce. Migrate opportunistically when touching an area — no big-bang renames.

Tranche status, by measured surface:

- **`valuations` — phase 1 done (migration 154):** `value` + `currency` (always 'clp' today); every reader selects both and throws on non-clp via `assertValuationCurrencyClp` (`server/src/valuationValue.ts`) — grep those calls to find the sites phase 2 must widen. Phase 2 (separate, optional): store USD-cash valuations natively in USD and convert at read via `fxMonthEndForBalanceUsd` — removes the fx-at-write coupling that forced the "zero USD balance without fx_daily row" special case. DTO field names stay `value_clp` (definitionally CLP after the guard).
- **`movements.amount_clp/amount_usd` — the monster (847 + 223 non-test hits, 86 files;** heaviest: `flowsCheckingGastos`, `movementUnitsPolicy`, deposits reconciliation). Strictly opportunistic; many rows legitimately carry both legs (fx conversions), so this needs its own design pass, not a mechanical split.
- **`cc_billing_month_balances` + `credit_card_account_config.cupo_*` — folded into the future multi-currency-card (EUR) project;** do not do standalone. Both are metric-pairs where CLP and USD coexist per row, so a split only reshapes storage while the loader pivots back to the wide DTO (no code propagation). The EUR project's critical path is elsewhere: `statementSlotsByBillingMonth`'s literal `{clp, usd}` slot model → per-currency map, `cc_statement_lines.amount_clp/amount_usd` (note `amount_orig` + `orig_currency` already exist), and EUR conversion helpers over `eur_daily` (`clp_per_eur`, synced by `sbif_eur` — today a reference series read only by rates display). Long-table plan for the balances snapshot when that project lands: `cc_billing_month_metrics(account_id, billing_month, as_of_date, as_of_kind, metric, currency, amount, UNIQUE(…, metric, currency))`; single writer choke point `recomputeCcBillingMonthBalances` (full per-account DELETE+rebuild — the table is a derived cache), single reader `listCcBillingMonthBalances` pivoting back to `CcBillingMonthBalanceRow`; only other raw access is a column-agnostic DELETE in `ccConsolidatedCards.ts`.
- **`payroll_work_earnings` — líquido split done (migration 153):** `liquido` + `liquido_currency` ('usd' for Deel wires, 'clp' otherwise). The DTO keeps `liquido_clp`/`liquido_usd`; for usd rows the CLP equivalent derives at read as haberes − descuentos (the stored breakdown was converted at wire date, so the identity is exact). The remaining `_clp` columns are line-item metrics of a liquidación (units labels, not currency branching) and stay.

## Historical mirror pairs + movement search

- **Mirror pairs** (`/panel/mirror-pairs`): two pre-transfer-model single-leg rows (retiro + same-amount depósito on different accounts, inflow 0–5 days after outflow) are converted into one transfer row dated the **outflow day**; original legs (ids, dates, amounts, units, notes) live in the `mirror-merge|…` note (embedded `|` encoded as `¦` so tag-scanning readers can't false-match) and conversion is undoable (`undoMirrorConversion`). Candidates: `listMirrorPairCandidates` (`server/src/movementMirrorPairs.ts`) — high confidence = unique both directions + within the cartola business-day window (`bankDateMatchesTransferDate`) + no month straddle; checking-inflow month-straddle pairs are hard-blocked (cartola anchors). Excluded legs: flow_kind/USD legs, both-legs-cuotas, dap either side, afp/afc **inflows** (pre-tax payroll), deposits already in `expense_deposit_links`/`checking_gap_deposit_mirrors`/`payroll_work_earnings`, Buda/ahorro-split notes. Rejections persist in `movement_mirror_pair_rejections` (migration 155; ids cascade on full rebuilds). **Link-established pairs**: 1:1 `expense_deposit_links` rows (auto/manual, `checking-cartola:` keys resolved via `movementForCheckingPurchaseKey`, amounts equal) surface as `linked: true` high-confidence candidates — the link is the evidence, no window applies; the link row cascades away at conversion. Multi-allocation/partial links, synthetic links, and Buda-note deposits stay out. One transfer carries one `units_delta` (abs; cuota readers use `transferLegUnitsThroughDate`). **Month-precision legs** (cuenta_ahorro_vivienda — sheet records mm-yyyy only; movements dated conventional month-end): the pairing window is the whole month ± 7 days across the boundary (`monthPrecisionPairAllowed`) instead of the day-gap rule, the bank-window requirement is waived, and the converted transfer takes the **real-day (checking) leg's date** — so cartola re-import dedupe matches same-day and checking anchors are untouched (the checking-straddle hard-block is skipped when the out leg is month-precision). `import:excel --force-wipe` and `rebuild:cuenta-ahorro` delete `mirror-merge|` transfers touching wiped accounts (re-import re-inserts the legs; pairs reappear as candidates — re-convert via the panel). Conversion is balance- and aportes-neutral for same-month pairs; converted cartola credits leave the income pool (a correction) and mirror-merge transfers into checking self-resolve in the deposits reconciliation.
- **Movement search lives in the flows tables** (the standalone `/search` page was removed; `/search` redirects home). `FlowsTable`'s filter bar carries the full set — year/type/account/category, `q` (note + account + counterpart + flow-type label), `date_from`/`date_to` (inclusive), `amount_exact` XOR `amount_min`/`amount_max` (rounded |amount_clp|; exact disables min/max) — on every consumer: the **net-worth dashboard is the master view** (`/api/groups/net_worth/flows`), plus group and account pages. Shared filter logic: `applyFlowFilters` + `parseExtraFlowsFilterParams` (`server/src/flowsApi.ts`), parsed by both flows routes in `routes/dashboard.ts`. Scope is **movements only** — CC purchase lines live in `cc_statement_lines` and are searched from the Expenses page.

## XLSX export (account / group pages)

- **Exportar** button (account detail toolbar + `GroupInfoBase` toolbar) → modal (range presets incl. per-year, section checkboxes, CLP/USD) → `GET /api/accounts/:id/export.xlsx` / `/api/groups/:slug/export.xlsx` (`from`/`to` = inclusive YYYY-MM, `sections=closings,aportes,pl,movements`, `unit=usd` optional). Builder: `server/src/exportWorkbook.ts` (SheetJS; one sheet per section, Spanish sheet titles, raw numeric cells). Sections reuse `getAccountMonthlyPerformance` (Cierres + P&L), `getMergedDisplayDepositInflowEventsForAccount` (Aportes — withdrawals are negative rows; `acumulado` runs over full history then range-filters), `listAccountMovementsForApi(Bulk)` (Movimientos). Group export = per-member-account rows with a `cuenta` column (`listAccountsForGroupTab`, synthetic ids filtered). Client: `ExportToolbarButton` (`client/src/components/export/ExportModal.tsx`) + `downloadFile.ts` (blob download, filename from Content-Disposition).

## Projections (/projections)

- `GET /api/projections` (`server/src/projections.ts`, pure engine `runProjectionEngine`): one **real** (today's-money) trajectory in the display unit — accumulation to age 65 (born 1992-01 → retiro 2057-01; invested compounds monthly + aporte, RE/cash hold real value flat), then three drawdown strategies over the **drawdown pot** = invested + `liquidate_other_pct`% of the non-invested remainder (default 0 — FIRE framing; 100 ≙ total NW, anything between = partial RE sale at 65) to `end_age`. `monthly_rent_clp` (today's money) adds passive income to every strategy; the fixed-income strategy targets TOTAL income so its pot only funds `target − rent` (SWR fixed-real %, % of current balance, fixed real monthly income; depletion ages in `summary`). The invested trajectory is emitted as its own projected line (`proj_invested`). Nominal line derives from the real path with the unit's inflation — both currency views share the trajectory (independent nominal paths would drift). Defaults: aporte = trailing-24m personal deposits into retirement+brokerage; base = last `getDashboardOverviewBlock` point; params clamped by `PROJECTION_PARAM_BOUNDS` (400 outside). USD milestones (250k–2M) as constant reference columns; CLP view converts at today's fx (`fxRowOnOrBefore` — throws if `fx_daily` empty).
- Client `ProjectionsPage` (`/projections`, sidebar link `projections` seeded by `seedNavTree`): number inputs display server-resolved params, overrides persist in localStorage `nw-tracker.projections.overrides` (empty = server default; Restablecer clears); unit follows the global CLP/USD toggle; chart = AppLineChart with dashed reference lines.

## Net-worth portfolio tree (`portfolio_groups`)

- **Single nav tree** from `net_worth`: sidebar and group pages use `portfolio_group_items` (`accountIdsInPortfolioGroup` in `server/src/portfolioGroupTree.ts`).
- **`group_kind`**: `bucket` (routable leaf/hub with accounts), `nav_bucket` (sidebar only — home cards use children with `dashboard_bucket_slug`), `liability_group`, `reference`.
- **`kind_slug`**: behavior id (`afp`, `cuenta_corriente`, …) on leaf buckets — prefer `kindSlugForAccount` / `accountKindSlugForAccountId` over parsing `__` from slugs.
- **`accounts.primary_portfolio_group_id`**: deepest portfolio link (migration `098_…`); set by `seedNavTree` / `import:excel`.
- **API**: prefer `?portfolio_group=retirement_afp_afc` on `/api/accounts`, valuation TS, consolidated tables. Legacy `?group=&subgroup=` resolves via `resolvePortfolioGroupSlugForLegacyTab`.
- **Home bucket cards**: `getDashboardLayoutCards()` unwraps `nav_bucket` under `net_worth` (e.g. `inversiones` → brokerage + retirement; `cash_eqs` hub → `cash_savings` card only).
- **Bucket totals**: sum accounts via `accountIdsInPortfolioGroupForTotals(portfolio_group_slug)` — not per-account `dashboard_bucket_slug` tags. `portfolio_groups.slug` / `kind_slug` are stable node ids and behavior keys, not parsed `__` heuristics.
- **Panel / nav / dashboard** all use the same tree: `GET /api/meta/sidebar-nav` → `net_worth` (`portfolio_groups` + `portfolio_group_items`). `/api/meta/asset-tree` is legacy `asset_groups` (deprecated; do not use in new UI).

## Data provenance (`DataOrigin`)

API payloads must **not** use top-level `source: "db"` / `"csv"` — the client always reads SQLite. Provenance describes how data entered the system:

| Layer | Field | Examples |
|-------|--------|----------|
| Account | `accounts.notes` | `import:excel|key=mortgage`, `credit_card_master|santander|<last4>`, `import:panel|ticker=QQQ|key=…` |
| Row | DTO `origin` | `import_document`, `manual` (from `cc_installment_purchases.source`: `pdf` → `import_document`) |
| Market data | (future) | `api_sync` / `api_yahoo` for `equity_daily` |

Shared type: `server/src/dataOrigin.ts` (`import_document` \| `manual` \| `api_sync`).

## Import sources vs runtime

**Rule:** files under `cfraser/` are **import inputs only**. HTTP, dashboard, valuation, and sync read **SQLite**; missing data → error or “run import”, not a silent file fallback.

- **Depto:** runtime reads the **movement ledger only** — `loadDeptoLedgerFromMovements()` (property-account movements + `uf_daily`; notes carry the full payment row via `buildDeptoDividendosMovementNote`). `depto_dividendos_sheet_rows` is import/manual-entry **staging** (spreadsheet master mirror), written at `import:excel` and by `mortgagePaymentCreate` — never read on request paths. Manual-payment recompute rewrites BOTH the staging row and the movement notes. No `suecia_snapshot`: the dashboard RE card synthesizes valor/hipoteca from the property + mortgage account rows (same path as the demo).
- **CC installments:** `import:cc-parsed` / PDF → `cc_installment_*` / `cc_statements`; no runtime CSV.
- **Account identity:** keep `accounts.notes` (`import:excel|key=…`, card master notes) — do not add a separate `import_key` column.
- **Per-card CC behavior is config, not code:** consolidation redirects, superseded masters, and statement-classification tokens load from gitignored `cfraser/cc-cards.json` via `server/src/ccCardRegistry.ts` / `server/scripts/cc_cards.py` (missing file = empty registry — demo/CI). Tests always use the committed synthetic `server/src/test/ccCardsFixture.json` (`NW_TRACKER_CC_CARDS`, set in `vitest.config.ts`); never hardcode real card last4s in code or tests. Real values + shape: PARSERS.md.
- **Fintual / crypto:** `accounts.fund_series_key` and `equity_ticker` set at `import:excel` (APV-a flow kinds come from certificado movement notes + `|medio=…`, not a CSV override file).

Runtime code must not use `fs.readFile*` / `readSemicolonCsv` on `cfraser/` except in `server/scripts/` and import helpers. Import-sync document coverage (`GET /api/import-sync/…`) may list files for admin tooling only.

## Server runtime modes (local vs hosted demo)

One binary, env-driven (`server/src/httpSecurity.ts`, root `.env` loaded at boot):

- **`HOST`** — bind host; default `127.0.0.1` (keeps the unauthenticated local API off the LAN). Hosted demo (Render) sets `HOST=0.0.0.0`.
- **`CORS_ALLOWED_ORIGINS`** — comma-separated allowlist; defaults to Vite dev/preview origins (`localhost:5173`/`4173`). Never use a reflect-any-origin CORS config — any website could read the API.
- **`AUTH_PASSWORD`** — when set, every `/api` route (except `/api/health`) requires HTTP Basic auth: username must be a **syntactically valid email** (format check only) + this shared password (recruiter-demo model). Authenticated emails are logged to **`demo_auth_logins`** (one row per email+day, with first/last seen and request_count). Unset = local mode, no auth, no logging.
- **`DB_BACKUP_ENABLED` / `DB_BACKUP_KEEP` / `DB_BACKUP_DIR` / `DB_BACKUP_DIR_KEEP`** — daily auto-snapshot of the DB while the server runs (`dbBackupScheduler.ts`; default on, keep 14 local `auto-daily` snapshots, optional second copy dir keeping 60). `DB_BACKUP_DIR` points at `~/Documents/backups/nw-tracker` (set in root `.env`). Manual `npm run db:snapshot` labels are never pruned.
- **`CACHE_WARM_ENABLED`** — proactive dashboard cache warmer (`dashboardCacheWarmer.ts`; default on, `0` disables). Rebuilds the page-bundle caches in the background at boot, at 00:05 Chile (day-rollover clear), when `data_version` shows an external write, and debounced (30s) after in-process invalidations — so no interactive request pays a cold aggregation build. The warmed object itself is the served response (`dashboard.page_bundle|<unit>` in the aggregation cache), not just its inner aggregations. CC billing detail lives in the aggregation cache (`cc.billing_detail|<accountId>`; day/data_version fresh + invalidated by CC write hooks), not rebuilt per request.
- Express async route handlers must be wrapped in `asyncHandler` (defined in `index.ts`) — Express 4 does not forward async rejections, and an unhandled rejection kills the process. A terminal error middleware turns route throws into JSON 500s.

## Hosted demo (Render)

Single Render web service (blueprint: **`render.yaml`** at the repo root) serving synthetic data behind the shared-password auth above. Local mode is untouched — everything is env-gated.

- **`DEMO_MODE=1`** (`server/src/demoMode.ts`, runs at boot after `loadRootDotenv()`): requires `NW_TRACKER_TEST_DB` to point at a dedicated demo file (throws otherwise — demo mode can never open the real `nw-tracker.db`); when that DB has no accounts, boot generates the `demo` preset via `generateDemoDb` (same as `server/scripts/generate-demo-data.ts --preset=demo`). Render free-tier disks are ephemeral, so every cold start / deploy regenerates the demo from current source — it always matches the deployed code. Demo mode also defaults `GLOBAL_SYNC_ENABLED` / `LIVE_QUOTES_SYNC_ENABLED` / `DB_BACKUP_ENABLED` to `0` (explicit env wins); the cache warmer stays default-on so first paint is warm.
- **`SERVE_CLIENT_DIST=1`** (`server/src/staticClientDist.ts`): the API server serves the built client (`client/dist`) with an SPA fallback for non-`/api` GETs — one service, same-origin, no `CORS_ALLOWED_ORIGINS` needed. Hashed `/assets` are cached immutable; missing assets 404 (never the SPA fallback); `index.html` is `no-cache`. Fails fast at boot if `client/dist/index.html` is missing (`npm run build -w nw-tracker-client`). The auth middleware also covers static responses — that 401 is what triggers the browser's Basic-auth prompt on first visit.
- **`render.yaml`**: build = `npm install --include=dev` (Render sets `NODE_ENV=production`, which would skip devDeps) + client build; start = `npm run serve -w nw-tracker-server` (**tsx from source** — the compiled `dist/` would not ship `server/migrations/*.sql`); health check `/api/health` (exempt from auth); `PORT` injected by Render.
- **Deploy:** Render dashboard → New → **Blueprint** → connect this repo (picks up `render.yaml`) → set the `AUTH_PASSWORD` secret when prompted (`sync: false`, never in the repo). Recruiters log in with any syntactically valid email + that password; logins land in `demo_auth_logins`. ⚠️ **Keep the GitHub repo private until history is squashed** — the current tree is free of personal data (balances/amounts purged 2026-07-07; account/contract numbers and card last4s live in gitignored `cfraser/*.json` configs; tests use synthetic cards), but pre-2026-07-07 blobs in git history still carry card last4s. Going public = squash to a fresh initial commit (or publish a clean snapshot repo) at that point.
- **Domains (Namecheap `crfrsr.io`):** blueprint requests `nw-tracker.crfrsr.io` on the web service (paid `starter` plan — no cold-start spin-down) and `crfrsr.io` + `www.crfrsr.io` on the **`crfrsr-homepage`** static site (`homepage/index.html`, landing page linking poketeam + nw-tracker; build copies `about.html` in as `/about.html`). Namecheap Advanced DNS: delete the old crfrsr.io → poketeam URL-redirect record, then `ALIAS @` → homepage `.onrender.com` host (or `A @ 216.24.57.1`), `CNAME www` → same host, `CNAME nw-tracker` → the nw-tracker-demo `.onrender.com` host; the existing `poketeam` CNAME stays. Render auto-issues TLS once DNS verifies.
- **Local rehearsal:** `.claude/launch.json` `server-demo`/`client-demo` (ports 3210/5210), or boot the exact prod shape: `PORT=… DEMO_MODE=1 SERVE_CLIENT_DIST=1 NW_TRACKER_TEST_DB=/tmp/demo.db AUTH_PASSWORD=… npm run serve -w nw-tracker-server` after a client build.

## Schema baseline (fresh DBs)

`initSchema()` executes `server/src/schemaBaseline.ts` — the full schema dumped from the live DB (as of migration 155), all `IF NOT EXISTS`. On a brand-new DB it marks migrations ≤ 155 as pre-applied. **Migrations ≤ 155 were squashed into the baseline 2026-07-07 and their files deleted** (personal-data ones also purged from git history; copies of everything live outside the repo in `~/Documents/backups/nw-tracker/{removed,squashed}-migrations/`). The only pre-baseline files kept are the 8 reference-row seeds in `BASELINE_REFERENCE_DATA_MIGRATIONS` (db.ts) — idempotent category/uniqueness seeds the schema-only baseline skips, which still run on fresh DBs. A recorded-but-missing file is harmless to the runner (the live DB keeps all 155 ids in `schema_migrations`), so numbering gaps are expected; new migrations start at 156 and apply normally everywhere. When squashing again: `npx tsx scripts/regenerate-schema-baseline.ts --last <newest-migration>` (from `server/`), then delete the newly-covered files (keep the reference seeds). Migration SQL is naively split on `;` (no string-literal lexing) — no triggers or `;`/`--` inside literals; use a post-migration hook in `db.ts` for those.

## Server verbose logging

- **`DEBUG_VERBOSE=1`** — enables all channels below (stderr).
- **`DEBUG_HTTP=1`** — `[api] -->` / `[api] <--` for every incoming Express request (method, path, status, ms).
- **`DEBUG_HTTP_OUT=1`** — `[http-out]` for outbound `fetch` (BCentral, Yahoo, uno.cl, Quetalmi, Fintual sync).
- **`DEBUG_DB=1`** — `[db]` for SQLite `prepare`/`exec` slower than **`DEBUG_DB_SLOW_MS`** (default 20). **`DEBUG_DB_ALL=1`** logs every statement.
- **`DEBUG_PERF=1`** — `[heavy] …ms` for labeled expensive work (`server/src/heavyWork.ts`).

## Dashboard performance profiling

- **`npm run profile:dashboard`** (from `server/`): sequential timings for dashboard builders on the test/dev DB (`NW_TRACKER_TEST_DB` or default `server/data/nw-tracker.test.db`).
- **`DEBUG_PERF=1`** (or **`DEBUG_VERBOSE=1`**) on the server logs `[heavy] …ms` spans for labeled work (`server/src/heavyWork.ts`) during HTTP requests.
- Home page: **`GET /api/dashboard/page-bundle`** — one client call replaces the old 5-way fan-out. The whole bundle response is served from the aggregation cache (`dashboard.page_bundle|<unit>`, built by the warmer; cached value is the in-flight promise so concurrent cold requests share one build). Every explicit invalidation drops it — `invalidateCcBillingDetail` and `invalidateMarketDataAggregations` are the two funnel points — so a warm request is ~5ms; only requests landing in an invalidation→rewarm gap pay the full build.
- Nav strip (sidebar / group pages): **`GET /api/dashboard/nav-context`** — accounts + liabilities + overview in one call (client fetches only on group/liabilities routes and account detail when the nav node has routable children; home uses `page-bundle` only).
- Dominant cost is usually the portfolio-group totals aggregation inside **`getDashboardValuationTimeseries`** / **`getGroupValuationTimeseries`**; `@heavy` marks those entry points in source.

## Server Vitest (SQLite)

- Vitest uses **`server/data/nw-tracker.test.db`**, never `nw-tracker.db`. Both are gitignored (`server/data/*.db`).
- **`NW_TRACKER_TEST_DB`** is set in `server/vitest.config.ts` (`test.env`) and in the server **`npm run test`** script so it is present before `db.ts` loads.
- **`server/src/vitest.globalSetup.ts`**: when `nw-tracker.test.db` is missing, generates the **lean synthetic preset** (`generate-demo-data.ts --preset=test`) — tests must not depend on personal data. Delete `nw-tracker.test.db` to rebuild; the file is never refreshed automatically, so a stale pre-synthetic dev-DB copy on disk silently keeps being used (symptom: suites failing on missing `demo:*` fixture accounts or real-data invariants — delete the test DB). Escape hatch: `NW_TRACKER_TEST_FROM_DEV=1` copies the local `nw-tracker.db` instead (reproducing an issue against real data).
- **`server/src/vitest.setup.ts`** → **`server/src/test/vitestDbSeed.ts`**: ensures an isolated Santander CC master `credit_card_master|santander|vitest-fixture` (never a real card) for merge/import tests.
- Override the test file with `NW_TRACKER_TEST_DB` (absolute path, basename under `server/data/`, or `:memory:`). Vitest uses `pool: "forks"` with one sequential fork (`fileParallelism: false`) — better-sqlite3 segfaults nondeterministically in worker threads at teardown, killing the run after a few files; parallel forks would race migrations on the single SQLite file.
- To remove Vitest fixture rows from **`nw-tracker.db`** (e.g. after running tests against the wrong DB): `sqlite3 server/data/nw-tracker.db < server/scripts/cleanup-cc-vitest-pollution.sql`.

## UI tables — desktop/mobile sync

Tables in the client have parallel desktop and mobile renderings. The desktop version uses `<td className="desktop-only">` columns; the mobile version uses `<TableMobileCard>` / `<TableMobileCardRow>` inside a `<td className="mobile-only">`. When adding, removing, or reformatting a column on one, apply the identical change to the other. Both variants are usually in the same component or a companion file (e.g. `CreditCardSections.tsx` + `CreditCardPurchaseMobileCard.tsx`).

## Git commits

When creating commits for this repository, do **not** append `Co-authored-by: Cursor`, `Co-authored-by: …`, or any other co-author trailer unless the user explicitly asks for it.
