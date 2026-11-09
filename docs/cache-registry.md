# Cache registry (F2, 2026-11-07)

One store for every cached aggregation and API payload (`server/src/cacheRegistry.ts`), each key in
a family declared once in `server/src/cacheFamilies.ts`, and one write signal: the change log
(`mark_input_changes`, filled by triggers — `server/src/markInputTriggers.ts`).

## How a write reaches the caches

1. Triggers log every write, in whichever connection made it:
   - **mark rows** (`kind = 'mark'`): a table a historical mark reads, with the account (none = every
     account) and the raw date. The newest trigger spec of the table carries its trim rule
     (`backDays`, `recentDays`, `rateTable`); a source without a spec throws.
   - **write rows** (`kind = 'write'`): any other change of a logged table (an update only when a
     column changes). Tables not logged are machine bookkeeping: `UNLOGGED_TABLES_270`.
2. The registry applies the log before any cached read (when this connection wrote, or
   `data_version` says another did), after every API write (`index.ts`, request kinds `api-write`
   and `machine`) and on the warmer's minute poll. Mark rows trim the per-account mark series
   (`markSeriesStore.ts`); then each family drops what read the change, and the warmer is notified.
3. Market writers of this process add a notice (`invalidateMarketDataAggregations`); the live-quote
   poll and the dimming watch publish through `publishLiveInputChange` (client stamp + drop).
4. A value no table holds is a declared input: `dropFamiliesWhenInputChanged` (the flows inputs and
   the live dollar rate the expense lines priced unpaid dollars at).

Inside a transaction the log is applied (a read after a write sees it) but not committed: entries
built inside it are dropped when it ends, and its mark trims replayed (a rollback hands its log ids
out again). A read path that rewrites derived rows runs in `withoutChurn` (`rederivation.ts`): a
savepoint rolled back when the rows come out the same, so it logs nothing.

## Families

Every family drops on any mark row (an account-scoped one only for the named accounts, and the
accounts declared trimmed together — `declareAccountsTrimmedTogether`, the depto ledger).
`valuation` families also drop on a write row of any logged table but `EXPENSE_METADATA_TABLES`;
`any` families on every write row.

| family | prefix | reads | scoped | historical | live tick | tx | response |
|---|---|---|---|---|---|---|---|
| history | `hist.` | valuation | | ✓ | keep | bypass | |
| daily_series | `daily.series\|` | valuation | | ✓ | affected | | |
| daily_series_response | `daily.series\|response\|` | any | | ✓ | affected | bypass | ✓ |
| daily_overview | `daily.overview\|` | valuation | | ✓ | affected | | |
| net_worth_ath | `daily.overview\|ath\|` | valuation | | ✓ | affected | | |
| daily_reference_sources | `daily.refsrc\|` | valuation | | ✓ | affected | | |
| depto_ledger | `depto.ledger\|` (`depto.ledger\|rows\|<property id>`, one per property) | valuation | | | keep | | |
| cc_billing_detail | `cc.billing_detail\|` | valuation | ✓ | | affected | | |
| cc_billing_parts | `cc.billing_parts\|` | valuation | ✓ | | keep | | |
| cc_ledger | `cc.ledger\|` | any | | ✓ | affected | bypass | ✓ |
| account_monthly_perf | `account.monthly_perf\|` | valuation | ✓ | ✓ | affected | | |
| group_consolidated_monthly | `group.consolidated_monthly\|` | valuation | | ✓ | affected | bypass | |
| group_closing_by_date | `group.valuation_closing_by_date\|` | valuation | | ✓ | affected | | |
| home_bundle | `dashboard.page_bundle\|` | any | | ✓ | affected | bypass | ✓ |
| account_detail_bundle | `…\|account_detail\|` | any | | ✓ | affected | bypass | ✓ |
| group_responses | `…\|group\|` | any | | ✓ | affected | bypass | ✓ |
| sidebar_nav | `…\|sidebar_nav` | valuation | | ✓ | affected | | |
| dashboard_overview | `…\|overview\|` | valuation | | ✓ | affected | | |
| dashboard_account_rows | `…\|account_row` | valuation | | ✓ | affected | bypass | |
| dashboard_account_rows_list | `…\|account_rows\|` | valuation | | ✓ | affected | bypass | ✓ |
| dashboard_nav | `…\|nav_` | valuation | | ✓ | affected | bypass | ✓ |
| flows_overview | `flows.overview\|` | any | | ✓ | affected | | |
| flows_inputs | `flows.overview.inputs\|` | any | | ✓ | keep (+ live dollar input) | | |
| checking_balance | `checking.balance\|` | valuation | ✓ | | keep | | |

The longest matching prefix decides a key's family; a key in no family throws. The live tier
(`liveTierCached`, per UTC minute) and `dbStateMemo` (database state, cleared by any write of this
connection and by the registry's epoch) sit beside the store.

## Adding a cache or a table

- A new cache: add its family to `CACHE_FAMILIES` and a key builder; build through
  `getAggregationCached`. No invalidation call anywhere.
- A new table: a migration adds its write triggers (and, if a historical mark reads it, a mark spec
  with its trim rule); `cacheRegistry.test.ts` fails on a table in neither list.
