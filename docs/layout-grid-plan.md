# Layout grid redesign plan (client)

Status: phases 0–4 built 2026-11-01, then the sidebar moved out of the column grid the same day (see AGENTS.md «Page grid and tiles» for what landed); the deferred items at the end of §F stay open. Originally a draft of the same day. Research behind it: grid principles from
Müller-Brockmann, Vignelli, Vinh/Boulton, Samara and Lupton; Bootstrap / Tailwind /
Material 3 mechanics, native CSS grid, subgrid and container queries; the bento libraries;
and a map of the current shell, dashboard and group pages (session scratchpad reports).

Decisions taken before planning: one page-wide column grid with the sidebar on whole
columns (the "book" answer); cards touch with a single hairline, like a table; cards lose
padding, background and border-radius as the app-wide default, and so do chart boxes and
table wraps; no inner inset in this version (left-edge alignment comes later); no emphasis
treatment; scope = dashboard + group pages; three tiers (mobile, small desktop, big desktop
with a right-hand rail on the dashboard); the big-desktop dashboard must be bento-ready
(react-grid-layout later) without implementing it.

Decided 2026-11-01 after review: the sidebar is **fluid, on whole columns** (G1) — **reversed
the same day after building it: the sidebar is a fixed 15.5rem track of a two-track wrapper and
only the content region carries the 12 columns and the rail (§0 and the shell part of §A below
describe the first build)**; small
desktop **starts at 880**, so the shell tier and the tables' narrow line are one breakpoint
(G2); the summary cards keep **quarter width** — the summary row is the same 4-up block as
the detail row, two cards filled, the rest empty (G3); the pending chart box is **fully
transparent** (G5).

## Reviewer notes (what the plan agent proposed vs what I would change)

1. **Big-desktop rows.** The plan places main and rail tiles on shared explicit `grid-row`
   spans. With auto-height tables in the rail, a shared row stretches and opens whitespace
   inside the main column. For v1 I would make the L tier two independent column stacks
   (main = 8 columns, rail = 4, each a subgrid stack with the page row gap) and keep the
   shared-row addressing only in the JSON. react-grid-layout positions absolutely, so the
   static CSS does not need shared rows for the library to be a drop-in later.
2. **Fluid sidebar** is the literal consequence of putting the sidebar on whole columns of a
   fluid grid (238–342 px on S, 262–310 px on L). It is the first decision to confirm (G1).
3. Everything else below is the plan as drafted.

## 0. Column count: 12 content columns at both desktop tiers

Content region = 12 columns at both desktop tiers; the page-wide grid that contains the
sidebar is 16 columns on small desktop (sidebar 4) and 15 on big desktop (sidebar 3).

Why not the books report's 16-page / 2-column-sidebar: a 15.5rem (248 px) sidebar on 2
columns gives a unit of ≈112 px, so 12 columns need ≈1600 px — nothing fits a 1440
laptop. The sidebar needs 3–4 columns of a fluid grid, which pushes the page count above
12. The bento lives in the content region, which must be 12 (3×4: 2-up summary cards,
4-up bucket cards, 8+4 main/rail). Keeping content at 12 on both tiers means every tile's
`{x, w}` is on the same 12 and react-grid-layout's `cols` is 12 at both; no tile ever
addresses page columns. The unit is still derived from the sidebar at the tier floor:
`u = (248 − 3·16)/4 = 50` (S) and `u = (248 − 2·24)/3 ≈ 67` (L).

| Tier | Viewport | page cols | unit | sidebar | content (12) | main 8 / rail 4 |
|---|---|---|---|---|---|---|
| S | 880 | 16, gutter 16 | 38.5 | 202 | 602 | — |
| S | 1024 | 16, gutter 16 | 47.5 | 238 | 746 | — |
| S | 1280 | 16 | 63.5 | 302 | 938 | — |
| L | 1440 | 15, gutter 24 | 71.5 | 262 | 1122 | 740 / 358 |
| L | 1680 (cap) | 15 | 87.5 | 310 | 1314 | 868 / 422 |

The rail at L lands on Material 3's 360→412 pane range; the main at 740 ≥ the 46rem
(736 px) PeriodReturns comparison width.

## A. Grid specification

**Tokens (`styles/tokens.css`).** Media queries cannot read custom properties, so the tier
lines are literals repeated in CSS; the values are tokens:

```css
:root {                       /* M: < 880 */
  --page-cols: 4; --sidebar-span: 0; --content-cols: 4;
  --gutter: 1rem; --row-gap: var(--gutter); --row-unit: 1.5rem;   /* 24px = one UI line */
  --margin-inline: 1rem; --margin-top: var(--row-gap);
  --margin-bottom: calc(2 * var(--row-gap) + var(--display-prefs-bar-reserve) + env(safe-area-inset-bottom, 0px));
  --page-max: 100vw; --hairline: var(--border);
}
@media (min-width: 880px) { :root { --page-cols: 16; --sidebar-span: 4; --content-cols: 12;
  --margin-inline: 1.5rem; --margin-bottom: calc(2 * var(--row-gap) + var(--display-prefs-stack-height)); } }
@media (min-width: 1440px) { :root { --page-cols: 15; --sidebar-span: 3; --gutter: 1.5rem;
  --margin-inline: 2rem; --page-max: 105rem; } }
/* derived, every tier */
:root { --page-w: min(100vw, var(--page-max));
  --unit: calc((var(--page-w) - var(--margin-inline) - (var(--page-cols) - 1) * var(--gutter)) / var(--page-cols));
  --sidebar-w: calc(var(--sidebar-span) * var(--unit) + (var(--sidebar-span) - 1) * var(--gutter));
  --content-w: calc(var(--page-w) - var(--margin-inline) - var(--sidebar-w) - var(--gutter)); }
```

**Tiers.** M < 880: drawer sidebar, 4 columns. S 880–1439: the persistent sidebar on 4 of
16 columns (202 px at 880, the user's choice over a drawer there; 238 px at 1024, 302 at
1280). L ≥ 1440: MacBook 1440/1512 and the 1536 Windows majority get the rail; 1600 would
exclude them. The shell tier and the **narrow-tables line are the same 880 breakpoint**
(`tables.css`, `PeriodReturnsTable.module.css`, `CreditCardCuotaProgress.module.css`,
`useIsNarrowViewport.ts` — the existing 879/880 pair), so the app keeps one small-desktop
line; L is the only new one. Document both tiers in the `useIsNarrowViewport.ts` docblock.

**Shell (`styles/shell.css`).** `.layout--with-sidebar` becomes the page grid:
`display: grid; grid-template-columns: repeat(var(--page-cols), minmax(0, 1fr)); column-gap:
var(--gutter); padding-inline: 0 var(--margin-inline); max-width: var(--page-max)`
(left-aligned; beyond the cap the right margin grows — unequal margins). Its in-flow
children are only `aside.app-sidebar` and `div.layout-main` (the drawer input is absolute,
the labels `display:none` ≥880, ticker and toast are fixed).
`.app-sidebar { grid-column: 1 / span var(--sidebar-span); position: sticky; top: 0;
align-self: start; height: 100vh }` — sticky works inside a grid row as tall as the page;
the sidebar keeps `--surface` + `border-right` and is flush left because the grid has no
left padding. `.layout-main { grid-column: calc(var(--sidebar-span) + 1) / -1; min-width: 0;
padding-top: var(--market-ticker-height) }` — desktop now reserves the ticker strip.
`.layout-main > .content { display: grid; grid-template-columns: repeat(var(--content-cols),
minmax(0, 1fr)); column-gap: var(--gutter); padding: var(--margin-top) 0
var(--margin-bottom); max-width: none; margin: 0 }` and `.content > * { grid-column: 1 / -1 }`
so every page's `<main>` spans the content; pages that do not opt in stay block flow inside
that item. **M:** `.layout--with-sidebar { display: block }` stays; the sidebar stays
`position: fixed` + translate (drawer untouched); `.content { padding-inline:
var(--margin-inline) }`.

**Fixed elements.** Ticker ≥880: `width: calc(8 * var(--unit) + 7 * var(--gutter) +
var(--margin-inline))` with `right: 0` — its left edge lands on content column 5 (the same
2/3 as today, now on a grid line); the hard-coded 15.5rem goes. Prefs dock: `max-width:
calc(var(--content-w) - 2 * var(--display-prefs-side))`
(`AppDisplayPreferencesBar.module.css:58`); the dock stays bottom-right and the new
`--margin-bottom` clears it. `100vw` includes the scrollbar on Windows (≈15 px drift on the
ticker only; same as today).

**1200px max-width:** gone. The container is fluid; the only cap is `--page-max` at L.

**Page grid and subgrid.** `GroupInfoBase`'s `<main>` and its `Loadable.contentShell` both get
`.page-grid { display: grid; grid-template-columns: subgrid; grid-column: 1 / -1; row-gap:
var(--row-gap); grid-auto-rows: minmax(var(--row-unit), auto) }` (new
`styles/page-grid.css`, imported after `charts.css`). Tiles are the shell's direct children.
Nested rows that must sit on page lines (the card strip, the 2-up chart grid) are subgrids
too.

**Hairlines for touching cards.** The strip is a subgrid with `column-gap: 0`: a subgrid's
own gap overrides the parent's, and the difference is split across each gutter, so adjacent
cards meet **on the gutter's centre line**; every card is still k units + (k−1) gutters +
half a gutter each inner side. Lines are per-card borders stripped by a **fixed per-tier
count** (never auto-fill):

```css
.cards { grid-template-columns: subgrid; column-gap: 0; }      /* 4-up on S (12 → 3 cols each) and L (8 → 2 each) */
.cards > .card { grid-column: span 3; border-left: 1px solid var(--hairline); }
.cards > .card:nth-child(4n+1) { border-left: 0; }           /* summary, detail, CC and depto cards alike */
.cards > .card:nth-child(n+5) { border-top: 1px solid var(--hairline); }
.cards--detail { border-top: 1px solid var(--hairline); }     /* the one line between row 1 and row 2 */
```

The summary row is the **same 4-up block** as the detail row (decided: quarter-width summary
cards): Net worth and Inversiones fill cells 1–2 and cells 3–4 stay empty, which is what CSS
grid gives for free — no `.cards--summary` 2-up rules. The `.cards--detail` border-top runs
the full width, under the empty cells too, like a table rule. At L the strip sits in the
main 8 columns, so a card spans 2 (`.cards > .card { grid-column: span 2 }` under the L
query); the count stays 4-up.

M: 1-up (`.card + .card { border-top }`), 2-up through `@container strip (min-width: 36rem)`
with `2n+1` / `n+3` (folds the 600 px breakpoint). Failure modes handled: a partial last row
draws no stray line (no container background), the "row 1 holds only summary cards" rule
becomes structural (two blocks; the `+` selector in `cards.css:17` dies), and the count is a
literal per block and tier so `nth-child` is exact. The `gap: 1px + background` technique is
rejected: an empty last-row cell would paint the line colour over a whole cell. **Phase 0
verifies the subgrid gap override in Chrome, Safari and Firefox**; the fallback is a plain
nested `repeat(N, minmax(0,1fr)); gap: 0` grid whose dividers sit inside the gutter band but
up to g/3 off-centre (absorbed by the deferred inset step).

## B. Card redesign

- `.card` (`cards.css:22`): `padding: 0; background: none; border: 0; border-radius: 0`.
  The `.cards>.card--dashboard-net-worth` emphasis rule (`:8`) is deleted;
  `--surface-emphasis` is deleted from `tokens.css` (its only consumer). `--card-radius`
  stays — it now only skins popovers, tooltips and the modal (6 consumers); a rename to
  `--popover-radius` is a follow-up. `--surface` stays (sidebar, popovers, `tr:hover`).
- `.card--detail` / `.card--detail-compact` `min-width: 220px` (`:136,:145`) deleted — the
  grid decides. `.card--detail-stretch` and `.card--detail-body` stay (the cash card pins its
  bottom list). `card--cash` unchanged. `.page-dashboard .card--detail min-height: 180px`
  (`:141`) stays as `--card-detail-min-height: 180px` so the cold strip and the real strip
  still paint at the same height.
- `CompactEntityCard.module.css`: `.root` loses border, radius, padding and background (the
  undefined `--radius/--card/--panel` go); `.rootStripInner` reduces to nothing and is
  deleted with the `stripInner` styling (check `AccountDetailSharedLayout.tsx:77`).
- Chart boxes: `.chart-box { margin-top: 0; padding: 0; background: none; border: 0;
  border-radius: 0 }`, heights unchanged. `.chart-box--pending` is fully transparent too
  (decided): the frame is the title row plus the reserved height.
- `.table-wrap` (`tables.css:3`): no border, radius or background; the row hairlines
  (`th, td` border-bottom) are the table's lines. `DashboardFlowsSummary .period`: no chrome;
  the two boxes become a `.cards` block (4-up, two filled) so the same divider rules apply.
- Inner hairlines do not double: `CardGroupMetrics .divider` and `DashboardCardBreakdown
  .stack/.bottom/.root` border-tops are inside the card, never at its edge, and the card has
  no border of its own now. The only edge rule is `.cards--detail { border-top }`, and the
  summary cards have no bottom border.
- Cold strip: `PlaceholderCardsStrip` renders through the same `PortfolioEntityCardsStrip`,
  so it gets the two blocks and the dividers for free; `PlaceholderCardsStrip.module.css`
  `blankValue`/`blankMetric` heights are number-flow padding, not card padding — unchanged.
  Verify in devtools that cold and warm strip heights match at each tier. Number-flow sizing
  (`cards.css:96-128`, `DashboardCardValue.module.css`) untouched; the accounts table stays
  outside `DashboardCardsValueGroup`.

## C. Composition per tier

Stable tile ids: `title`, `strip`, `net-worth-chart`, `flows-periods`, `flows-chart`,
`cc-upcoming`, `perf-combo`, `allocation`, `returns`, `detail`, `wealth-flows`,
`latest-expenses`, `export`, `accounts`.

**DashboardFlowsSummary split** (`components/dashboard/DashboardFlowsSummary.tsx`):
`DashboardFlowsPeriods` (h2 «Flujos» + «/flows» link + the two period cards; no prefs) and
`DashboardFlowsChart` (title row with `SurfaceControls` + `FlowsOverviewChart`). Both call
`useFlowsOverview(displayUnit, installmentMode, days)` — the periods half with `days`
undefined — and share the react-query cache; `SUMMARY_LINES` moves to `flowsSummaryLines.ts`.

**L (content 12 = main 8 + rail 4):**
```
col: 0               8          12
y0  | title (w12)                       |
y1  | strip: summary 4-up (2 filled) | flows-periods (2 cards, 2-up in the rail)
    |        detail 4-up             |
y9  | net-worth-chart      | cc-upcoming (mobile-card rendering)
    |                      | latest-expenses (mobile-card rendering)
    | flows-chart          | accounts (tree)
    | perf-combo           | export
    | allocation           |
    | returns (w12) ------------------- |
    | detail (w12) -------------------- |
    | wealth-flows (w12) -------------- |
```
The wide tables span 12 below the rail. Rail tiles are `container-type: inline-size`;
`@container (max-width: 40rem)` switches their parallel tables to the mobile rendering
(`!important`, mirroring `tables.css:93-122`). See reviewer note 1 on shared rows.

**S (12):** `title`, `strip` (summary 4×3 with two filled, detail 4×3), `net-worth-chart`,
`flows-periods` (4×3 with two filled), `flows-chart`, `cc-upcoming`, `perf-combo`, `allocation`, `returns`, `detail`,
`wealth-flows`, `latest-expenses`, `export`, `accounts` — today's order, every tile w12.

**M (4):** same order, every tile w4; cards and period boxes 1-up (2-up ≥36rem container).

**Group pages (GroupInfoPage, LiabilitiesGroupPage), S and L alike — no rail in v1:**
```
| title                                     |
| strip: summary (w12) / detail 4-up / accounts table |
| valuation chart (6)   | composition or coverage (6) |   M: stacked
| group-chart-view-toggles                  |
| perf combo 1 (12) | perf combo 2 (12)     |   (not on Pasivos)
| Pasivos: h2 + CreditCardSummaryCards 4-up touching, associated list, Historial (280px box), Detalle |
| Pasivos: h2 + depto cards 4-up (7 cards → 4 + 3), mortgage charts, tables |
| Rentabilidad | Detalle | Flujos | export | Cuentas |   (not on Pasivos: hideConsolidatedTables)
```
`.chart-grid` becomes a subgrid tile, panels `span 6` ≥880 (replacing the 900 rule),
`--full-line` spans 12; `.chart-grid__col` keeps `min-width: 0`.

## D. De-noising

Remove, with the row gap taking over: `PortfolioNavEntityCardsStrip.tsx:183` and
`PlaceholderCardsStrip.tsx:73` wrapper divs (`marginTop .85rem`; move `aria-hidden` onto the
strip); `PortfolioEntityCardsStrip.tsx:63` (`.cards + .strip-table { margin-top:
var(--row-gap) }` in CSS); `DashboardPage.tsx:427,:511`; `CcUpcomingPaymentsPanel.tsx:155`;
`LatestExpensesTable.tsx:60`; `PortfolioGroupChartsSection.tsx:105,:121,:173,:197`;
`charts.css:35` (`.chart-grid` margin-top → 0); `DashboardFlowsSummary.module.css` `.root`
margin, `.summary` margin, the `600px` query.

Headings rule: delete `fontSize` and `marginTop` from `GroupInfoBase.tsx:245,:255,:256,:307`
and `NavAccountsTree.tsx:73`; one global rule `.chart-panel-title-row > :is(h2,h3,h4)
{ margin: 0 }` replaces every inline `margin: 0` (`DashboardFlowsSummary.tsx:109`,
`LatestExpensesTable.tsx:62`, `GroupInfoBase.tsx:256`,
`LiabilitiesMortgageGroupSection.tsx:218`); `.page-tile > :is(h2,h3,.chart-panel-title-row):first-child
{ margin-top: 0 }` — every section heading moves **inside** its tile
(`<section data-tile="returns"><h2/>…</section>`), so the heading has no outside margin and
the tile height is honest for the bento.

Move to classes: `GroupInfoBase.tsx:323` export row → `.page-tile--end`;
`DashboardPage.tsx:375-376` and `SurfaceControls.tsx:57-64,67,82,102` → `styles/controls.css`
(`.surface-controls`, `.surface-controls__label`); `CompactEntityCard.tsx:61` →
`.card-subtitle`; `NavAccountsTree.tsx:18,37,41,45,78` → `NavAccountsTree.module.css`;
`ValuationLineCharts.tsx:365-378` → the existing but empty `.line-chart-legend` class;
`Table.tsx:299-301` → `.table-wrap--collapsed`. `lazyCharts.tsx:67` keeps `height: 280` (the
`ChartEmptyState` boxStyle contract) but drops `marginTop`. Left for follow-up (not rhythm):
`PaginatedTable`, `FlowsTable` filter widths, `PortfolioNavAccountsSummaryTable` row styles,
`ExportModal`.

Stray breakpoints: `charts.css:38` 900 → 880; `DashboardFlowsSummary` 600 → container
query; `cards.css:16` deleted; `AppDisplayPreferencesBar.module.css:53`,
`MortgageUfReminderToast.module.css:56`, `shell.css:179` stay at 880 (now the one shell
tier); `pages.css:42` and `AccountDetailPage.module.css:152` unchanged (other pages, not
broken; re-express later).

## E. Bento readiness

**2026-11-02, the user's call: adaptive, not movable.** No react-grid-layout and no dragging. On
the big desktop the rail sits beside the cards and the main chart only; below that band the other
charts sit in two equal columns (`.page-pairs`, w 6 each, an odd last one across both), then the
wide tables. The rectangles below stay as the layout table, without the library step.

`client/src/dashboardLayout.ts`: `type TileRect = {x,y,w,h}`, `type TileLayout = {l: TileRect;
s: TileRect; m: TileRect}`, `DASHBOARD_LAYOUT: Record<TileId, TileLayout>`, plus `GRID = { cols:
{l: 12, s: 12, m: 4}, breakpoints: {l: 1440, s: 880, m: 0}, rowHeight: 24, margin: {l:
[24,24], s: [16,16], m: [16,16]}, containerPadding: [0,0], compactType: "vertical" }` —
exactly react-grid-layout's `Responsive` props. `h` is in 24 px rows with the gutter as row
margin (item height = h·24 + (h−1)·g): L examples `strip {0,1,8,8}`, `net-worth-chart
{0,9,8,10}`, `flows-periods {8,1,4,9}`, `returns {0,…,12,6}`.

A `PageGridTile` component (`components/layout/PageGridTile.tsx`) renders `<section
data-tile={id} class="page-tile" style={{'--l-x':…,'--l-y':…,'--l-w':…,'--l-h':…,'--s-w':…,'--m-w':…}}>`;
`page-grid.css` maps them: at L `grid-column: calc(var(--l-x) + 1) / span var(--l-w)` (and,
if shared rows are kept, `grid-row: calc(var(--l-y) + 1) / span var(--l-h)`); at S/M
`grid-column: 1 / span var(--s-w|--m-w)` with rows from source order (a unit test asserts the
JSON `y` order equals the render order). Rows are `minmax(var(--row-unit), auto)`. When
react-grid-layout mounts, auto-height tiles (`returns`, `detail`, `wealth-flows`,
`cc-upcoming`, `latest-expenses`, `accounts`) get a ResizeObserver that rounds their measured
height up to `h` — the one piece the library step adds. No deliberate vertical holes at L.
`Loadable` already forwards `style`/`data-*`, so the strip's `Loadable` is its tile.

## F. Phases (each shippable; desktop and mobile table renderings change together)

**Phase 0 — spike (not shipped).** Subgrid `column-gap: 0` override in Chrome, Safari,
Firefox on the real strip behind a temporary class; `grid-row` + `minmax(row-unit, auto)`
stretching with a tall rail item (decides reviewer note 1). Decide fallback.

**Phase 1 — shell grid + tokens.** `tokens.css`, `shell.css`,
`AppDisplayPreferencesBar.module.css`, `MortgageUfReminderToast.module.css`,
`useIsNarrowViewport.ts` docblock, `styles/page-grid.css` (new, imported in `index.css`).
Every page still one stack. Verify at 375, 768, 880, 1024, 1280, 1440, 1920: sidebar sticky
and flush left, drawer below 880, ticker left edge on column 5, dock clears the last section, no
horizontal scroll, `.content` fluid.

**Phase 2 — de-chroming + strip blocks.** `cards.css`, `charts.css` (`.chart-box`),
`tables.css` (`.table-wrap`), `DashboardFlowsSummary.module.css`,
`CompactEntityCard.module.css`, `tokens.css` (drop `--surface-emphasis`),
`PortfolioEntityCardsStrip.tsx` (two `.cards` blocks; subgrid), `PlaceholderCardsStrip.tsx`,
`PortfolioNavEntityCardsStrip.tsx`. Verify: dashboard cold vs warm strip heights equal;
dividers single everywhere (summary/detail, partial last rows on Pasivos' 7 depto cards, leaf
page table); cash card bottom still pinned; number-flow digits intact.

**Phase 3 — tiles + de-noising (S/M complete).** `PageGridTile.tsx`, `dashboardLayout.ts`,
`GroupInfoBase.tsx` (tiles around strip, returns, detail, wealth-flows, afterFlows, export,
accounts; `.page-grid` on main and shell), `DashboardPage.tsx`, `DashboardFlowsSummary.tsx`
split, `CcUpcomingPaymentsPanel.tsx`, `LatestExpensesTable.tsx`,
`PortfolioGroupChartsSection.tsx`, `NavAccountsTree.tsx` + module, `SurfaceControls.tsx` +
`styles/controls.css`, `CompactEntityCard.tsx`, `ValuationLineCharts.tsx`, `Table.tsx`,
`charts.css` (`.chart-grid` subgrid, 1024), `base.css`/`page-grid.css` heading rules. Verify:
order identical to today at S and M; every h2 at 1.1rem; one row gap between tiles; the 2-up
chart grid on group pages at ≥880; Loadable dimming still per tile;
`.chart-panel-title-row` controls clickable while dimmed; Pasivos sections unchanged.

**Phase 4 — L composition.** `page-grid.css` L block, `dashboardLayout.ts` L rects, rail
container query for parallel tables (`tables.css`). Verify at 1440/1536/1680/1920: rail
358–422, tables in the rail as mobile cards with the same data as the desktop cells, wide
tables full width below, no overlap when the rail is long or `cc-upcoming` returns null, cap
and right margin beyond 1680, ticker/dock widths.

**Deferred:** left-edge text alignment with inner insets (needs the fixed count from B,
already in place); any emphasis treatment; group-page rail; the bento UI (react-grid-layout +
a keyboard move menu); other pages (`/flows`, `/panel`, account detail, rates, watchlist) keep
block flow inside the new `.content` grid; `--card-radius` rename; `PaginatedTable` /
`FlowsTable` inline styles; the 880–1199 account-detail rule.

## G. Risks and open questions

1. DECIDED: **fluid sidebar** on whole columns (202–342 px on S, 262–310 on L).
2. DECIDED: S starts at **880**; the sidebar is ~202 px at that width, so its labels and
   depth rails must be checked there in phase 1.
3. DECIDED: summary cards keep **quarter width**; the summary row is a 4-up block with two
   cells empty, and the row-1/row-2 rule runs under the empty cells.
4. **Subgrid gap override** must pass the phase-0 spike; the fallback shifts dividers up to
   g/3 off the gutter centre.
5. DECIDED: the pending chart box is fully transparent.
6. Group pages get no rail at L in this version; the tree + export could move beside the perf
   combos later.
7. Beyond 1680 the grid is left-aligned (sidebar on the viewport edge, right margin grows);
   centering would float the sidebar.
8. Rail tables render as mobile cards by container width; `container-type` creates a stacking
   context per rail tile — fine for Tarjetas / Últimos gastos (no hanging tooltips), so do not
   put the container on `.table-wrap` app-wide.
9. (Reviewer) Shared explicit rows at L vs two independent stacks — see reviewer note 1.
