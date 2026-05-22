/**
 * Upsert installment purchases + payments from `cfraser/cc-statements-parsed-all.csv` into SQLite.
 *
 * Usage (from repo root or server/):
 *   npx tsx server/scripts/import-cc-parsed-to-db.ts --account-id=NN [--csv=/abs/path.csv] [--dry-run]
 *
 * Requires migration `020_cc_installment_ledger.sql` applied (`npm run migrate`).
 *
 * Replaces all `cc_installment_*` rows for the given account on each run (full reload from CSV),
 * after merging duplicate PDF contracts that shared different `canonical_row_id` (same tarjeta,
 * misma fecha de compra, mismo comercio, mismo nº de cuotas; el monto del contrato se toma como el máximo entre
 * `amount_clp`, `monto_origen_operacion_clp` y `monto_total_a_pagar_clp` para alinear filas resumen «03 CUOTAS COMERC» con cuotas sueltas).
 *
 * After a successful load, upserts month-end `valuations` for this account from the same PDF-derived
 * balances (so Liabilities / patrimonio charts read `valuations`, not a separate runtime series).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { db } from "../src/db.js";
import { readCommaCsvRecords } from "../src/ccParsedCommaCsv.js";
import { resolveInstallmentPayByIso, parseDdMmYyToIso } from "../src/ccInstallmentPayBy.js";
import { recomputeCcBillingMonthBalances } from "../src/ccBillingBalances.js";
import { importCcStatementsFromCsvRecords } from "../src/ccStatementsImport.js";
import { upsertCreditCardValuationsFromLedger } from "../src/ccInstallmentLedgerDb.js";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";
import { loadCreditCardInstallmentPurchases } from "../src/creditCardInstallments.js";
import { backfillMissingInstallmentPaymentsForAccount } from "../src/ccInstallmentPaymentBackfill.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  if (!hit) return undefined;
  return hit.slice(p.length);
}

function parseInt10(s: string): number | null {
  const n = Number(String(s ?? "").replace(/\s+/g, "").replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

/** Full contract principal (cuota única vs total operación en filas resumen del PDF). */
function installmentContractAmountClp(row: Record<string, string>): number {
  const a = parseInt10(String(row.amount_clp ?? "")) ?? 0;
  const b = parseInt10(String(row.monto_origen_operacion_clp ?? "")) ?? 0;
  const c = parseInt10(String(row.monto_total_a_pagar_clp ?? "")) ?? 0;
  return Math.max(a, b, c);
}

type Agg = {
  card_group: string;
  canonical_row_id: string;
  rows: Record<string, string>[];
};

/** One physical installment contract (Visa/Master may emit different canonical_row_id per statement). */
function makeLoanKey(row: Record<string, string>): string | null {
  const cg = String(row.card_group ?? "A").trim() || "A";
  const iso = txDateIso(row);
  const amt = installmentContractAmountClp(row);
  const nt = parseInt10(String(row.nro_cuota_total ?? ""));
  if (!iso || amt <= 0 || nt == null || nt <= 0) return null;
  const merch =
    String(row.merchant ?? "")
      .trim()
      .toUpperCase()
      .slice(0, 96) ||
    String(row.description_merged ?? "")
      .trim()
      .toUpperCase()
      .slice(0, 96);
  if (!merch) return null;
  return `${cg}\t${iso}\t${amt}\t${nt}\t${merch}`;
}

function pickCanonicalForLoan(rows: Record<string, string>[]): string {
  const ids = [
    ...new Set(
      rows
        .map((r) => String(r.canonical_row_id ?? "").trim())
        .filter(Boolean)
    ),
  ].sort();
  return ids[0] ?? "unknown";
}

function stmtSortKey(statementDate: string): number {
  const iso = parseDdMmYyToIso(statementDate);
  if (!iso) return 0;
  return Number(iso.replace(/-/g, ""));
}

function txDateIso(row: Record<string, string>): string | null {
  const raw = String(row.transaction_date ?? row.posting_date ?? "").trim();
  return parseDdMmYyToIso(raw);
}

function main() {
  const accountId = Number(arg("account-id"));
  if (!Number.isFinite(accountId) || accountId <= 0) {
    console.error("Missing or invalid --account-id= (positive integer).");
    process.exit(1);
  }
  const dry = process.argv.includes("--dry-run");
  const csvPath = arg("csv") ?? path.join(resolveCfraserCsvDir(), "cc-statements-parsed-all.csv");

  const acc = db.prepare(`SELECT id FROM accounts WHERE id = ?`).get(accountId) as { id: number } | undefined;
  if (!acc) {
    console.error(`Account ${accountId} not found.`);
    process.exit(1);
  }

  const records = readCommaCsvRecords(csvPath);
  if (records.length === 0) {
    console.error(`No rows read from ${csvPath}`);
    process.exit(1);
  }

  const baselineIds = new Set(loadCreditCardInstallmentPurchases().map((r) => r.purchase_id));

  const byLoan = new Map<string, Agg>();
  for (const row of records) {
    const inst = String(row.installment_flag ?? "").toLowerCase() === "true";
    if (!inst) continue;
    if (installmentContractAmountClp(row) <= 0) continue;
    const loanKey = makeLoanKey(row);
    if (!loanKey) continue;
    const cg = String(row.card_group ?? "A").trim() || "A";
    const g = byLoan.get(loanKey) ?? { card_group: cg, canonical_row_id: "", rows: [] };
    g.rows.push(row);
    g.canonical_row_id = pickCanonicalForLoan(g.rows);
    byLoan.set(loanKey, g);
  }

  const insP = db.prepare(
    `INSERT INTO cc_installment_purchases (
       account_id, card_group, canonical_row_id, dedupe_key, parser_row_id_sample, source_pdf_sample,
       purchase_date, total_amount_clp, cuotas_totales, merchant, description_merged, matched_baseline_purchase_id
     ) VALUES (
       @account_id, @card_group, @canonical_row_id, @dedupe_key, @parser_row_id_sample, @source_pdf_sample,
       @purchase_date, @total_amount_clp, @cuotas_totales, @merchant, @description_merged, @matched_baseline_purchase_id
     )
     ON CONFLICT(account_id, card_group, canonical_row_id) DO UPDATE SET
       dedupe_key = excluded.dedupe_key,
       parser_row_id_sample = excluded.parser_row_id_sample,
       source_pdf_sample = excluded.source_pdf_sample,
       purchase_date = excluded.purchase_date,
       total_amount_clp = excluded.total_amount_clp,
       cuotas_totales = excluded.cuotas_totales,
       merchant = excluded.merchant,
       description_merged = excluded.description_merged,
       matched_baseline_purchase_id = excluded.matched_baseline_purchase_id`
  );

  const insPay = db.prepare(
    `INSERT INTO cc_installment_payments (
       purchase_id, pay_by_date, statement_date, source_pdf, amount_clp, cuota_current, cuota_total, parser_row_id
     ) VALUES (
       @purchase_id, @pay_by_date, @statement_date, @source_pdf, @amount_clp, @cuota_current, @cuota_total, @parser_row_id
     )
     ON CONFLICT(purchase_id, pay_by_date) DO UPDATE SET
       statement_date = excluded.statement_date,
       source_pdf = excluded.source_pdf,
       amount_clp = excluded.amount_clp,
       cuota_current = excluded.cuota_current,
       cuota_total = excluded.cuota_total,
       parser_row_id = excluded.parser_row_id`
  );

  const selId = db.prepare(
    `SELECT id FROM cc_installment_purchases WHERE account_id = ? AND card_group = ? AND canonical_row_id = ?`
  );

  let purchaseUpserts = 0;
  let paymentUpserts = 0;
  let gapFilled = 0;
  let valuationMonthsSynced = 0;
  let statementCount = 0;
  let statementLineCount = 0;
  let billingSnapshots = 0;

  const run = db.transaction(() => {
    if (!dry) {
      db.prepare(
        `DELETE FROM cc_installment_payments WHERE purchase_id IN (SELECT id FROM cc_installment_purchases WHERE account_id = ?)`
      ).run(accountId);
      db.prepare(`DELETE FROM cc_installment_purchases WHERE account_id = ?`).run(accountId);
      const st = importCcStatementsFromCsvRecords(accountId, records);
      statementCount = st.statementCount;
      statementLineCount = st.lineCount;
    }

    for (const agg of byLoan.values()) {
      const sorted = [...agg.rows].sort((a, b) => stmtSortKey(a.statement_date ?? "") - stmtSortKey(b.statement_date ?? ""));
      const first = sorted[0]!;
      let purchaseDate: string | null = null;
      for (const r of sorted) {
        const iso = txDateIso(r);
        if (iso && (!purchaseDate || iso < purchaseDate)) purchaseDate = iso;
      }
      if (!purchaseDate) purchaseDate = parseDdMmYyToIso(first.statement_date ?? "") ?? "2000-01-01";

      let maxTotal = 0;
      let maxCuotas = 0;
      for (const r of sorted) {
        maxTotal = Math.max(maxTotal, installmentContractAmountClp(r));
        const nt = parseInt10(String(r.nro_cuota_total ?? ""));
        if (nt != null && nt > 0) maxCuotas = Math.max(maxCuotas, nt);
      }
      if (maxCuotas <= 0) continue;

      const matched = String(first.matched_excel_row ?? "").trim();
      const matched_baseline = baselineIds.has(matched) ? matched : null;

      const purchaseParams = {
        account_id: accountId,
        card_group: agg.card_group,
        canonical_row_id: agg.canonical_row_id,
        dedupe_key: String(first.dedupe_key ?? "").trim() || null,
        parser_row_id_sample: String(first.row_id ?? "").trim() || null,
        source_pdf_sample: String(first.source_pdf ?? "").trim() || null,
        purchase_date: purchaseDate,
        total_amount_clp: maxTotal,
        cuotas_totales: maxCuotas,
        merchant: String(first.merchant ?? "").trim() || null,
        description_merged: String(first.description_merged ?? "").trim() || null,
        matched_baseline_purchase_id: matched_baseline,
      };

      if (!dry) {
        insP.run(purchaseParams);
      }
      purchaseUpserts++;

      const pid = dry
        ? 0
        : (selId.get(accountId, agg.card_group, agg.canonical_row_id) as { id: number }).id;

      const payGroups = new Map<string, Record<string, string>[]>();
      for (const r of sorted) {
        const pdf = String(r.source_pdf ?? "").trim();
        const sd = String(r.statement_date ?? "").trim();
        const pk = `${pdf}\t${sd}`;
        const list = payGroups.get(pk) ?? [];
        list.push(r);
        payGroups.set(pk, list);
      }

      for (const list of payGroups.values()) {
        const chosen = [...list].sort((a, b) => {
          const da = String(a.is_duplicate_across_statements ?? "").toLowerCase() === "true";
          const dbi = String(b.is_duplicate_across_statements ?? "").toLowerCase() === "true";
          if (da !== dbi) return da ? 1 : -1;
          return String(a.row_id ?? "").localeCompare(String(b.row_id ?? ""));
        })[0]!;

        const payBy = resolveInstallmentPayByIso({
          pay_by: chosen.pay_by,
          statement_date: chosen.statement_date,
          period_to: chosen.period_to,
          transaction_date: chosen.transaction_date,
        });
        if (!payBy) {
          console.warn("skip payment: no pay_by", agg.canonical_row_id, chosen.source_pdf);
          continue;
        }
        const cuotaAmt = parseInt10(String(chosen.valor_cuota_mensual_clp ?? ""));
        if (cuotaAmt == null || cuotaAmt <= 0) continue;
        const ccRaw = String(chosen.nro_cuota_current ?? "").trim();
        const cuota_current = ccRaw ? parseInt10(ccRaw) : null;
        const ct = parseInt10(String(chosen.nro_cuota_total ?? ""));
        const cuota_total = ct != null && ct > 0 ? ct : maxCuotas;

        if (!dry) {
          insPay.run({
            purchase_id: pid,
            pay_by_date: payBy,
            statement_date: String(chosen.statement_date ?? "").trim() || null,
            source_pdf: String(chosen.source_pdf ?? "").trim() || null,
            amount_clp: cuotaAmt,
            cuota_current,
            cuota_total,
            parser_row_id: String(chosen.row_id ?? "").trim() || null,
          });
        }
        paymentUpserts++;
      }
    }
    if (!dry) {
      gapFilled = backfillMissingInstallmentPaymentsForAccount(accountId).inserted;
      valuationMonthsSynced = upsertCreditCardValuationsFromLedger(accountId);
      billingSnapshots = recomputeCcBillingMonthBalances(accountId);
    }
  });

  if (!dry) {
    run();
  } else {
    for (const agg of byLoan.values()) {
      purchaseUpserts++;
      const sorted = [...agg.rows].sort((a, b) => stmtSortKey(a.statement_date ?? "") - stmtSortKey(b.statement_date ?? ""));
      const payGroups = new Map<string, Record<string, string>[]>();
      for (const r of sorted) {
        const pk = `${r.source_pdf}\t${r.statement_date}`;
        const list = payGroups.get(pk) ?? [];
        list.push(r);
        payGroups.set(pk, list);
      }
      paymentUpserts += payGroups.size;
    }
  }

  console.log(
    dry
      ? `[dry-run] would upsert ${purchaseUpserts} purchases and ~${paymentUpserts} payment groups from ${csvPath} (grouped by loan key, not canonical_row_id)`
      : `Upserted ${purchaseUpserts} purchases and ${paymentUpserts} payment rows for account ${accountId} from ${csvPath} (loan-key merge; prior rows for this account were replaced). Statements: ${statementCount} (${statementLineCount} lines). Synthetic cuota gap-fill: ${gapFilled} rows. Valuation sync: ${valuationMonthsSynced}. Billing snapshots: ${billingSnapshots}.`
  );
}

main();
