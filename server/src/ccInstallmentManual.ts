import { InputError } from "./inputError.js";
import { ccIssuerSlugForMasterAccount } from "./ccIssuerForAccount.js";
import { ccCardGroupOrDefault } from "./ccIssuers.js";
import { db } from "./db.js";
import {
  applyCardLinePlan,
  planOneShotLinesForInstallmentPurchase,
  selLineCategory,
  upsertUniqueCat,
} from "./ccCrossImportDedupe.js";
import { backfillMissingInstallmentPaymentsForPlans } from "./ccInstallmentPaymentBackfill.js";
import {
  noteCardLineEvidence,
  noteCardLineFinancingLinks,
  withCardLineSession,
} from "./cards/lineWriteSession.js";
import { stableInstallmentHPurchaseKeyFromLedgerArgs } from "./ccExpenseCategories.js";
import { firstCuotaBillingMonth, type CcCuotaPurchaseKind } from "./ccCuotaPurchaseKinds.js";
import { billingMonthContainingPurchase } from "./cards/facturacion.js";
import { parseDdMmYyToIso } from "nw-tracker-contracts";

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
  input: ManualCcPurchaseInput,
  opts?: { removeSupersededOneShotLines?: boolean; sourceLineId?: number }
): { id: number; canonical_row_id: string } {
  const purchaseDate = parsePurchaseDateIso(input.purchase_date);
  if (!purchaseDate) throw new InputError("invalid purchase_date");
  const principal = Math.trunc(input.total_amount_clp);
  const cuotas = Math.trunc(input.cuotas_totales);
  if (principal <= 0 || cuotas <= 0) throw new InputError("principal and cuotas must be positive");

  const canonical = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const cardGroup = ccCardGroupOrDefault(input.card_group);
  const merchant = String(input.merchant ?? input.description ?? "Compra manual").trim() || "Compra manual";

  return withCardLineSession(accountId, "manual installment plan", () => {
    const r = db
      .prepare(
        `INSERT INTO cc_installment_purchases (
           account_id, card_group, canonical_row_id, purchase_date, total_amount_clp,
           cuotas_totales, merchant, description_merged, source, source_line_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`
      )
      .run(
        accountId,
        cardGroup,
        canonical,
        purchaseDate,
        principal,
        cuotas,
        merchant,
        input.description?.trim() || null,
        opts?.sourceLineId ?? null
      );

    const purchaseId = Number(r.lastInsertRowid);
    // Fuzzy cross-source dedupe (merchant + date + amount tolerance) is only appropriate
    // when the caller has no exact source line — e.g. a hand-entered manual purchase that
    // supersedes a previously imported one-shot line. A conversion names its line
    // (`sourceLineId`) and keeps it, so a second same-merchant/same-day line is never
    // collateral-deleted.
    if (opts?.removeSupersededOneShotLines !== false && opts?.sourceLineId == null) {
      applyCardLinePlan(accountId, planOneShotLinesForInstallmentPurchase(accountId, purchaseId));
    }
    // The contract consumes cupo on its purchase date, so stamps written after it are stale. A
    // hand-entered plan, or a tagged feed purchase given its count, may be the one that paid
    // another card's facturado.
    noteCardLineEvidence(accountId, purchaseDate);
    noteCardLineFinancingLinks(accountId);
    return { id: purchaseId, canonical_row_id: canonical };
  });
}

export function updateManualCcInstallmentPurchase(
  accountId: number,
  purchaseId: number,
  patch: Partial<ManualCcPurchaseInput>
): void {
  const row = db
    .prepare(
      `SELECT id, source, purchase_date, source_line_id FROM cc_installment_purchases WHERE id = ? AND account_id = ?`
    )
    .get(purchaseId, accountId) as
    | { id: number; source: string; purchase_date: string | null; source_line_id: number | null }
    | undefined;
  if (!row) throw new InputError("purchase not found");
  if (row.source !== "manual") throw new InputError("only manual purchases can be edited");
  // A plan converted from a line takes its day, principal and merchant from the line: only the
  // count is the plan's own (the purchases module pairs the two by those facts).
  if (
    row.source_line_id != null &&
    (patch.purchase_date != null || patch.total_amount_clp != null || patch.merchant != null)
  ) {
    throw new InputError("a plan converted from a card line takes its date, amount and merchant from the line");
  }

  // A moved contract invalidates stamps after BOTH its old and new dates.
  let affectedFrom: string | null = row.purchase_date ?? null;
  const fields: string[] = [];
  const params: unknown[] = [];
  if (patch.purchase_date != null) {
    const iso = parsePurchaseDateIso(patch.purchase_date);
    if (!iso) throw new InputError("invalid purchase_date");
    if (affectedFrom == null || iso < affectedFrom) affectedFrom = iso;
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
  withCardLineSession(accountId, "manual installment plan edit", () => {
    db.prepare(
      `UPDATE cc_installment_purchases SET ${fields.join(", ")} WHERE id = ? AND account_id = ?`
    ).run(...params);
    // A new count moves which cuotas a statement's printed ones fill.
    if (patch.cuotas_totales != null) backfillMissingInstallmentPaymentsForPlans([purchaseId]);
    noteCardLineEvidence(accountId, affectedFrom);
  });
}

const selStatementLineForConvert = db.prepare(`
  SELECT l.id, l.merchant, l.transaction_date, l.posting_date, l.amount_clp,
         l.installment_flag, l.cuota_purchase_kind, s.account_id, s.card_group
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
  if (cuotas <= 0) throw new InputError("cuotas_totales must be positive");

  const line = selStatementLineForConvert.get(lineId) as
    | {
        id: number;
        merchant: string | null;
        transaction_date: string | null;
        posting_date: string | null;
        amount_clp: number | null;
        installment_flag: number;
        cuota_purchase_kind: CcCuotaPurchaseKind | null;
        account_id: number;
        card_group: string | null;
      }
    | undefined;

  if (!line) throw new InputError("statement line not found");
  if (line.account_id !== accountId) throw new InputError("line does not belong to this account");
  if (line.installment_flag !== 0) throw new InputError("line is already an installment line");
  if (!line.amount_clp || line.amount_clp <= 0) throw new InputError("line has no positive CLP amount");

  const purchaseDateIso =
    parseDdMmYyToIso(line.transaction_date ?? "") ??
    parseDdMmYyToIso(line.posting_date ?? "");
  if (!purchaseDateIso) throw new InputError("line has no parseable purchase date");

  if (
    db.prepare(`SELECT 1 FROM cc_installment_purchases WHERE source_line_id = ?`).get(lineId) != null
  ) {
    throw new InputError("line is already converted to a plan");
  }

  return withCardLineSession(accountId, "convert a line to cuotas", () => {
    // The plan's expense carries the line's category (an «Único» row under the plan's key); the
    // line keeps its own rows, so deleting the plan leaves it as it was.
    const cat = selLineCategory.get(lineId) as { category_id: number } | undefined;
    if (cat?.category_id != null) {
      const purchaseKey = stableInstallmentHPurchaseKeyFromLedgerArgs({
        accountId,
        purchaseDateIso,
        cuotasTotales: cuotas,
        totalAmountClp: line.amount_clp!,
        merchant: line.merchant,
      });
      upsertUniqueCat.run(accountId, purchaseKey, cat.category_id);
    }

    // The plan overlays the line (`source_line_id`): the line stays on file, the purchases module
    // counts the purchase once, as the plan.
    const created = createManualCcInstallmentPurchase(
      accountId,
      {
        purchase_date: purchaseDateIso,
        total_amount_clp: line.amount_clp!,
        cuotas_totales: cuotas,
        merchant: line.merchant ?? undefined,
        card_group: line.card_group ?? undefined,
      },
      { sourceLineId: lineId }
    );
    // A line the card feed typed as a cuota purchase (count unknown until now) knows when its first
    // cuota bills — the rule the feed import applies to the plans it creates itself: «cuota
    // comercio» at the close after the purchase cycle, «precio contado» at the purchase cycle's own.
    // The manual guess (the purchase's own cycle) is right for the second only.
    if (line.cuota_purchase_kind) {
      db.prepare(`UPDATE cc_installment_purchases SET first_due_month = ? WHERE id = ?`).run(
        firstCuotaBillingMonth(
          ccIssuerSlugForMasterAccount(accountId),
          line.cuota_purchase_kind,
          billingMonthContainingPurchase(accountId, purchaseDateIso)
        ),
        created.id
      );
    }
    return created;
  });
}

export function deleteManualCcInstallmentPurchase(accountId: number, purchaseId: number): void {
  const row = db
    .prepare(
      `SELECT id, source, purchase_date FROM cc_installment_purchases WHERE id = ? AND account_id = ?`
    )
    .get(purchaseId, accountId) as
    | { id: number; source: string; purchase_date: string | null }
    | undefined;
  if (!row) throw new InputError("purchase not found");
  if (row.source !== "manual") throw new InputError("only manual purchases can be deleted");
  // Undo of a conversion too: the line the plan overlaid is live again, its category, note and big
  // group as they were.
  withCardLineSession(accountId, "manual installment plan delete", () => {
    db.prepare(`DELETE FROM cc_installment_purchases WHERE id = ? AND account_id = ?`).run(purchaseId, accountId);
    noteCardLineEvidence(accountId, row.purchase_date ?? null);
  });
}
