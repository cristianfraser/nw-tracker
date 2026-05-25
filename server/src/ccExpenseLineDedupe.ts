import { db } from "./db.js";
import { ccOneShotDedupeKey } from "./ccDedupeKey.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";

export type CcExpenseLineForDedupe = {
  account_id: number;
  merchant_key: string;
  amount_clp: number;
  purchase_on: string | null;
  billing_month: string;
  installment_flag: number;
  nro_cuota_current: number | null;
  nro_cuota_total: number | null;
  statement_line_id: number;
  category_slug: string;
  category_unique: boolean;
};

const dbCheckDedupeKey = db.prepare(
  `SELECT 1 AS o FROM cc_statement_lines l
   JOIN cc_statements s ON s.id = l.statement_id
   WHERE s.account_id = ? AND l.dedupe_key = ? AND l.dedupe_key IS NOT NULL AND l.dedupe_key != ''
   LIMIT 1`
);

/** Stable display key for gastos lines (normalized purchase date). */
export function flowCcExpenseLineFingerprint(
  line: CcExpenseLineForDedupe & { line_role?: string }
): string {
  const cuota = line.installment_flag
    ? `${line.nro_cuota_current ?? ""}/${line.nro_cuota_total ?? ""}`
    : "";
  const role =
    line.line_role ?? (line.installment_flag ? "installment_cuota" : "purchase");
  const parts = [
    role,
    line.account_id,
    line.merchant_key,
    line.amount_clp,
    line.purchase_on ?? "",
  ];
  // Installment cuotas are one row per purchase+cuota; billing month differs between PDF and ledger.
  if (role !== "installment_cuota") {
    parts.push(line.billing_month);
  }
  parts.push(cuota);
  return parts.join("\t");
}

function lineKeepScore(line: CcExpenseLineForDedupe): number {
  let score = 0;
  if (line.category_slug !== "unclassified") score += 100;
  if (line.category_unique) score += 10;
  return score;
}

/** Drop duplicate charges from re-imported PDFs / mixed date formats in dedupe keys. */
export function dedupeFlowCcExpenseLines<T extends CcExpenseLineForDedupe>(
  lines: readonly T[]
): T[] {
  const best = new Map<string, T>();
  for (const line of lines) {
    const key = flowCcExpenseLineFingerprint(line);
    const prev = best.get(key);
    if (!prev) {
      best.set(key, line);
      continue;
    }
    const prevScore = lineKeepScore(prev);
    const nextScore = lineKeepScore(line);
    if (
      nextScore > prevScore ||
      (nextScore === prevScore && line.statement_line_id > prev.statement_line_id)
    ) {
      best.set(key, line);
    }
  }
  return [...best.values()];
}

export type CcStatementCsvDedupeRow = {
  installment_flag?: string;
  transaction_date?: string;
  posting_date?: string;
  merchant?: string;
  amount_clp?: string;
  dedupe_key?: string;
};

/** Canonical dedupe keys for import (ISO purchase date). */
export function canonicalCcLineDedupeKeys(
  cardGroup: string,
  row: CcStatementCsvDedupeRow
): string[] {
  const keys = new Set<string>();
  const fromCsv = String(row.dedupe_key ?? "").trim();
  if (fromCsv) keys.add(fromCsv);

  const inst = String(row.installment_flag ?? "").toLowerCase() === "true";
  if (inst) return [...keys];

  const amountRaw = String(row.amount_clp ?? "").replace(/\s+/g, "").replace(/\./g, "");
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) return [...keys];

  const dateIso =
    parseDdMmYyToIso(String(row.transaction_date ?? "").trim()) ??
    parseDdMmYyToIso(String(row.posting_date ?? "").trim());
  if (!dateIso) return [...keys];

  keys.add(
    ccOneShotDedupeKey(cardGroup, String(row.merchant ?? ""), Math.trunc(amount), dateIso)
  );
  return [...keys];
}

export function ccLineDedupeKeyExistsOnAccount(accountId: number, keys: readonly string[]): boolean {
  if (keys.length === 0) return false;
  for (const key of keys) {
    if (!key) continue;
    const row = dbCheckDedupeKey.get(accountId, key) as { o: number } | undefined;
    if (row) return true;
  }
  return false;
}
