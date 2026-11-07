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
   * `parent_pct`, v15 added the server `value`, v16 compounded daily % with `on_deposits_*`.
   */
  nav_strip: 16,
  /** `GET /api/meta/sidebar-nav`: v5 `chart_coverage`, v6 `member_account_ids`. */
  sidebar_nav: 6,
  /** The page bundle's `upcoming_payments` («Próximos pagos»). */
  upcoming_payments: 4,
  /** `GET /api/dashboard/latest-expenses` («Últimos gastos»). */
  latest_expenses: 2,
  /** `GET /api/flows/overview` (the home «Flujos» periods store its `closed` block). */
  flows_overview: 1,
} as const;

export type DtoSchemaVersionName = keyof typeof DTO_SCHEMA_VERSIONS;
