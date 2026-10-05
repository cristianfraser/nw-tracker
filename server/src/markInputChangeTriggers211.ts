import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Migration 211 hook: the triggers that fill `mark_input_changes` — on every table a historical
 * per-account mark reads (`accountMarkClpAtYmd` and what it calls), so any write, from any
 * connection, says which account's marks it can have moved and from which (raw) date. The
 * per-table rules that turn a row into a trim live in `markInputChanges.ts`.
 *
 * Each spec lists, for a row `R` (NEW on insert/update, OLD on delete/update), the account(s)
 * and the raw date to log; an UPDATE logs only when one of `watch` changed, and logs both the
 * old and the new row.
 */
/**
 * `account`: an SQL expression for the account (ALL = every account); `when`: an extra
 * condition for the row; `from`: log one row per row of this FROM clause (account = a column
 * of it) instead of a single row.
 */
type LogTarget = { account: string; date: string; when?: string; from?: string };
type TriggerSpec = { table: string; targets: (r: string) => LogTarget[]; watch: string[] };

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

export const MARK_INPUT_TRIGGER_SPECS: TriggerSpec[] = [
  {
    table: "movements",
    targets: (r) => [
      movementTarget(r, "account_id"),
      movementTarget(r, "from_account_id"),
      movementTarget(r, "to_account_id"),
    ],
    watch: [
      "account_id", "from_account_id", "to_account_id", "amount", "currency", "counter_amount",
      "counter_currency", "occurred_on", "units_delta", "flow_kind", "ticker",
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
  },
  { table: "fx_daily", targets: (r) => [{ account: ALL, date: `${r}.date` }], watch: ["date", "clp_per_usd"] },
  {
    table: "fx_daily_bid_ask",
    targets: (r) => [{ account: ALL, date: `${r}.date` }],
    watch: ["date", "buy_clp_per_usd", "sell_clp_per_usd"],
  },
  {
    table: "fx_daily_bcentral",
    targets: (r) => [{ account: ALL, date: `${r}.date` }],
    watch: ["date", "clp_per_usd"],
  },
  {
    table: "fund_unit_daily",
    targets: (r) => [{ account: ALL, date: `${r}.day` }],
    watch: ["series_key", "day", "unit_value_clp", "note"],
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
  { table: "uf_daily", targets: (r) => [{ account: ALL, date: `${r}.date` }], watch: ["date", "clp_per_uf"] },
  {
    table: "watchlist_composite_meta",
    targets: () => [{ account: ALL, date: "NULL" }],
    watch: [
      "bucket_slug", "composition_date", "anchor_fund_unit_clp", "anchor_basket_usd", "anchor_fx_clp",
      "anchor_apv_fund_unit_clp",
    ],
  },
  {
    table: "watchlist_composite_holdings",
    targets: () => [{ account: ALL, date: "NULL" }],
    watch: ["bucket_slug", "ticker", "weight"],
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

/** Every trigger name this hook creates (tests and the schema check). */
export function markInputTriggerNames(): string[] {
  return MARK_INPUT_TRIGGER_SPECS.flatMap((s) => ["ai", "ad", "au"].map((k) => `mark_input_${s.table}_${k}`));
}

export function runMarkInputChangeTriggers211(dbi: DatabaseType): void {
  // A draft of these triggers may already exist (it ran as migration 210): replace them all.
  const existing = dbi
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'mark\\_input\\_%' ESCAPE '\\'`)
    .all() as { name: string }[];
  for (const { name } of existing) dbi.exec(`DROP TRIGGER "${name}"`);
  for (const spec of MARK_INPUT_TRIGGER_SPECS) {
    for (const sql of markInputTriggerSql(spec)) dbi.exec(sql);
  }
}
