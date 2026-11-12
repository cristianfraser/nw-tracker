/**
 * `schema_version` of each payload the client keeps in localStorage (docs/untangle-plan.md F8).
 * The server stamps it on the payload, the client stores and reads a payload under the version it
 * was built for and drops any other (`client/src/queries/persistedPayloadCache.ts`). Bump one when
 * the shape the client reads from it changes.
 */
export const DTO_SCHEMA_VERSIONS = {
  /**
   * The card strip: `GET /api/dashboard/nav-snapshot`, nav-context and the page bundle's `dash`,
   * which the client folds into one stored snapshot. History before the shared helper: v5 added
   * `card_metrics_by_slug`, v6 the liabilities entries, v7 the day variant, v8 dropped
   * `title_delta`, v9 added `row_pct`, v10 the value map, v11 tree membership, v12 the holding
   * tiles, v13 `parent_pct` and the liquidated rows, v14 dropped v13 entries without
   * `parent_pct`, v15 added the server `value`, v16 compounded daily % with `on_deposits_*`, v17
   * the account rows' `nav_label`, `has_period_returns` and `loan_account_id`, v18 Retirement by
   * country (Chile / US slugs), v19 dropped `nav_label` (a card line's label is the row's `name`), v20
   * one value per field in the payload's `unit` (no `_clp` / `_usd` pairs).
   */
  nav_strip: 20,
  /** `GET /api/meta/sidebar-nav`: v5 `chart_coverage`, v6 `member_account_ids`, v7 Retirement by country. */
  sidebar_nav: 7,
  /** The page bundle's `upcoming_payments` («Próximos pagos»). */
  upcoming_payments: 6,
  /**
   * `GET /api/dashboard/latest-movements` («Últimos movimientos»: expense lines and income, by the
   * day each happened); v2: rows carry `amount` (native currency) + `values` per unit; v3: `values`
   * replaced by `converted` in the requested unit (and an expense line's `value_clp`).
   */
  latest_movements: 3,
  /** `GET /api/flows/overview` (the home «Flujos» periods store its `closed` block); v2 adds `cash_fx`. */
  flows_overview: 2,
} as const;

export type DtoSchemaVersionName = keyof typeof DTO_SCHEMA_VERSIONS;
