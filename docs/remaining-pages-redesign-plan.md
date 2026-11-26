# Remaining pages redesign plan

Status: plan only, nothing implemented. Written 2026-11-25 against `origin/main` 050adcd6.

Between 2026-11-20 and 2026-11-25 most pages were redesigned one by one (mockups first, the
user picks, implementation, review). This document lists the routes that effort did not reach,
what is wrong with each today, which redesigned page it should take its look from, and a
proposed split into one-session work items.

## How the pages were judged

- Routes from `client/src/App.tsx`; the component behind each; `git log origin/main
  --since=2026-11-15` per page file.
- Every candidate opened in a local preview on the synthetic demo database (non-demo mode,
  `BACKGROUND_JOBS_ENABLED=0`) at 390px, measuring page height, tables, and whether the layout
  overflows the viewport; screenshots of the top of the worst ones.
- Limits: desktop (1440px) was judged from the code and one screenshot of `/real_estate`, not
  page by page; the demo data has one property, one mortgage, no usage log and no ingest runs,
  so `/panel/usage`, `/panel/notifications` and parts of `/panel/import-sync` were seen empty.
  Each work item starts with its own look at the page at both widths.

## Inventory

| Route | Component | State |
|---|---|---|
| `/` | `DashboardPage` (`DemoHomePage` wraps it on the demo) | redesigned |
| `/inversiones/*` | `GroupInfoPage` → `InvestmentGroupPage` / `BasketGroupPage` | redesigned |
| `/cash_eqs`, `/cash_eqs/savings`, `/cash_eqs/checking` | `GroupInfoPage` → generic `GroupInfoBase` | **old** (item C) |
| `/real_estate` | `GroupInfoPage` → generic `GroupInfoBase` | **old** (item A) |
| `/liabilities`, `/liabilities/mortgage`, `/liabilities/:subgroup` | `LiabilitiesPage`, `MortgageGroupPage`, `LiabilitiesGroupPage` | redesigned |
| `/account/:id` card | `CreditCardAccountDetailPage` | redesigned |
| `/account/:id` cuenta corriente / vista | `CheckingAccountDetailPage` | redesigned |
| `/account/:id` property, mortgage | `DeptoAccountDetailPage` | redesigned |
| `/account/:id` stock, coin, fund (AFP funds included) | `PositionAccountDetailPage` | redesigned |
| `/account/:id` everything else: APV, AFC, broker and exchange cash, foreign-currency checking | `StandardAccountDetailPage` | **old** (items B1, B2) |
| `/flows` | `FlowsOverviewPage` | **old**, mild (item J) |
| `/flows/income`, `/flows/expenses`, `/flows/expenses/groceries`, `/flows/expenses/real_estate[/:slug]`, `/flows/deposits`, `/flows/pl` | income, expenses, groceries, flows tables | redesigned |
| `/flows/deposits/reconciliation` | `DepositsReconciliationPage` | **old** (item E) |
| `/rates` | `RatesPage` | **old** (item D) |
| `/tax-return` | `TaxReturnPage`, `UsTaxReturnSections` | **old** (item G) |
| `/projections` | `ProjectionsPage` | **old** (item I) |
| `/wealth-percentile` | `WealthPercentilePage` | **old** (item I) |
| `/watchlist` | `WatchlistPage` | redesigned |
| `/panel/notifications` | `NotificationsPage` (messages table) | redesigned |
| `/panel/mirror-pairs` | `MirrorPairsPanelPage` | redesigned |
| `/panel/accounts` | `AccountsPanelPage` | **old** except its accounts tree (item H) |
| `/panel/import-sync` | `ImportSyncPage` | **old** except its message list (item F) |
| `/panel/usage` | `UsagePanelPage` | old, low value (item K) |
| `/panel/settings` | `SettingsPage` | residency form redesigned; the rest is two small blocks (item K) |
| `/privacy`, `*` | `PrivacyPage`, `NotFoundPage` | text pages, nothing to do |

## What is wrong, page by page

### A. `/real_estate` — generic group page

- Renders `GroupInfoBase`: a «Total» card and one card per account with Today / Month / Year /
  Total rows, then «Valuation and contributions», «Current value by account», «Δ by account /
  subgroup», «Monthly Δ (consolidated)», «Monthly detail», «Flows», «Accounts in this view».
  5,400px on a phone.
- With one property the «Total» card and the account card are the same four rows twice, and
  «Current value by account» is a value map of one tile.
- None of it is about property: no appraisal, no debt against it, no net equity, no loan-to-value,
  no rent or running costs. The property page, the mortgage page and `/liabilities/mortgage`
  each show a purpose-built glance for the same data, so the group page is the odd one of four.
- Look from: `MortgageGroupPage` (its asset-side twin) and the property page in
  `components/depto/`.

### B. `StandardAccountDetailPage` — every account without its own page

Two different kinds of account land here, and the page fits neither.

- **B1, cash in a broker, an exchange or a foreign-currency checking account.** The header is
  four unlabelled lines of numbers; then «USD balance», «Valuation and contributions», «Monthly
  performance (computed)», «Monthly P/L vs YTD», «Monthly Δ and accumulated earnings», «Monthly
  detail», «Flows». 4,600px on a phone. Performance charts for a cash balance say little; the
  peso checking page already answers what a cash account needs (balance strip, running-balance
  statement). A dollar checking account and a peso one are the same kind of thing with two
  unrelated pages.
- **B2, book-valued invested accounts (APV, AFC).** The same unlabelled header, then a tile
  «Position (ticker and units)» whose Ticker, Units and Value / unit all read «—», because
  these accounts have none. Seven stacked chart tiles follow, 4,900px on a phone, where the
  position page shows one rail and three charts for the same questions.
  This was seen on the synthetic demo data only, whose APV and AFC accounts are generated as
  stored valuations. An APV, AFP or AFC account that holds cuotas already opens the position
  page (`position_glance`, `server/src/positionGlance.ts`, is built from units × a unit price).
  Decided 2026-11-26, in two parts: **(1)** the demo's APV and AFC accounts become cuota ledgers
  on their existing fund series (a demo-generator change, no client work); **(2)** an account
  valued by a stored valuation on a date, with no units or price, opens the same position page
  through a glance without the price blocks (no quote, sparkline of price, price track or
  average cost; the value composition and the day / month / year bars stay), so no account is
  left on `StandardAccountDetailPage` and it is deleted.
- Look from: `CheckingAccountDetailPage` for B1, `PositionAccountDetailPage` for B2.

### C. `/cash_eqs`, `/cash_eqs/savings`, `/cash_eqs/checking` — generic group page

- Same `GroupInfoBase` stack as A, 5,500–6,100px on a phone. Cash groups get P/L-style «Δ by
  account» and «Monthly Δ and accumulated earnings» charts, and no view of what a cash group is
  for: balance per account and per currency, what came in and went out this month, the cards
  netted from cash.
- Look from: `InvestmentGroupPage` for the frame and the checking page's balance strip for the
  content.

### D. `/rates`

- **144,000px tall on a phone**: under each chart every stored day is printed as a date / value
  row, for five pairs. The tail clip is client-side (`pages/ratesDailyTailClip.ts`), against the
  «server computes display shapes» rule.
- The coverage warning is a red block that prints `npm run backfill:…` commands in the page.
- Six charts stacked with no glance of today's rates; the «Currencies / Instruments» tabs are
  plain text.
- Look from: `WatchlistPage` (a market page with a glance per instrument) and the position
  page's chart tiles.

### E. `/flows/deposits/reconciliation`

- **Overflows a phone**: the layout viewport grows to 635px. Eleven plain `Table`s with no phone
  rendering (date / category / account / amount columns squeezed until dates and categories
  wrap onto two lines), 5,900px.
- Its siblings `/flows/deposits` and the mirror-pairs panel were rebuilt as row lists by month.
- Look from: the deposits table (`components/flows`) and `MirrorPairsPanelPage`.

### F. `/panel/import-sync`

- **Overflows a phone**: viewport grows to 501px; the tables in `IngestRunsPanel`,
  `JobQueuePanel` and `SyncLogStatusPanel` (`.tableWrap`) are 540–550px wide. 11,300px tall with
  five tables.
- The message list at the bottom was redesigned; the four panels above it were not.
- Look from: the messages table (one line per row that opens in place).

### G. `/tax-return`

- 11,250px on a phone. Every F22 code is a card of three label / value lines (Filed / Informed
  by third parties / Draft), so about five codes fit a screen and equal rows read as noise.
- Header is three paragraphs of prose, one of them the actual result (tax filed vs draft).
- Sections (settlement, dividends, exchange differences, crypto, rentals, US 1040) follow each
  other with no way to jump or fold.
- Look from: the income tables (period tables with a phone row list) and the settings residency
  form for the header.

### H. `/panel/accounts`

- «New account» is bare browser controls stacked without spacing; the checkbox label prints a
  column name (`exclude_from_group_totals`).
- «Account list» on a phone stacks the four column headers into one cell («Account / Bucket /
  Exclude from totals / Actions») and each row becomes five lines with unlabelled controls;
  5,400px.
- «Portfolio groups» is a third table style; only the accounts tree below was redesigned.
- Look from: the accounts tree component and `MirrorPairsPanelPage`.

### I. `/projections` and `/wealth-percentile`

- Projections: twelve inputs fill the whole first phone screen before any result; the result is
  a dense paragraph («Balance at 65: … · net worth … (today's money; strategies on …)»); the
  chart comes after both. Inputs are `Input` fields without the residency form's grouping.
- Wealth percentile: each year is a card of eight unlabelled-looking lines (`%CL FIN.`, `%MX`,
  …), 7,100px; the chart legend wraps to four centred lines; footnote marks (`*‡†`) carry the
  meaning.
- Look from: the position page rail (headline figures first) for projections; the dashboard
  returns table for the percentile years.

### J. `/flows` overview

- Chart plus a paginated `ColumnTable` «Month detail». It has a phone rendering and does not
  overflow (3,700px). Its issue is consistency: the income and expenses pages next to it now
  have summary headings that follow the period and row lists by month; the overview still has
  the generic table.
- Look from: `IncomePage`.

### K. Leftovers

- `/panel/usage`: two `ColumnTable`s, phone rendering exists; not seen with data.
- `/panel/settings`: language / separator / chart-style controls above the redesigned residency
  form.
- After A and C, `GroupInfoBase` and the generic branch of `GroupInfoPage` have no route left:
  delete them.

## Work items

One session each. «Server» says whether the item needs payload work; by the repo rule the
client only picks precomputed blocks.

**Every item is based on an existing redesigned surface, not designed anew** (the user's
decision, 2026-11-26, given for all four wave 1 items and extended to the later waves). The
«Base» column names that surface: the session reuses its components, phone rendering and
vocabulary, and mocks only what its page needs beyond the base (never 3–4 unrelated layouts),
showing that to the user before implementing. Where the base is one account's page and the
item is a group, the group page with a single account shows that account page's figures.

| # | Base |
|---|---|
| A | The property account page (`components/depto/`); `MortgageGroupPage` only as the precedent for composing glances server-side |
| B1 | `CheckingAccountDetailPage` |
| B2 | `PositionAccountDetailPage` |
| C | `InvestmentGroupPage` itself: cash groups are wired into the existing group page (the server marks the nav node and builds its `group_glance`), with the columns that make no sense for cash left out; no new page |
| D | `WatchlistPage` for the glance per pair; the position page's chart tiles |
| E | The deposits table on `/flows/deposits` (`components/flows/`) |
| F | The messages table (`components/messages/`) |
| G | The income tables; the settings residency form for the header |
| H | The accounts tree component; `MirrorPairsPanelPage` for the list rows |
| I | The position page rail (projections); the dashboard returns table (percentile years) |
| J | `IncomePage` |
| K | The messages table / `ColumnTable` rows already in place |

| # | Item | Server | Main files |
|---|---|---|---|
| A | Real-estate group page | Yes: a `real-estate-glance` on the model of `mortgage-glance` (`mortgageGroupGlance.ts`), composed from each property's own cached `depto_glance` so the group's figures are the pages' figures: appraisal, debt, net equity, loan-to-value, equity over time, rent and running costs per property | new `RealEstateGroupPage`, new server module, one dispatch branch in `GroupInfoPage.tsx` |
| B1 | Cash accounts onto the checking page | Yes: extend `CHECKING_PAGE_KIND_SLUGS` and the checking payload to broker / exchange cash and foreign-currency checking (balance in the account's `cash_currency`) | `AccountDetailPage.tsx`, `CheckingAccountDetailPage.tsx`, checking payload builder |
| B2 | Every remaining account onto the position page: the demo's APV / AFC accounts get units; valuation-on-date accounts get a glance without the price blocks | Yes: demo generator (`server/src/demoData/`, `scripts/generate-demo-data.ts`); `positionGlance.ts` builds a no-price glance for an account valued by stored valuations | `AccountDetailPage.tsx`, `PositionAccountDetailPage.tsx`, `components/account/PositionGlance`; then delete `StandardAccountDetailPage` |
| C | Cash group pages wired into the existing group page | Yes: the nav flag that sends a group to `InvestmentGroupPage` (`investment_glance`, `navTreeTypes.ts`) and its `group_glance` (`groupGlance.ts`) extended to cash groups: balance per account in its own currency and the display unit, no price or return columns | `groupGlance.ts`, `GroupInfoPage.tsx`, `InvestmentGroupPage.tsx`, `components/group/GroupGlance`; then delete `GroupInfoBase` |
| D | Rates page | Yes: today's glance per pair and the recent-entries tail built server-side (drop `ratesDailyTailClip.ts`); coverage message as structured data | `RatesPage.tsx`, `components/rates/`, rates route |
| E | Deposits reconciliation | Probably small: rows grouped by month server-side if they are not already | `DepositsReconciliationPage.tsx` |
| F | Import-sync panels | No (check at start) | `components/sync/*` |
| G | Tax return | Check at start; the F22 rows are server-built, a «differs from filed» flag per code may be missing | `TaxReturnPage.tsx`, `components/tax/` |
| H | Accounts panel | No | `AccountsPanelPage.tsx`, `components/panel/` |
| I | Projections and wealth percentile | Projections: the summary sentence as structured figures. Percentile: no | `ProjectionsPage.tsx`, `WealthPercentilePage.tsx` |
| J | Flows overview: its «Month detail» table replaced by the income / deposits period table component, not a new table | No | `FlowsOverviewPage.tsx` |
| K | Leftovers (usage, settings top, dead code) | No | small |

### Which findings depend on the demo data

The pages were judged on the synthetic demo database. What that changes:

- **B2**: the problem itself was demo-only for APV and AFC (see B2 above).
- **D**: the red «exchange rate incomplete» block is the demo's incomplete rate history and
  probably does not show on real data; the page length and the client-side clip are code.
- **F**, **K**: the runs, queue and usage panels were empty in the demo; F's session filled
  them with synthetic rows, K still needs the same before judging.
- **A**, **C**, **E**, **G**, **H**, **I**, **J**: the route renders the same component whatever
  the data, so the finding holds; only sizes (page heights) will differ.

### Order by value

1. **A** — the known gap; one of four sibling pages still generic; visited from the sidebar.
2. **B1** — a dollar account is an everyday page and the checking page already has the answer.
3. **E** and **F** — the two pages that are actually broken on a phone (horizontal overflow).
4. **D** — the 144,000px phone page and a client-side clip to move to the server.
5. **B2** — the empty «Position» tile; finishes the account pages and retires
   `StandardAccountDetailPage`.
6. **C** — finishes the group pages and retires `GroupInfoBase`.
7. **G** — large and used once a year; high effort.
8. **H**, **I**, **J**, **K** — in that order.

### What can run in parallel

Shared files that force an order:

- `GroupInfoPage.tsx`: A and C (each adds a dispatch branch; C also deletes the generic branch).
  Run A before C.
- `AccountDetailPage.tsx` and the account page components: B1 and B2. Run B1 before B2.
- `client/src/i18n/master.json` is touched by every item. Conflicts there are mechanical;
  regenerate the locale files after each merge (`npm run i18n:generate -w nw-tracker-client`).

Suggested waves, each wave's items touching disjoint page files:

- Wave 1: A, B1, E, F
- Wave 2: C, B2, D, H
- Wave 3: G, I, J, K

Server-side, A / C read group and depto modules, B1 / B2 the account bundle, D the rates route:
no two items of one wave share a server module, but A and C both add an endpoint under
`/api/portfolio-groups/:slug/…` and should follow the same naming.
