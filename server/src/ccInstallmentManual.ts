import { db } from "./db.js";
import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import {
  removeOneShotLinesForInstallmentPurchase,
  selLineCategory,
  upsertUniqueCat,
} from "./ccCrossImportDedupe.js";
import { upsertCreditCardValuationsFromLedger } from "./ccCreditCardValuations.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { stableInstallmentHPurchaseKeyFromLedgerArgs } from "./ccExpenseCategories.js";

export type ManualCcPurchaseInput = {
  purchase_date: string;
  total_amount_clp: number;
  cuotas_totales: number;
  merchant?: string;
  description?: string;
  annual_interest_pct?: number;
  card_group?: string;
};

function parsePurchaseDateIso(raw: string): string | null {
  const t = String(raw ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return parseDdMmYyToIso(t);
}

export function createManualCcInstallmentPurchase(
  accountId: number,
  input: ManualCcPurchaseInput
): { id: number; canonical_row_id: string } {
  const purchaseDate = parsePurchaseDateIso(input.purchase_date);
  if (!purchaseDate) throw new Error("invalid purchase_date");
  const principal = Math.trunc(input.total_amount_clp);
  const cuotas = Math.trunc(input.cuotas_totales);
  if (principal <= 0 || cuotas <= 0) throw new Error("principal and cuotas must be positive");

  const canonical = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const cardGroup = String(input.card_group ?? "A").trim() || "A";
  const merchant = String(input.merchant ?? input.description ?? "Compra manual").trim() || "Compra manual";

  const r = db
    .prepare(
      `INSERT INTO cc_installment_purchases (
         account_id, card_group, canonical_row_id, purchase_date, total_amount_clp,
         cuotas_totales, merchant, description_merged, source
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual')`
    )
    .run(
      accountId,
      cardGroup,
      canonical,
      purchaseDate,
      principal,
      cuotas,
      merchant,
      input.description?.trim() || null
    );

  const purchaseId = Number(r.lastInsertRowid);
  removeOneShotLinesForInstallmentPurchase(accountId, purchaseId);

  upsertCreditCardValuationsFromLedger(accountId);
  recomputeCcBillingMonthBalances(accountId);

  return { id: purchaseId, canonical_row_id: canonical };
}

export function updateManualCcInstallmentPurchase(
  accountId: number,
  purchaseId: number,
  patch: Partial<ManualCcPurchaseInput>
): void {
  const row = db
    .prepare(
      `SELECT id, source FROM cc_installment_purchases WHERE id = ? AND account_id = ?`
    )
    .get(purchaseId, accountId) as { id: number; source: string } | undefined;
  if (!row) throw new Error("purchase not found");
  if (row.source !== "manual") throw new Error("only manual purchases can be edited");

  const fields: string[] = [];
  const params: unknown[] = [];
  if (patch.purchase_date != null) {
    const iso = parsePurchaseDateIso(patch.purchase_date);
    if (!iso) throw new Error("invalid purchase_date");
    fields.push("purchase_date = ?");
    params.push(iso);
  }
  if (patch.total_amount_clp != null) {
    fields.push("total_amount_clp = ?");
    params.push(Math.trunc(patch.total_amount_clp));
  }
  if (patch.cuotas_totales != null) {
    fields.push("cuotas_totales = ?");
    params.push(Math.trunc(patch.cuotas_totales));
  }
  if (patch.merchant != null) {
    fields.push("merchant = ?");
    params.push(patch.merchant.trim() || null);
  }
  if (patch.description != null) {
    fields.push("description_merged = ?");
    params.push(patch.description.trim() || null);
  }
  if (fields.length === 0) return;
  params.push(purchaseId, accountId);
  db.prepare(
    `UPDATE cc_installment_purchases SET ${fields.join(", ")} WHERE id = ? AND account_id = ?`
  ).run(...params);

  upsertCreditCardValuationsFromLedger(accountId);
  recomputeCcBillingMonthBalances(accountId);
}

const selStatementLineForConvert = db.prepare(`
  SELECT l.id, l.merchant, l.transaction_date, l.posting_date, l.amount_clp,
         l.installment_flag, s.account_id, s.card_group
  FROM cc_statement_lines l
  JOIN cc_statements s ON s.id = l.statement_id
  WHERE l.id = ?
`);

export function convertStatementLineToInstallmentPurchase(
  accountId: number,
  lineId: number,
  cuotasTotales: number
): { id: number; canonical_row_id: string } {
  const cuotas = Math.trunc(cuotasTotales);
  if (cuotas <= 0) throw new Error("cuotas_totales must be positive");

  const line = selStatementLineForConvert.get(lineId) as
    | {
        id: number;
        merchant: string | null;
        transaction_date: string | null;
        posting_date: string | null;
        amount_clp: number | null;
        installment_flag: number;
        account_id: number;
        card_group: string | null;
      }
    | undefined;

  if (!line) throw new Error("statement line not found");
  if (line.account_id !== accountId) throw new Error("line does not belong to this account");
  if (line.installment_flag !== 0) throw new Error("line is already an installment line");
  if (!line.amount_clp || line.amount_clp <= 0) throw new Error("line has no positive CLP amount");

  const purchaseDateIso =
    parseDdMmYyToIso(line.transaction_date ?? "") ??
    parseDdMmYyToIso(line.posting_date ?? "");
  if (!purchaseDateIso) throw new Error("line has no parseable purchase date");

  // Transfer category before the line is deleted by createManualCcInstallmentPurchase
  const cat = selLineCategory.get(lineId) as { category_id: number } | undefined;
  if (cat?.category_id != null) {
    const purchaseKey = stableInstallmentHPurchaseKeyFromLedgerArgs({
      accountId,
      purchaseDateIso,
      cuotasTotales: cuotas,
      merchant: line.merchant,
    });
    upsertUniqueCat.run(accountId, purchaseKey, cat.category_id);
  }

  return createManualCcInstallmentPurchase(accountId, {
    purchase_date: purchaseDateIso,
    total_amount_clp: line.amount_clp,
    cuotas_totales: cuotas,
    merchant: line.merchant ?? undefined,
    card_group: line.card_group ?? undefined,
  });
}

export function deleteManualCcInstallmentPurchase(accountId: number, purchaseId: number): void {
  const row = db
    .prepare(
      `SELECT id, source FROM cc_installment_purchases WHERE id = ? AND account_id = ?`
    )
    .get(purchaseId, accountId) as { id: number; source: string } | undefined;
  if (!row) throw new Error("purchase not found");
  if (row.source !== "manual") throw new Error("only manual purchases can be deleted");
  db.prepare(`DELETE FROM cc_installment_purchases WHERE id = ? AND account_id = ?`).run(
    purchaseId,
    accountId
  );
  upsertCreditCardValuationsFromLedger(accountId);
  recomputeCcBillingMonthBalances(accountId);
}
