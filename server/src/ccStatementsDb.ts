import { db } from "./db.js";
import { billingMonthForCcStatement } from "./ccBillingMonth.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";

export type CcStatementRow = {
  id: number;
  account_id: number;
  card_group: string;
  source_pdf: string;
  statement_date: string;
  statement_date_iso: string;
  period_from: string | null;
  period_to: string | null;
  pay_by: string | null;
  pay_by_iso: string | null;
  card_last4: string | null;
  card_product: string | null;
  layout: string;
  currency: string;
  saldo_anterior: number | null;
  abono: number | null;
  compras_cargos: number | null;
  deuda_total: number | null;
  monto_facturado: number | null;
  billing_month: string | null;
};

export type CcStatementLineRow = {
  id: number;
  statement_id: number;
  transaction_date: string | null;
  posting_date: string | null;
  place: string | null;
  merchant: string | null;
  description_merged: string | null;
  country: string | null;
  amount_orig: number | null;
  orig_currency: string | null;
  amount_clp: number | null;
  amount_usd: number | null;
  installment_flag: boolean;
  nro_cuota_current: number | null;
  nro_cuota_total: number | null;
  valor_cuota_mensual_clp: number | null;
  valor_cuota_mensual_usd: number | null;
  interest_rate_text: string | null;
  tipo_cuota: string | null;
  dedupe_key: string | null;
  parser_row_id: string | null;
  raw_line: string | null;
};

function isoFromField(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return parseDdMmYyToIso(t);
}

export function ccStatementRowCount(accountId: number): number {
  const r = db
    .prepare(`SELECT COUNT(*) AS c FROM cc_statements WHERE account_id = ?`)
    .get(accountId) as { c: number };
  return Number(r?.c ?? 0);
}

export function listCcStatementsForAccount(accountId: number): CcStatementRow[] {
  const rows = db
    .prepare(
      `SELECT id, account_id, card_group, source_pdf, statement_date, period_from, period_to, pay_by,
              card_last4, card_product, layout, currency,
              saldo_anterior, abono, compras_cargos, deuda_total, monto_facturado
       FROM cc_statements WHERE account_id = ?
       ORDER BY statement_date DESC, card_group, source_pdf`
    )
    .all(accountId) as Omit<CcStatementRow, "statement_date_iso" | "pay_by_iso" | "billing_month">[];

  return rows.map((r) => {
    const statement_date_iso = isoFromField(r.statement_date) ?? r.statement_date;
    return {
      ...r,
      statement_date_iso,
      pay_by_iso: isoFromField(r.pay_by),
      billing_month: billingMonthForCcStatement({
        statement_date: r.statement_date,
        period_to: r.period_to,
      }),
    };
  });
}

export function listCcStatementLinesForStatement(statementId: number): CcStatementLineRow[] {
  const rows = db
    .prepare(
      `SELECT id, statement_id, transaction_date, posting_date, place, merchant, description_merged,
              country, amount_orig, orig_currency, amount_clp, amount_usd, installment_flag,
              nro_cuota_current, nro_cuota_total, valor_cuota_mensual_clp, valor_cuota_mensual_usd,
              interest_rate_text, tipo_cuota, dedupe_key, parser_row_id, raw_line
       FROM cc_statement_lines WHERE statement_id = ?
       ORDER BY transaction_date, id`
    )
    .all(statementId) as (Omit<CcStatementLineRow, "installment_flag"> & { installment_flag: number })[];

  return rows.map((r) => ({
    ...r,
    installment_flag: r.installment_flag === 1,
  }));
}

export function ccStatementsPayloadForAccount(accountId: number): {
  statements: (CcStatementRow & { lines: CcStatementLineRow[] })[];
} {
  const statements = listCcStatementsForAccount(accountId);
  return {
    statements: statements.map((s) => ({
      ...s,
      lines: listCcStatementLinesForStatement(s.id),
    })),
  };
}
