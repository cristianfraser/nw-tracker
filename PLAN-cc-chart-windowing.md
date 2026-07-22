# Plan: unified range window for the CC account-page charts (D/M/Y)

> Handoff plan, self-contained. Written 2026-07-22 after the daily-historial work landed
> (commits `575f534`, `72cfa78`, `0a2e7f4` — read their messages for context). Committed as
> a working document — delete it in the commit that implements it.

## Problem (verified on the real DB)

Card `santander ·7817` (account 32) has evidence starting **2024-11-27**. On its account
page (`client/src/pages/accountDetail/CreditCardAccountDetailPage.tsx`):

1. **Daily view obeys the Rango selector but not the data start.** With `5y` selected,
   `GET /api/daily-series?account_id=32&days=1827` returns 1,827 calendar days of which the
   first **1,224 are leading nulls** — the historial chart's category x-axis draws them all,
   so two-thirds of the chart is dead space.
2. **Monthly/Yearly views obey the data start but ignore Rango.** The 2026-07-21 client-side
   M/Y range clip went into `LineChartPanel` + `MonthlyPerformanceComboChart` only; the
   CC-specific charts (`CcInstallmentHistoryChart`, `CcBillingMonthFinancingChart`) never
   consult `timeRange` and always render the account's full history.
3. **Right edges differ.** The monthly historial extends past today into the installment
   plan simulation (projected plan-only rows, see the "pay-frame" convention in AGENTS.md's
   CC section); the daily view ends at today because the daily grid ends at today.

## Target spec (user-decided, exact)

For **all three period modes** of the CC page charts, the visible window is:

```
[ max(range_cutoff, history_start − 0.2 × range_span) , max(today, plan_end) ]
```

- `range_cutoff` = the Rango selector's left edge (`timeRangeCutoffYmd` in
  `client/src/timeRange.ts`; `total` ⇒ no cutoff).
- `history_start` = first date/month with any drawn data (daily: first row where either
  line is non-null; monthly: first historial row with data).
- **20 % leading gap**: when the range reaches further back than the data, keep an empty
  lead of `0.2 × range_span` before `history_start` as the truncation indicator, but never
  extend past the range itself. Worked examples (from the user): 5y range with 3y of data
  ⇒ show 4y (1y empty); 5y range with 4.5y of data ⇒ show the full 5y (0.5y empty).
  For `total` there is no truncation ⇒ **no gap**, start at `history_start`.
- `plan_end` = end of the installment simulation (last scheduled pay-by / last projected
  month). The monthly historial already ends there; daily must be extended to match. The
  financing chart has no simulation ⇒ its right edge stays its own last data month.

The daily x-axis must cover the **same window** as the M/Y views of the same chart
(aligned domains across the D↔M↔Y toggle).

## Implementation sketch

### Server — daily plan tail (new)

The daily payload must extend past today for CC masters.

- `server/src/ccInstallmentDebtDaily.ts` already builds per-day plan debt from events
  (+contract on `purchase_date`, −billed cuotas on `facturaciones.pay_by_iso`, fallback
  10th of next month). Extend the route enrichment in `server/src/routes/dashboard.ts`
  (account_id branch, `cc_installment_debt` block) to also return a **future tail**, e.g.:

  ```ts
  cc_plan_tail?: { as_of_date: string; plan_debt_clp: number; balance_clp: number }[]
  ```

  covering `today+1 .. plan_end`. `plan_end` = the last pay-by event date (the events list
  already contains future facturaciones — `billingDetailCacheForAccount(id).detail`
  includes projected rows; their pay-bys land in the future and are currently inert).
  Only step days need to be dense enough for the chart — emitting every calendar day is
  simplest and matches the grid; size is bounded (~18 months).
- **Future `balance_clp` convention:** must reproduce the monthly projected rows at month
  ends (pay-frame identity in AGENTS.md: *chart month-end M = calendar-table row M's cuota
  + `debt_after_clp`*; a cycle's cuotas — and the open facturado — leave the debt on their
  pay-by, not at the close). Baseline: `balance = plan_debt + open-facturado amount while
  `d <` its pay-by`. Acceptance test: the daily tail's value at each projected month-end
  equals the monthly historial's projected `balance_total_clp` for that month.
- CLP only (the historial chart is CLP-native in every mode).
- Unit tests: extend `server/src/creditCardChartSeries.debtDaily.test.ts` (pure builder
  with future dates) and add a small route/enrichment test if practical.

### Client — shared window helper

New helper (suggest `client/src/chartRangeWindow.ts`, or extend `client/src/timeRange.ts`):

```ts
/** Left edge: max(range cutoff, first-data − 20% of the range). Null = no clip (total). */
export function rangeWindowStartYmd(
  range: TimeRange,
  firstDataYmd: string | null,
  todayYmd?: string
): string | null
```

- `range_span` in days = `timeRangeToDays(range)`; gap = `round(0.2 × span)` days.
- `total` ⇒ return `firstDataYmd` (no gap) or null.
- Unit-test the worked examples above.

### Client — apply to the three CC chart consumers

All in `CreditCardAccountDetailPage.tsx` (pre-clip the rows; keep the chart components
mostly dumb):

1. **Daily historial rows** (`dailyHistorialRows` memo): append the server plan tail as
   rows (`cupo_en_cuotas_clp: plan_debt`, `balance_total_clp: balance`), then slice the
   leading rows to `rangeWindowStartYmd(range, firstNonNullDate)` — rows between the
   window start and `firstNonNullDate` stay as the empty gap.
2. **Monthly historial rows** (`historialChartRows`): clip to the same boundary using
   month keys (`row.month >= boundary.slice(0, 7)`); first-data month = first row with any
   non-null `cupo_en_cuotas_clp`/`balance_total_clp` or `installment_payments_clp > 0`.
   **Clip before the yearly rollup** (the component rolls up in yearly mode —
   `rollupCcHistorialChartYearly`), so yearly shows the rollup of the clipped window.
3. **Financing chart points** (`financingChartPoints`): same left clip by
   `billing_month`; no right extension.

Optional nice-to-have: in daily mode add a "today" `ReferenceLine` on the historial chart
marking where the simulation starts (the monthly mode already marks the open billing
month). New i18n key if added.

### i18n / docs

- Any new user-visible string goes through `client/src/i18n/master.json` (en+es) +
  `npm run i18n:generate -w nw-tracker-client`; never hardcode Spanish in components
  (`npm run check:conventions` enforces).
- Update `accountDetail.creditCard.historialHintDaily` to mention the projected tail.
- Update AGENTS.md's CC daily bullet (the "CC per-day owed + daily extras" bullet) with the
  window rule + plan tail, and the memory file
  `/Users/crfrsr/.claude/projects/-Users-crfrsr-Projects-nw-tracker/memory/project_daily_period_view.md`.

## Repo ground rules (do not skip)

- **Tests:** always `cd server && npm run test` — NEVER `npx vitest` from the repo root
  (wrong DB; destructive). Client: `npm run test -w nw-tracker-client`. Also run
  `npm run check:conventions`.
- **Client displays server data:** the projected tail and its balance convention are built
  server-side; the client only zips rows.
- **Fail fast:** no runtime fallbacks/guesses; throw on inconsistent schedule data.
- Verification servers: `.claude/launch.json` `server-alt` (3299) / `client-alt` (5299),
  both `BACKGROUND_JOBS_ENABLED=0`, sharing the real DB. The dev servers may NOT hot-reload
  reliably — restart `server-alt` after server edits. The in-app browser pane can fail to
  mount recharts; verify data via the API and DOM paths, not only screenshots.
- Commits: lowercase subject, body explains why, **no co-author trailers**.

## Acceptance checklist

1. `·7817` + Rango `5y`, Diario: x-axis starts ≈ 2023-11 (1y empty lead before the
   2024-11-27 data), ends at the plan end (≈ 2027-12), lines ramp/step correctly; the
   future segment's month-end values equal the monthly projected rows.
2. Same card, Rango `Todo`: starts flush at first data (no gap).
3. Rango `90d`: unchanged from today's behavior on the left; right edge now extends to
   plan end.
4. Mensual and Anual historial + financing obey Rango with the same window; yearly is the
   rollup of the clipped window.
5. D↔M↔Y toggle keeps the same x-window for the historial chart.
6. Server suite (~250 files), client suite (~296 tests), conventions: all green.
