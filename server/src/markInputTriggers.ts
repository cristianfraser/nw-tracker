import type { Database as DatabaseType } from "better-sqlite3";

/**
 * The triggers that fill `mark_input_changes` (migration 211 on; frozen per migration since 270).
 *
 * Mark triggers sit on every table a historical per-account mark reads (`accountMarkClpAtYmd` and
 * what it calls), so any write, from any connection, says which account's marks it can have moved
 * and from which (raw) date (`kind = 'mark'`). Each spec lists, for a row `R` (NEW on
 * insert/update, OLD on delete/update), the account(s) and the raw date to log; an UPDATE logs
 * only when one of `watch` changed, and logs both the old and the new row. Each spec carries the
 * rule that turns its rows into a trim (`rule`: how far back a change reaches), read by
 * `markInputChanges.ts` from the newest list ({@link CURRENT_MARK_INPUT_SPECS}).
 *
 * Write triggers (migration 270) sit on every other table the app's caches read, and on the
 * unwatched columns of the mark tables: they log the table alone (`kind = 'write'`), which the
 * cache registry turns into dropping the families that read it (`cacheRegistry.ts`). The tables
 * a write does not log are machine bookkeeping ({@link UNLOGGED_TABLES_270}).
 *
 * Every migration installs its own frozen list: a later schema change adds a migration with a new
 * list, it never edits an earlier one.
 */
/**
 * `account`: an SQL expression for the account (ALL = every account); `when`: an extra
 * condition for the row; `from`: log one row per row of this FROM clause (account = a column
 * of it) instead of a single row.
 */
type LogTarget = { account: string; date: string; when?: string; from?: string };
/**
 * How a logged row turns into a trim (days): `backDays` — how far before the row's own date it can
 * move a mark; `recentDays` — the change re-values every day from this many days before today (a
 * snapshot table); `rateTable` — a rate row: it moves no quantity of an account whose stored
 * quantity is not a peso figure built with rates (`markSeriesStore.ts`).
 */
export type MarkInputRule = { backDays?: number; recentDays?: number; rateTable?: boolean };
type TriggerSpec = { table: string; targets: (r: string) => LogTarget[]; watch: string[]; rule?: MarkInputRule };

const ALL = "NULL";
const FULL_HISTORY = "'0000-01-01'";

/** A movement's endpoint: the date, or the whole history when it is that account's only units row
 * (the equity / crypto / cuota valuation is chosen by whether any units row exists). */
function movementTarget(r: string, col: "account_id" | "from_account_id" | "to_account_id"): LogTarget {
  const acc = `${r}.${col}`;
  return {
    account: acc,
    date: `CASE WHEN ${r}.units_delta IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM movements m2 WHERE m2.id <> ${r}.id AND m2.units_delta IS NOT NULL
          AND (m2.account_id = ${acc} OR m2.from_account_id = ${acc} OR m2.to_account_id = ${acc})
      ) THEN ${FULL_HISTORY} ELSE ${r}.occurred_on END`,
  };
}

/** The mark specs as of migration 265 (frozen). */
const SPECS_265: readonly TriggerSpec[] = [
  {
    table: "movements",
    targets: (r) => [
      movementTarget(r, "account_id"),
      movementTarget(r, "from_account_id"),
      movementTarget(r, "to_account_id"),
    ],
    watch: [
      "account_id", "from_account_id", "to_account_id", "amount", "currency", "counter_amount",
      "counter_currency", "occurred_on", "units_delta", "counter_units_delta", "flow_kind",
    ],
  },
  {
    table: "valuations",
    targets: (r) => [{ account: `${r}.account_id`, date: `${r}.as_of_date` }],
    watch: ["account_id", "as_of_date", "value", "currency", "units_snapshot"],
  },
  {
    table: "cc_statements",
    targets: (r) => [
      { account: `${r}.account_id`, date: `COALESCE(NULLIF(${r}.period_from, ''), ${r}.statement_date)` },
    ],
    watch: [
      "account_id", "statement_date", "period_from", "period_to", "pay_by", "currency",
      "monto_pagado_anterior", "monto_pagado_anterior_date", "source_pdf",
    ],
    // A statement header (pay-by, payment date) affects its whole billing period.
    rule: { backDays: 45 },
  },
  {
    table: "cc_statement_lines",
    targets: (r) => [
      {
        account: `(SELECT account_id FROM cc_statements WHERE id = ${r}.statement_id)`,
        date: `COALESCE(NULLIF(${r}.transaction_date, ''), NULLIF(${r}.posting_date, ''),
          (SELECT statement_date FROM cc_statements WHERE id = ${r}.statement_id))`,
      },
    ],
    watch: [
      "statement_id", "transaction_date", "posting_date", "amount_clp", "amount_usd",
      "installment_flag", "dedupe_key", "merchant",
    ],
  },
  {
    table: "cc_installment_purchases",
    targets: (r) => [{ account: `${r}.account_id`, date: `${r}.purchase_date` }],
    watch: ["account_id", "purchase_date", "total_amount_clp", "cuotas_totales", "merchant"],
  },
  {
    table: "cc_installment_payments",
    targets: (r) => [
      {
        account: `(SELECT account_id FROM cc_installment_purchases WHERE id = ${r}.purchase_id)`,
        date: `(SELECT purchase_date FROM cc_installment_purchases WHERE id = ${r}.purchase_id)`,
      },
    ],
    watch: ["purchase_id", "pay_by_date", "amount_clp"],
  },
  {
    table: "cc_traspaso_deuda_links",
    targets: (r) => [
      {
        account: `${r}.account_id`,
        date: `(SELECT s.statement_date FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
          WHERE l.id = ${r}.usd_line_id)`,
      },
    ],
    watch: ["account_id", "clp_line_id", "usd_line_id", "amount_clp", "amount_usd"],
    rule: { backDays: 75 },
  },
  {
    table: "movement_mirror_merges",
    targets: (r) => [
      {
        account: `(SELECT from_account_id FROM movements WHERE id = ${r}.transfer_movement_id)`,
        date: `MIN(${r}.out_occurred_on, COALESCE(${r}.in_occurred_on, ${r}.out_occurred_on))`,
      },
      {
        account: `(SELECT to_account_id FROM movements WHERE id = ${r}.transfer_movement_id)`,
        date: `MIN(${r}.out_occurred_on, COALESCE(${r}.in_occurred_on, ${r}.out_occurred_on))`,
      },
    ],
    watch: ["transfer_movement_id", "out_occurred_on", "in_occurred_on"],
  },
  {
    table: "loan_payments",
    targets: (r) => [
      {
        account: `(SELECT account_id FROM movements WHERE id = ${r}.movement_id)`,
        date: `(SELECT occurred_on FROM movements WHERE id = ${r}.movement_id)`,
      },
    ],
    watch: [
      "movement_id", "leg", "cuota", "loan_currency", "balance_after", "payment_currency",
      "principal", "extra_principal", "interest",
    ],
  },
  {
    // A rate row moves no day before its own: a card's dollar sub-balance on a day is valued at
    // that day's rate.
    table: "fx_daily",
    targets: (r) => [{ account: ALL, date: `${r}.date` }],
    watch: ["date", "clp_per_usd"],
    rule: { rateTable: true },
  },
  {
    table: "fx_daily_bid_ask",
    targets: (r) => [{ account: ALL, date: `${r}.date` }],
    watch: ["date", "buy_clp_per_usd", "sell_clp_per_usd"],
    rule: { rateTable: true },
  },
  {
    // The Risky Norris proxy reads the Banco Central observado published up to 7 days later.
    table: "fx_daily_bcentral",
    targets: (r) => [{ account: ALL, date: `${r}.date` }],
    watch: ["date", "clp_per_usd"],
    rule: { backDays: 7 },
  },
  {
    // A fund cuota (and the sync state it comes with) can re-value a held holiday block before it.
    table: "fund_unit_daily",
    targets: (r) => [{ account: ALL, date: `${r}.day` }],
    watch: ["series_key", "day", "unit_value", "currency", "note"],
    rule: { backDays: 10 },
  },
  {
    // A close moves the accounts that hold the ticker (crypto accounts carry BTC-USD / ETH-USD),
    // and — when the ticker is in the Risky Norris proxy basket — the proxy-valued Fintual
    // accounts, which are logged as every account. A watchlist-only ticker moves no mark.
    table: "equity_daily",
    targets: (r) => [
      { account: ALL, date: `${r}.trade_date`, when: `EXISTS (SELECT 1 FROM watchlist_composite_holdings h WHERE UPPER(h.ticker) = UPPER(${r}.ticker))` },
      {
        account: "a.id",
        date: `${r}.trade_date`,
        from: `accounts a WHERE UPPER(a.equity_ticker) = UPPER(${r}.ticker)`,
      },
    ],
    watch: ["ticker", "trade_date", "close", "currency"],
  },
  {
    table: "uf_daily",
    targets: (r) => [{ account: ALL, date: `${r}.date` }],
    watch: ["date", "clp_per_uf"],
    rule: { rateTable: true },
  },
  {
    // A split re-frames every price of its ticker before the ex-date (`equitySplits.ts`): the
    // holders' whole history.
    table: "equity_splits",
    targets: (r) => [
      {
        account: "a.id",
        date: FULL_HISTORY,
        from: `accounts a WHERE UPPER(a.equity_ticker) = UPPER(${r}.ticker)`,
      },
    ],
    watch: ["ticker", "ex_date", "numerator", "denominator"],
  },
  {
    // The proxy basket is a snapshot: it re-values every proxy-held day, which are recent.
    table: "watchlist_composite_meta",
    targets: () => [{ account: ALL, date: "NULL" }],
    watch: [
      "bucket_slug", "composition_date", "anchor_fund_unit_clp", "anchor_basket_usd", "anchor_fx_clp",
      "anchor_apv_fund_unit_clp",
    ],
    rule: { recentDays: 30 },
  },
  {
    table: "watchlist_composite_holdings",
    targets: () => [{ account: ALL, date: "NULL" }],
    watch: ["bucket_slug", "ticker", "weight"],
    rule: { recentDays: 30 },
  },
  {
    table: "accounts",
    targets: (r) => [{ account: `${r}.id`, date: FULL_HISTORY }],
    watch: ["asset_group_id", "equity_ticker", "fund_series_key", "import_key"],
  },
  { table: "asset_groups", targets: () => [{ account: ALL, date: FULL_HISTORY }], watch: ["slug", "parent_id"] },
  {
    table: "portfolio_groups",
    targets: () => [{ account: ALL, date: FULL_HISTORY }],
    watch: ["slug", "kind_slug", "parent_id"],
  },
  {
    table: "market_symbols",
    targets: () => [{ account: ALL, date: FULL_HISTORY }],
    watch: ["quote_currency", "market_kind"],
  },
];

/**
 * One INSERT per target. A target that names an account logs only when that account resolves:
 * a transfer row has no `account_id`, and a cascade-deleted child no longer finds its parent
 * (whose own trigger logs the account) — logging NULL there would mean "every account".
 */
function inserts(table: string, targets: LogTarget[]): string {
  return targets
    .map((t) => {
      if (t.from) {
        return `INSERT INTO mark_input_changes (source, account_id, raw_date)
    SELECT '${table}', ${t.account}, ${t.date} FROM ${t.from};`;
      }
      if (t.account === ALL) {
        return t.when
          ? `INSERT INTO mark_input_changes (source, account_id, raw_date) SELECT '${table}', NULL, ${t.date} WHERE ${t.when};`
          : `INSERT INTO mark_input_changes (source, account_id, raw_date) VALUES ('${table}', NULL, ${t.date});`;
      }
      return `INSERT INTO mark_input_changes (source, account_id, raw_date)
    SELECT '${table}', acc, d FROM (SELECT ${t.account} AS acc, ${t.date} AS d) WHERE acc IS NOT NULL${t.when ? ` AND (${t.when})` : ""};`;
    })
    .join("\n  ");
}

export function markInputTriggerSql(spec: TriggerSpec): string[] {
  const { table, targets, watch } = spec;
  const changed = watch.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(" OR ");
  return [
    `CREATE TRIGGER mark_input_${table}_ai AFTER INSERT ON ${table} BEGIN
  ${inserts(table, targets("NEW"))}
END`,
    `CREATE TRIGGER mark_input_${table}_ad AFTER DELETE ON ${table} BEGIN
  ${inserts(table, targets("OLD"))}
END`,
    `CREATE TRIGGER mark_input_${table}_au AFTER UPDATE ON ${table} WHEN ${changed} BEGIN
  ${inserts(table, targets("OLD"))}
  ${inserts(table, targets("NEW"))}
END`,
  ];
}

/**
 * Movement columns added by migrations after 211. SQLite checks a trigger's columns when it
 * FIRES, not at CREATE TRIGGER, so a trigger watching a column the table does not have yet
 * would fail the first UPDATE of movements between 211 and the migration that adds it (on a
 * fresh DB every migration runs in sequence). 211 installs the triggers without them; the
 * migration that adds each column re-installs the full set.
 */
const MOVEMENT_COLUMNS_SINCE_211 = ["counter_units_delta"];

/** Drop every `mark_input_*` trigger and create the given specs' triggers. */
function installMarkInputChangeTriggers(dbi: DatabaseType, specs: readonly TriggerSpec[]): void {
  const existing = dbi
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'mark\\_input\\_%' ESCAPE '\\'`)
    .all() as { name: string }[];
  for (const { name } of existing) dbi.exec(`DROP TRIGGER "${name}"`);
  for (const spec of specs) {
    for (const sql of markInputTriggerSql(spec)) dbi.exec(sql);
  }
}

/**
 * The depto ledger's table before migration 258 (`depto_payments`); 258 replaced it with
 * `loan_payments` + `property_appraisals`. The hooks of 211 / 242 / 243 install this spec in
 * their place: on a fresh DB they run while the old table is the one that exists.
 */
const DEPTO_PAYMENTS_SPEC_BEFORE_258: TriggerSpec = {
  table: "depto_payments",
  targets: (r) => [
    {
      account: `(SELECT account_id FROM movements WHERE id = ${r}.movement_id)`,
      date: `(SELECT occurred_on FROM movements WHERE id = ${r}.movement_id)`,
    },
  ],
  watch: [
    "movement_id", "kind", "cuota", "amount_uf", "credito_restante_uf", "valor_vivienda_uf",
    "amortizacion_uf", "amortizacion_ext_uf", "interes_uf",
  ],
};
/**
 * The property's appraisals between migrations 258 and 260 (`property_appraisals`, UF); 260 moved
 * them into `valuations` and dropped the table. Only the 258 hook installs this spec.
 */
const PROPERTY_APPRAISALS_SPEC_258_TO_260: TriggerSpec = {
  table: "property_appraisals",
  targets: (r) => [{ account: `${r}.account_id`, date: `${r}.as_of_date` }],
  watch: ["account_id", "as_of_date", "value", "currency"],
};

/**
 * `fund_unit_daily` before migration 257: its price was `unit_value_clp` and it had no `currency`
 * (257 renamed it; RENAME COLUMN rewrites the triggers).
 */
function fundUnitSpecBefore257(spec: TriggerSpec): TriggerSpec {
  return {
    ...spec,
    watch: spec.watch.filter((c) => c !== "currency").map((c) => (c === "unit_value" ? "unit_value_clp" : c)),
  };
}

/** Migrations 260–264 (frozen): 265 added `equity_splits`. */
const SPECS_260: readonly TriggerSpec[] = SPECS_265.filter((s) => s.table !== "equity_splits");

/** Migration 258 (frozen): the appraisals still had their own table. */
const SPECS_258: readonly TriggerSpec[] = [...SPECS_260, PROPERTY_APPRAISALS_SPEC_258_TO_260];

/** Migrations 242 and 243 (frozen): before 257 and 258. */
const SPECS_242: readonly TriggerSpec[] = SPECS_260.map((spec) =>
  spec.table === "loan_payments"
    ? DEPTO_PAYMENTS_SPEC_BEFORE_258
    : spec.table === "fund_unit_daily"
      ? fundUnitSpecBefore257(spec)
      : spec
);

/** Migration 211 (frozen): `movements.counter_units_delta` did not exist yet. */
const SPECS_211: readonly TriggerSpec[] = SPECS_242.map((spec) =>
  spec.table === "movements"
    ? { ...spec, watch: spec.watch.filter((c) => !MOVEMENT_COLUMNS_SINCE_211.includes(c)) }
    : spec
);

/**
 * Migration 270 (frozen): the four card tables a mark reads that 211 left out (the owed walk's
 * anchors, the dated header-payment legs, the feed-observed closes, the card config).
 */
const SPECS_270: readonly TriggerSpec[] = [
  ...SPECS_265,
  {
    table: "cc_owed_anchors",
    targets: (r) => [{ account: `${r}.account_id`, date: `${r}.as_of_date` }],
    watch: ["account_id", "as_of_date", "currency", "amount"],
  },
  {
    table: "cc_header_payment_legs",
    targets: (r) => [{ account: `${r}.account_id`, date: `MIN(${r}.paid_on, ${r}.statement_close_iso)` }],
    watch: ["account_id", "statement_close_iso", "currency", "paid_on", "amount"],
    // A leg is header evidence of its statement: it can move the whole billing period.
    rule: { backDays: 45 },
  },
  {
    table: "cc_feed_billing_closes",
    targets: (r) => [{ account: `${r}.account_id`, date: `${r}.close_date` }],
    watch: ["account_id", "billing_month", "close_date", "saldo_inicial_clp", "saldo_inicial_usd"],
    // A close re-frames its billing month, like a statement header.
    rule: { backDays: 45 },
  },
  {
    table: "credit_card_account_config",
    targets: (r) => [{ account: `${r}.account_id`, date: FULL_HISTORY }],
    watch: [
      "cupo_clp", "cupo_usd", "billing_cycle_start_day", "billing_cycle_end_day", "card_last4",
      "nav_retired", "superseded_target_last4", "issuer",
    ],
  },
];

/**
 * Migration 304: an option contract's terms (`option_contracts`) decide its account's mark on
 * every day — the underlying, the strike and the expiry are what the intrinsic value is read
 * from (`holdingPrices.ts`) — so a change re-values the account's whole history.
 */
export const OPTION_CONTRACTS_SPEC: TriggerSpec = {
  table: "option_contracts",
  targets: (r) => [{ account: `${r}.account_id`, date: FULL_HISTORY }],
  watch: ["account_id", "underlying_ticker", "right", "strike", "expiry", "multiplier"],
};

/** Migration 304 (frozen): 270's specs plus the option contract terms. */
const SPECS_304: readonly TriggerSpec[] = [...SPECS_270, OPTION_CONTRACTS_SPEC];

/**
 * Migration 312: `fx_rates` holds the pairs loaded through `currencies` (EUR/USD first). A rate row
 * moves no day before its own, like `fx_daily`.
 */
export const FX_RATES_SPEC: TriggerSpec = {
  table: "fx_rates",
  targets: (r) => [{ account: ALL, date: `${r}.date` }],
  watch: ["base", "quote", "date", "mid"],
  rule: { rateTable: true },
};

/** Migration 312 (frozen): 304's specs plus the generic rate table. */
const SPECS_312: readonly TriggerSpec[] = [...SPECS_304, FX_RATES_SPEC];

/** The newest mark specs: what the database logs now, and the trim rule of each logged table. */
export const CURRENT_MARK_INPUT_SPECS: readonly TriggerSpec[] = SPECS_312;

/** The trim rule of a mark row's table; a table the newest specs do not watch throws. */
export function markInputRuleForSource(source: string): MarkInputRule {
  const spec = CURRENT_MARK_INPUT_SPECS.find((s) => s.table === source);
  if (!spec) throw new Error(`mark_input_changes: no trigger spec for source ${source}`);
  return spec.rule ?? {};
}

/**
 * Tables whose writes migration 270 does not log (frozen): the run, job and message logs, the
 * usage log, the live quotes (a live tick is its own event, `invalidateMarketDataAggregations`),
 * the change log itself and SQLite's own tables. Every other table carries write triggers; a test
 * fails on a table that is in neither list.
 */
export const UNLOGGED_TABLES_270: readonly string[] = [
  "app_messages", "app_notifications", "fx_daily_yahoo_rejected", "ingest_documents", "ingest_runs",
  "jobs", "live_market_quotes", "mark_input_changes", "market_symbol_fetch_errors", "schema_migrations",
  "sqlite_sequence", "sync_log_entries", "usage_endpoint_hourly", "usage_page_views",
];

/** Tables with write triggers as of migration 270 (frozen). */
export const WRITE_LOGGED_TABLES_270: readonly string[] = [
  "account_sync_sources", "accounts", "app_settings", "art107_instruments", "asset_groups",
  "bank_account_balance_checks", "bank_account_balance_snapshots", "bank_account_numbers",
  "bank_transfer_notices", "benchmarks", "broker_read_coverage", "broker_withdrawal_requests", "categories",
  "cc_bank_cupo_captures", "cc_bank_cupo_checks", "cc_bank_cupo_snapshots", "cc_billing_facturado_placeholders",
  "cc_billing_month_balances", "cc_expense_big_groups", "cc_expense_categories",
  "cc_expense_generic_unique_merchants", "cc_expense_line_categories", "cc_expense_line_splits",
  "cc_expense_purchase_big_groups", "cc_expense_purchase_notes", "cc_expense_unique_purchases",
  "cc_facturado_financing_link_purchases", "cc_facturado_financing_links", "cc_feed_billing_closes",
  "cc_feed_installment_plans", "cc_header_payment_legs", "cc_installment_payments", "cc_installment_purchases",
  "cc_manual_payments", "cc_owed_anchors", "cc_planted_payment_lines", "cc_statement_lines", "cc_statements",
  "cc_traspaso_deuda_links", "checking_cartola_imports", "checking_expense_refunds", "checking_gap_deposit_mirrors",
  "checking_income_movement_overrides", "credit_card_account_config", "crypto_movement_kinds",
  "crypto_trade_details", "cuenta_ahorro_deposit_splits", "equity_daily", "equity_dividends", "equity_splits",
  "eur_daily", "expense_accounts", "expense_category_rules", "expense_deposit_links", "expense_entries",
  "expense_groups", "f22_settlements", "fintual_synthetic_retiro_transfers", "fund_unit_daily", "fx_daily",
  "fx_daily_bcentral", "fx_daily_bid_ask", "grocery_branch_merchants", "grocery_brands", "grocery_product_aliases",
  "grocery_products", "grocery_receipt_items", "grocery_receipts", "import_batches", "income_entries",
  "incoming_wire_booking_notices", "incoming_wire_bookings", "incoming_wire_notices", "ipc_daily",
  "ipc_official_monthly", "liability_group_items", "liability_groups", "loan_payments", "market_display_series",
  "market_symbols", "merchant_document_sources", "merchant_receipt_items", "merchant_receipts",
  "merchant_subscription_notices", "mortgage_sheet_imports", "movement_bank_postings",
  "movement_dividend_details", "movement_event_times", "movement_mirror_merges",
  "movement_mirror_pair_rejections", "movement_transfer_notices", "movements", "payment_processor_receipts",
  "payment_receipt_charges", "payroll_afp_rates", "payroll_parameters", "payroll_work_earnings",
  "payslip_advances", "payslip_lines", "pension_account_reads", "pension_contribution_periods",
  "pension_fund_unit_official", "portfolio_group_items", "portfolio_groups", "real_estate_expense_link_rejections",
  "real_estate_expense_links", "recurring_payment_patterns", "recurring_payments",
  "santander_synthetic_cc_payment_transfers", "sii_f22_filed", "sii_informed_dj", "transfer_counterparty_accounts",
  "transfer_notice_movements", "uf_daily", "unemployment_fund_reads", "utility_bills", "utility_service_accounts",
  "utm_daily", "valuations", "vendor_catalog", "watchlist_composite_holdings", "watchlist_composite_meta",
  "watchlist_composite_position_holdings", "watchlist_composite_positions",
];

/** Tables with write triggers now: 270's plus the tables later migrations added with their own. */
/** Logged tables a later migration dropped: their rows moved onto the flows (F9 step 3, 280+), or retired (308). */
const DROPPED_LOGGED_TABLES: ReadonlySet<string> = new Set([
  "checking_expense_refunds",
  "checking_income_movement_overrides",
  "cc_expense_purchase_big_groups",
  "cc_expense_line_splits",
  "cc_facturado_financing_link_purchases",
  "expense_deposit_links",
  "real_estate_expense_links",
  "real_estate_expense_link_rejections",
  "cc_expense_purchase_notes",
  "cc_expense_unique_purchases",
  "checking_gap_deposit_mirrors",
  "cuenta_ahorro_deposit_splits",
  // The retired mortgage-sheet import (migration 308).
  "mortgage_sheet_imports",
]);

export const WRITE_LOGGED_TABLES: readonly string[] = [
  ...WRITE_LOGGED_TABLES_270.filter((t) => !DROPPED_LOGGED_TABLES.has(t)),
  "account_roles",
  "owner_identity",
  "outside_parties",
  "flows",
  "flow_evidence",
  "flow_orphan_assignments",
  "flow_refunds",
  "flow_income_overrides",
  "flow_big_groups",
  "flow_parts",
  "flow_links",
  "flow_link_rejections",
  "flow_notes",
  "flow_categories",
  "sii_issued_fee_receipts",
  "cc_facturado_payment_charges",
  "us_f1040_returns",
  "us_f1040_filed_lines",
  "us_f1040_settlements",
  "option_contracts",
  "option_assignments",
  "tax_residency_periods",
  "mortgage_payment_receipts",
  "mortgage_lender_quotes",
  "flow_first_seen",
  "card_to_card_payments",
  "currencies",
  "fx_rates",
];

/**
 * A table's write triggers: one row naming the table on every insert, delete and update that
 * changes a column (an upsert writing the same values logs nothing). On a table with mark triggers
 * only the updates those leave out (no watched column changed) — the mark rows already name the
 * table for the rest. `columns`: the table's columns when the migration ran.
 */
export function writeLogTriggerSql(table: string, columns: readonly string[], markWatch: readonly string[] | null): string[] {
  const insert = `INSERT INTO mark_input_changes (source, account_id, raw_date, kind) VALUES ('${table}', NULL, NULL, 'write');`;
  const watched = new Set(markWatch ?? []);
  const changed = columns
    .filter((c) => !watched.has(c))
    .map((c) => `OLD."${c}" IS NOT NEW."${c}"`)
    .join(" OR ");
  const unchanged = [...watched].map((c) => `OLD.${c} IS NEW.${c}`);
  const updateWhen = [...unchanged, changed ? `(${changed})` : "0"].join(" AND ");
  const update = `CREATE TRIGGER write_log_${table}_au AFTER UPDATE ON ${table} WHEN ${updateWhen} BEGIN\n  ${insert}\nEND`;
  if (markWatch) return [update];
  return [
    `CREATE TRIGGER write_log_${table}_ai AFTER INSERT ON ${table} BEGIN\n  ${insert}\nEND`,
    `CREATE TRIGGER write_log_${table}_ad AFTER DELETE ON ${table} BEGIN\n  ${insert}\nEND`,
    update,
  ];
}

/** Every trigger name the newest lists install (tests and the schema check). */
export function markInputTriggerNames(): string[] {
  return CURRENT_MARK_INPUT_SPECS.flatMap((s) => ["ai", "ad", "au"].map((k) => `mark_input_${s.table}_${k}`));
}

export function writeLogTriggerNames(): string[] {
  const marked = new Set(CURRENT_MARK_INPUT_SPECS.map((s) => s.table));
  return WRITE_LOGGED_TABLES.flatMap((t) =>
    marked.has(t) ? [`write_log_${t}_au`] : ["ai", "ad", "au"].map((k) => `write_log_${t}_${k}`)
  );
}

export function runMarkInputChangeTriggers211(dbi: DatabaseType): void {
  // A draft of these triggers may already exist (it ran as migration 210): replace them all.
  installMarkInputChangeTriggers(dbi, SPECS_211);
}

/** Migration 242 hook: `movements.counter_units_delta` exists now — watch it on the movements triggers. */
export function runMarkInputChangeTriggers242(dbi: DatabaseType): void {
  installMarkInputChangeTriggers(dbi, SPECS_242);
}

/** Migration 243 hook: `movements.ticker` is gone — re-create the triggers it dropped. */
export function runMarkInputChangeTriggers243(dbi: DatabaseType): void {
  installMarkInputChangeTriggers(dbi, SPECS_242);
}

/** Migration 258 hook: `depto_payments` is gone — watch `loan_payments` and `property_appraisals`. */
export function runMarkInputChangeTriggers258(dbi: DatabaseType): void {
  installMarkInputChangeTriggers(dbi, SPECS_258);
}

/**
 * Migration 260 hook: `valuations` was rebuilt (its triggers went with the old table) and
 * `property_appraisals` is gone (the appraisals are `valuations` rows now).
 */
export function runMarkInputChangeTriggers260(dbi: DatabaseType): void {
  installMarkInputChangeTriggers(dbi, SPECS_260);
}

/** Migration 265 hook: watch `equity_splits`. */
export function runMarkInputChangeTriggers265(dbi: DatabaseType): void {
  installMarkInputChangeTriggers(dbi, SPECS_265);
}

/**
 * Migration 304 hook: watch `option_contracts` (its write triggers: `optionContracts304.ts`). Only
 * the new table's triggers are created — re-installing every mark trigger would put them after
 * the flow triggers of 279 in firing order (SQLite fires the newest trigger first), which
 * `markInputChanges.test.ts` reads as the mark row being the last one logged.
 */
export function runMarkInputChangeTriggers304(dbi: DatabaseType): void {
  for (const k of ["ai", "ad", "au"]) dbi.exec(`DROP TRIGGER IF EXISTS "mark_input_${OPTION_CONTRACTS_SPEC.table}_${k}"`);
  for (const sql of markInputTriggerSql(OPTION_CONTRACTS_SPEC)) dbi.exec(sql);
}

/** Migration 312 hook: watch `fx_rates` (only the new table's triggers, as in 304). */
export function runMarkInputChangeTriggers312(dbi: DatabaseType): void {
  for (const k of ["ai", "ad", "au"]) dbi.exec(`DROP TRIGGER IF EXISTS "mark_input_${FX_RATES_SPEC.table}_${k}"`);
  for (const sql of markInputTriggerSql(FX_RATES_SPEC)) dbi.exec(sql);
}

/**
 * Migration 270 hook: mark triggers on the four card tables 211 missed, and write triggers on every
 * logged table (the column `kind` was added by the migration's SQL).
 */
export function runMarkInputChangeTriggers270(dbi: DatabaseType): void {
  installMarkInputChangeTriggers(dbi, SPECS_270);
  const existing = dbi
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'write\\_log\\_%' ESCAPE '\\'`)
    .all() as { name: string }[];
  for (const { name } of existing) dbi.exec(`DROP TRIGGER "${name}"`);
  const watchByTable = new Map(SPECS_270.map((s) => [s.table, s.watch]));
  for (const table of WRITE_LOGGED_TABLES_270) {
    const columns = (dbi.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((c) => c.name);
    if (columns.length === 0) {
      // A fresh database never gets a table a later migration dropped (the baseline no longer
      // creates it); an existing one still has it here and drops it, triggers included, later.
      if (DROPPED_LOGGED_TABLES.has(table)) continue;
      throw new Error(`migration 270: table ${table} does not exist`);
    }
    for (const sql of writeLogTriggerSql(table, columns, watchByTable.get(table) ?? null)) dbi.exec(sql);
  }
}

/**
 * Migration 303 hook: `market_symbols` and `account_sync_sources` were rebuilt for the `london` /
 * `stocks_london` CHECKs, and a dropped table takes its triggers with it — the mark trigger on
 * `market_symbols` (a symbol's quote currency or market kind re-prices its whole history) and the
 * write-log triggers of both. Re-created from the same specs the write log reads.
 */
export function runMarkInputChangeTriggers303(dbi: DatabaseType): void {
  // Only the rebuilt table's mark triggers, not a reinstall of every mark trigger: SQLite fires the
  // triggers of one event newest first, and the flows-era triggers (279 →) must keep firing before
  // the mark triggers created by 270 — `markInputChanges.test.ts` reads the log in that order.
  const marketSymbolsSpec = SPECS_270.find((s) => s.table === "market_symbols");
  if (!marketSymbolsSpec) throw new Error("migration 303: no mark-input spec for market_symbols");
  for (const suffix of ["ai", "ad", "au"]) dbi.exec(`DROP TRIGGER IF EXISTS "mark_input_market_symbols_${suffix}"`);
  for (const sql of markInputTriggerSql(marketSymbolsSpec)) dbi.exec(sql);
  const watchByTable = new Map(SPECS_270.map((s) => [s.table, s.watch]));
  for (const table of ["market_symbols", "account_sync_sources"] as const) {
    for (const suffix of ["ai", "ad", "au"]) dbi.exec(`DROP TRIGGER IF EXISTS "write_log_${table}_${suffix}"`);
    const columns = (dbi.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((c) => c.name);
    if (columns.length === 0) throw new Error(`migration 303: table ${table} does not exist`);
    for (const sql of writeLogTriggerSql(table, columns, watchByTable.get(table) ?? null)) dbi.exec(sql);
  }
}

/**
 * Migrations 305 and 306 hook part: `market_symbols` gained columns (305: mic, isin, display_symbol,
 * source) and lost one (306: mic), and its write-log UPDATE trigger names every column the mark
 * trigger does not watch, so it is re-created over the current column list. The mark trigger
 * (quote_currency, market_kind) is untouched.
 */
export function recreateMarketSymbolsWriteLogTrigger(dbi: DatabaseType, migration: string): void {
  const spec = SPECS_270.find((s) => s.table === "market_symbols");
  if (!spec) throw new Error(`migration ${migration}: no mark-input spec for market_symbols`);
  for (const suffix of ["ai", "ad", "au"]) dbi.exec(`DROP TRIGGER IF EXISTS "write_log_market_symbols_${suffix}"`);
  const columns = (dbi.prepare(`SELECT name FROM pragma_table_info(?)`).all("market_symbols") as { name: string }[]).map((c) => c.name);
  if (columns.length === 0) throw new Error(`migration ${migration}: table market_symbols does not exist`);
  for (const sql of writeLogTriggerSql("market_symbols", columns, spec.watch ?? null)) dbi.exec(sql);
}

/**
 * Migration 313 hook: `market_display_series` was rebuilt for the `fx_pair` kind, and the dropped
 * table took its write-log triggers with it (it has no mark triggers). Re-created over its columns.
 */
export function runMarketDisplaySeriesFxPair313(dbi: DatabaseType): void {
  const table = "market_display_series";
  for (const suffix of ["ai", "ad", "au"]) dbi.exec(`DROP TRIGGER IF EXISTS "write_log_${table}_${suffix}"`);
  const columns = (dbi.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((c) => c.name);
  if (columns.length === 0) throw new Error(`migration 313: table ${table} does not exist`);
  for (const sql of writeLogTriggerSql(table, columns, null)) dbi.exec(sql);
}

/**
 * Migration 315 hook: `market_symbols`, `equity_daily` and `live_market_quotes` were rebuilt so
 * their currency references `currencies(code)` (NULL for an index level). The dropped tables took
 * their triggers with them: the mark-input and write-log triggers of `market_symbols` and
 * `equity_daily` are re-created from the current specs (only these two tables, as in 303, so the
 * firing order of every other table's triggers is untouched; `live_market_quotes` is not logged).
 * Foreign keys were off for the rebuild: the new references are checked before commit.
 */
export function runMarketTablesAnyCurrency315(dbi: DatabaseType): void {
  for (const table of ["market_symbols", "equity_daily"] as const) {
    const spec = CURRENT_MARK_INPUT_SPECS.find((s) => s.table === table);
    if (!spec) throw new Error(`migration 315: no mark-input spec for ${table}`);
    for (const suffix of ["ai", "ad", "au"]) {
      dbi.exec(`DROP TRIGGER IF EXISTS "mark_input_${table}_${suffix}"`);
      dbi.exec(`DROP TRIGGER IF EXISTS "write_log_${table}_${suffix}"`);
    }
    for (const sql of markInputTriggerSql(spec)) dbi.exec(sql);
    const columns = (dbi.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((c) => c.name);
    if (columns.length === 0) throw new Error(`migration 315: table ${table} does not exist`);
    for (const sql of writeLogTriggerSql(table, columns, spec.watch)) dbi.exec(sql);
  }
  const violations = dbi.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error(`migration 315: foreign_key_check found ${violations.length} violation(s): ${JSON.stringify(violations.slice(0, 5))}`);
  }
}
