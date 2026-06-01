import { merchantsMatchForCrossDedupe } from "./ccCrossImportDedupe.js";
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

const dbFindLineByDedupeKey = db.prepare(
  `SELECT l.id, l.origin_card_last4 FROM cc_statement_lines l
   JOIN cc_statements s ON s.id = l.statement_id
   WHERE s.account_id = ? AND l.dedupe_key = ? AND l.dedupe_key IS NOT NULL AND l.dedupe_key != ''
   LIMIT 1`
);

const dbUpdateLineOriginCard = db.prepare(
  `UPDATE cc_statement_lines SET origin_card_last4 = ? WHERE id = ?`
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
    line.billing_month,
    cuota,
  ];
  return parts.join("\t");
}

function lineRole(line: CcExpenseLineForDedupe & { line_role?: string }): string {
  return line.line_role ?? (line.installment_flag ? "installment_cuota" : "purchase");
}

function lineKeepScore(line: CcExpenseLineForDedupe): number {
  let score = 0;
  if (line.category_slug !== "unclassified") score += 100;
  if (line.category_unique) score += 10;
  return score;
}

function pickPreferredExpenseLine<T extends CcExpenseLineForDedupe>(prev: T, next: T): T {
  const prevScore = lineKeepScore(prev);
  const nextScore = lineKeepScore(next);
  if (
    nextScore > prevScore ||
    (nextScore === prevScore && next.statement_line_id > prev.statement_line_id)
  ) {
    return next;
  }
  return prev;
}

/** Same one-shot purchase on web-paste vs PDF (merchant text often differs slightly). */
export function purchaseExpenseLinesMatchForDisplayDedupe(
  a: CcExpenseLineForDedupe,
  b: CcExpenseLineForDedupe
): boolean {
  if (lineRole(a) !== "purchase" || lineRole(b) !== "purchase") return false;
  if (a.account_id !== b.account_id) return false;
  if (a.billing_month !== b.billing_month) return false;
  if (a.amount_clp !== b.amount_clp) return false;
  if ((a.purchase_on ?? "") !== (b.purchase_on ?? "")) return false;
  return merchantsMatchForCrossDedupe(a.merchant_key, b.merchant_key);
}

/** Drop duplicate charges from re-imported PDFs / mixed date formats in dedupe keys. */
export function dedupeFlowCcExpenseLines<T extends CcExpenseLineForDedupe>(
  lines: readonly T[]
): T[] {
  const nonPurchases: T[] = [];
  const purchases: T[] = [];
  for (const line of lines) {
    if (lineRole(line) === "purchase") purchases.push(line);
    else nonPurchases.push(line);
  }

  const best = new Map<string, T>();
  for (const line of nonPurchases) {
    const key = flowCcExpenseLineFingerprint(line);
    const prev = best.get(key);
    best.set(key, prev ? pickPreferredExpenseLine(prev, line) : line);
  }

  const purchaseBest: T[] = [];
  for (const line of purchases) {
    const idx = purchaseBest.findIndex((prev) => purchaseExpenseLinesMatchForDisplayDedupe(prev, line));
    if (idx < 0) purchaseBest.push(line);
    else purchaseBest[idx] = pickPreferredExpenseLine(purchaseBest[idx]!, line);
  }

  return [...best.values(), ...purchaseBest];
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

export function findCcStatementLineIdByDedupeKey(
  accountId: number,
  keys: readonly string[]
): number | null {
  for (const key of keys) {
    if (!key) continue;
    const row = dbFindLineByDedupeKey.get(accountId, key) as { id: number } | undefined;
    if (row) return row.id;
  }
  return null;
}

/** Patch origin_card_last4 on an existing line matched by dedupe key (re-import path). */
export function patchCcLineOriginCardOnDedupeHit(
  accountId: number,
  dedupeKeys: readonly string[],
  originCardLast4: string | null
): { lineId: number | null; patched: boolean } {
  if (!originCardLast4) {
    return { lineId: findCcStatementLineIdByDedupeKey(accountId, dedupeKeys), patched: false };
  }
  for (const key of dedupeKeys) {
    if (!key) continue;
    const row = dbFindLineByDedupeKey.get(accountId, key) as
      | { id: number; origin_card_last4: string | null }
      | undefined;
    if (!row) continue;
    if (row.origin_card_last4 === originCardLast4) {
      return { lineId: row.id, patched: false };
    }
    dbUpdateLineOriginCard.run(originCardLast4, row.id);
    return { lineId: row.id, patched: true };
  }
  return { lineId: null, patched: false };
}
