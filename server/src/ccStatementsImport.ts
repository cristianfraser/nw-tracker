import { db } from "./db.js";

function parseInt10(s: string): number | null {
  const n = Number(String(s ?? "").replace(/\s+/g, "").replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function parseUsdAmount(s: string): number | null {
  let t = String(s ?? "").trim().replace(/US\$/gi, "").replace(/\$/g, "").trim();
  if (!t) return null;
  const neg = t.startsWith("-");
  if (neg) t = t.slice(1).trim();
  // Chilean-style: 3.290,00 → 3290.00 wrong without comma-decimal rule
  if (/,\d{1,2}$/.test(t)) {
    t = t.replace(/\./g, "").replace(",", ".");
  } else {
    t = t.replace(/,/g, "");
  }
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

function parseOrigAmount(s: string, currency?: string): number | null {
  if (currency === "usd" || String(s).includes("US$")) {
    return parseUsdAmount(s);
  }
  const t = String(s ?? "").trim();
  if (!t) return null;
  const neg = t.startsWith("-");
  const body = neg ? t.slice(1).trim() : t;
  const v = body.replace(/\./g, "").replace(",", ".");
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

type CsvRecord = Record<string, string>;

function statementKey(row: CsvRecord): string {
  return `${row.card_group ?? "A"}\t${row.source_pdf ?? ""}\t${row.statement_date ?? ""}`;
}

function layoutFromRow(row: CsvRecord): string {
  const layout = String(row.parser_layout ?? "").trim();
  if (layout === "international_usd") return "international_usd";
  if (layout.startsWith("wide")) return "wide";
  return "compact";
}

function currencyFromRow(row: CsvRecord): string {
  if (String(row.currency ?? "").toLowerCase() === "usd") return "usd";
  if (layoutFromRow(row) === "international_usd") return "usd";
  return "clp";
}

export function importCcStatementsFromCsvRecords(
  accountId: number,
  records: CsvRecord[]
): { statementCount: number; lineCount: number } {
  db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id IN (
    SELECT id FROM cc_statements WHERE account_id = ?
  )`).run(accountId);
  db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);

  const byStmt = new Map<string, CsvRecord[]>();
  for (const row of records) {
    const k = statementKey(row);
    const list = byStmt.get(k) ?? [];
    list.push(row);
    byStmt.set(k, list);
  }

  const insStmt = db.prepare(`
    INSERT INTO cc_statements (
      account_id, card_group, source_pdf, statement_date, period_from, period_to, pay_by,
      card_last4, card_product, layout, currency,
      saldo_anterior, abono, compras_cargos, deuda_total, monto_facturado
    ) VALUES (
      @account_id, @card_group, @source_pdf, @statement_date, @period_from, @period_to, @pay_by,
      @card_last4, @card_product, @layout, @currency,
      @saldo_anterior, @abono, @compras_cargos, @deuda_total, @monto_facturado
    )
  `);

  const insLine = db.prepare(`
    INSERT INTO cc_statement_lines (
      statement_id, transaction_date, posting_date, place, merchant, description_merged,
      country, amount_orig, orig_currency, amount_clp, amount_usd, installment_flag,
      nro_cuota_current, nro_cuota_total, valor_cuota_mensual_clp, valor_cuota_mensual_usd,
      interest_rate_text, tipo_cuota, dedupe_key, parser_row_id, raw_line
    ) VALUES (
      @statement_id, @transaction_date, @posting_date, @place, @merchant, @description_merged,
      @country, @amount_orig, @orig_currency, @amount_clp, @amount_usd, @installment_flag,
      @nro_cuota_current, @nro_cuota_total, @valor_cuota_mensual_clp, @valor_cuota_mensual_usd,
      @interest_rate_text, @tipo_cuota, @dedupe_key, @parser_row_id, @raw_line
    )
  `);

  let statementCount = 0;
  let lineCount = 0;

  for (const [, rows] of byStmt) {
    const first = rows[0]!;
    const currency = currencyFromRow(first);
    const header = {
      saldo_anterior: parseUsdAmount(String(first.statement_saldo_anterior ?? ""))
        ?? parseInt10(String(first.statement_saldo_anterior ?? "")),
      abono: parseUsdAmount(String(first.statement_abono ?? ""))
        ?? parseInt10(String(first.statement_abono ?? "")),
      compras_cargos: parseUsdAmount(String(first.statement_compras_cargos ?? ""))
        ?? parseInt10(String(first.statement_compras_cargos ?? "")),
      deuda_total: parseUsdAmount(String(first.statement_deuda_total ?? ""))
        ?? parseInt10(String(first.statement_deuda_total ?? "")),
      monto_facturado: (() => {
        const v =
          parseUsdAmount(String(first.statement_monto_facturado ?? "")) ??
          parseInt10(String(first.statement_monto_facturado ?? ""));
        return v != null && v > 0 ? v : null;
      })(),
    };

    const r = insStmt.run({
      account_id: accountId,
      card_group: String(first.card_group ?? "A").trim() || "A",
      source_pdf: String(first.source_pdf ?? "").trim(),
      statement_date: String(first.statement_date ?? "").trim(),
      period_from: String(first.period_from ?? "").trim() || null,
      period_to: String(first.period_to ?? "").trim() || null,
      pay_by: String(first.pay_by ?? "").trim() || null,
      card_last4: String(first.card_last4 ?? "").trim() || null,
      card_product: String(first.card_product ?? "").trim() || null,
      layout: layoutFromRow(first),
      currency,
      saldo_anterior: header.saldo_anterior,
      abono: header.abono,
      compras_cargos: header.compras_cargos,
      deuda_total: header.deuda_total,
      monto_facturado: header.monto_facturado,
    });
    const statementId = Number(r.lastInsertRowid);
    statementCount += 1;

    for (const row of rows) {
      const inst = String(row.installment_flag ?? "").toLowerCase() === "true";
      const amountClp = parseInt10(String(row.amount_clp ?? ""));
      const amountUsd = parseUsdAmount(String(row.amount_usd ?? ""));
      insLine.run({
        statement_id: statementId,
        transaction_date: String(row.transaction_date ?? "").trim() || null,
        posting_date: String(row.posting_date ?? "").trim() || null,
        place: String(row.place ?? "").trim() || null,
        merchant: String(row.merchant ?? "").trim() || null,
        description_merged: String(row.description_merged ?? "").trim() || null,
        country: String(row.country ?? "").trim() || null,
        amount_orig: parseOrigAmount(String(row.amount_orig ?? ""), currency),
        orig_currency: String(row.orig_currency ?? "").trim() || null,
        amount_clp: amountClp,
        amount_usd: amountUsd,
        installment_flag: inst ? 1 : 0,
        nro_cuota_current: parseInt10(String(row.nro_cuota_current ?? "")),
        nro_cuota_total: parseInt10(String(row.nro_cuota_total ?? "")),
        valor_cuota_mensual_clp: parseInt10(String(row.valor_cuota_mensual_clp ?? "")),
        valor_cuota_mensual_usd: parseUsdAmount(String(row.valor_cuota_mensual_usd ?? "")),
        interest_rate_text: String(row.interest_rate_text ?? "").trim() || null,
        tipo_cuota: String(row.tipo_cuota ?? "").trim() || null,
        dedupe_key: String(row.dedupe_key ?? "").trim() || null,
        parser_row_id: String(row.row_id ?? "").trim() || null,
        raw_line: String(row.raw_line ?? "").trim() || null,
      });
      lineCount += 1;
    }
  }

  return { statementCount, lineCount };
}
