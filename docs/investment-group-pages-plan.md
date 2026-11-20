# Investment group pages: one layout for every group under Inversiones

Status: in progress (2026-11-20). Chosen mockup: round 3, «g3-3» (group-pages round 2 combo 2 with the
children table's total row and colour dots; no hover sparkline). Follows the unit-position and basket
pages (`docs/fund-and-basket-pages-plan.md`).

## What gets it

Every net-worth group node at or under the «Inversiones» hub (Inversiones, Brokerage, Acciones, Crypto,
Mutual funds, Retiro, AFP + AFC, APV, apv-a, apv-b, …) **except** a basket group (`basket`), which keeps
its basket page. Decided on the server from the tree (the node is the inversiones hub — the
`nav_bucket` whose children carry `dashboard_bucket_slug` brokerage / retirement — or a descendant of
it), stated on the nav node as `NavTreeNodeDto.investment_glance: boolean`, so the client picks the
layout before any payload. Never a slug list in the client.

## Layout (desktop, 12 columns; one column below 880)

1. **Title line**: name, value, día P/L (amount and %). Sub-line, small muted: «N posiciones, M vendidas
   · aportes $X · total ±Y (±Z%)».
2. **Band**: «Valorización y aportes» (the group valuation chart, compact D/M/A + range controls, no
   legend, total + aportes lines — the basket page's `GroupValuationChart` use) on 7 columns | the value
   treemap (`ValueMapPanel`, always the map, its own día/mes/año row; no Composición/Mapa switch) on 5,
   with a muted «vendidas: A, B, C» line under it (from the ledger's sold rows) when there are any.
3. **Strip** under the band: [«valor hoy» composition bar (the position page's) | día/mes/año
   zero-centred period bars (the position page's)].
4. **Children table** (full width): header (valor, peso, mes, año, total, aportes); first the **total
   row** (the group itself: bold name, its colour dot, its sparkline, 100%), a hairline, then one row per
   child heaviest first: colour dot (the child's chart colour: the same one its line/area/bar uses),
   name → its page, own-scale one-year sparkline, value, thin share bar + %, mes %, año %, total P/L,
   aportes. A basket child opens one level (its members indented, dimmer dot, collapsible caret).
   Sold-out children last, muted, value $0, no %, still their total P/L and aportes. One line per row on
   desktop; below its container breakpoint it keeps name, value, mes and total (no horizontal scroll).
5. **Charts pair**: «Valor por posición» (value stacked by child, from the grouped valuation block's
   child lines, with the aportes line over it; a «%» toggle switches to the server's 100% proportional
   block) | «P/L mensual» (the group P/L combo, bars stacked by child + YTD). One shared D/M/A + range
   control row for the pair.
6. **Rentabilidad** (compact rows, benchmark row) | **Detalle por mes**.
7. **Movimientos**, then export. No card strip, no accounts tree, no Agrupado / Aportes toggles, no
   second P/L combo (Δ mensual y ganancia acumulada).

## Server: `group_glance` on the nav-context payload

Built in `server/src/groupGlance.ts` beside `basketGlance.ts` (same inputs: the payload's own card
metrics and rows; composition summed over the members the way `basketPositionOn` does it), attached to
`GET /api/dashboard/nav-context?root=<slug>` as `group_glance` when the root node has
`investment_glance`, else null. Fail fast: a child row without card metrics throws.

```ts
export interface GroupGlanceRowDto {
  /** "group" = a child nav group (or the page's own group for the total row), "account" = a direct account. */
  kind: "group" | "account";
  slug: string | null;          // group rows
  account_id: number | null;    // account rows
  label: string;                // the nav label / account name (server's, not translated on the client)
  label_i18n_key: string | null;
  route_path: string;
  /** The id of this child's line in the grouped valuation block / bar key in the grouped P/L bars
   *  (`nav_grouped_blocks.grouped`, `nav_grouped_bars.grouped`), so the client takes its colour from
   *  the same colour map the charts use; null for the total row and for basket members. */
  chart_line_account_id: number | null;
  color_rgb: string | null;
  value: Money;                 // today, display unit
  /** value ÷ the group's value (0..1); 1 on the total row; 0 when sold out. */
  share: number;
  month_pct: number | null;     // the card's chained %s (row_pct / parent_pct rules)
  year_pct: number | null;
  total_pl: Money | null;       // lifetime P/L (card total row)
  total_pct: number | null;
  deposits: Money | null;       // lifetime aportes (card total row)
  held: boolean;                // holds something today
  /** One year ending today, own scale: up to ~60 points, x/y in 0..1 (x by calendar day from today−364). */
  spark: { x: number; y: number }[];
  /** A basket child's members (one level); empty otherwise. */
  members: GroupGlanceRowDto[];
}

export interface GroupGlanceDto {
  slug: string;
  title: string;
  unit: DisplayUnitCode;
  value: Money;
  day: PositionGlancePeriodDto;
  positions_held: number;       // direct children holding something today
  positions_sold: number;       // direct children sold out
  deposits: Money | null;       // lifetime aportes of the group
  total_pl: Money | null;
  total_pct: number | null;
  composition: PositionGlanceDto["composition"];
  periods: { day: PositionGlancePeriodDto; month: PositionGlancePeriodDto; year: PositionGlancePeriodDto };
  /** The total row (the group itself). */
  total: GroupGlanceRowDto;
  /** Children: held ones heaviest first, then sold-out ones (by total P/L magnitude). */
  rows: GroupGlanceRowDto[];
}
```

Children are the group's grouped chart plan buckets (`buildNavChartBucketPlan(node, true)`), so a row,
its line and its bar are one membership. Every money figure is the card metrics' (`card_metrics_by_slug`
for group children, the account row's for accounts) so the table equals the cards and «Detalle».
As built (server): a child group's row reads its card's `child` variant, `value.child` and `row_pct`;
the total row the `parent` variant, `value.parent` and `parent_pct`; an account its dashboard row.
When the page draws no grouped block (fewer than two buckets) the rows are its member accounts and
`chart_line_account_id` is the account's own id. The composition follows the basket's «last day
held» rule (today while any member holds something; a sold-out group's on its last held day,
`is_today` false), null only when the deposited figure cannot be computed. A sparkline that is zero
the whole year sits at y = 0; any other flat one at 0.5. A row's value with none on record (an account never valued)
reads 0 / not held; one missing for want of a rate throws. The nav-context `value_map` of a group
the full map folds into a proxy frame (apv-a, apv-b on the one Risky Norris basket) is the map
rooted at that group (`buildNavValueMapForRoot`: its own holdings, sized by its own value); a group
worth 0 has none. `investment_glance` comes from `isInvestmentGroup` (`navTreeModel.ts`).
