/**
 * A card plan as the installment ledger computes it (`ccInstallmentLedgerDb.ts`) and the card page
 * shows it (`creditCardInstallments.ts`). Leaf types: the ledger reads them without importing the
 * page builder.
 */
import type { ExpenseLinkLabel, PaymentReceipt } from "nw-tracker-contracts/dto/flows";
import type { DataOrigin } from "../dataOrigin.js";

export type CcInstallmentPurchaseRow = {
  purchase_id: string;
  label: string;
  principal_clp: number;
  installment_count: number;
  installments_paid: number;
  cuota_clp: number;
  /** Calendar month (YYYY-MM) of installment index 0 (first cuota of the contract). */
  first_due_month: string;
  purchase_month: string | null;
};

/** A cuota of an installment plan as the progress bar shows it. */
export type CcCuotaProgressCuota = {
  /** 1-based cuota number. */
  index: number;
  /** Facturación that billed it (a statement row's month) or will (the plan schedule). */
  billing_month: string;
  /** Pay-by of the statement that billed it (ISO); null until a statement prints it. */
  pay_by_date: string | null;
  /** Statement close that billed it (ISO); null until a statement prints it. */
  statement_date: string | null;
  amount_clp: number;
  /** paid = settled by the schedule; billed = printed on a statement not yet counted paid; pending = not billed yet. */
  status: "paid" | "billed" | "pending";
};

export type CcCuotaProgress = {
  /** Σ printed cuotas: above the principal on an interest plan, which is what is actually paid. */
  total_clp: number;
  paid_clp: number;
  billed_clp: number;
  pending_clp: number;
  paid_count: number;
  cuotas: CcCuotaProgressCuota[];
};

export type CcInstallmentPurchaseComputed = CcInstallmentPurchaseRow & {
  /** SQLite row id (DB ledger only). */
  purchase_db_id?: number;
  remaining_installments: number;
  remaining_principal_clp: number;
  next_due_month: string | null;
  next_installment_index: number | null;
  /** Calendar month (YYYY-MM) of the last recorded installment payment (`pay_by` / schedule). */
  last_paid_month: string | null;
  /** Constant cuota for upcoming months (CLP). */
  upcoming_cuota_clp: number;
  /** Payment rows linked to this purchase (DB source only), for manual audit in UI. */
  payment_statements?: {
    pay_by_date: string;
    statement_date: string | null;
    source_pdf: string | null;
    cuota_current: number | null;
    amount_clp: number;
  }[];
  /**
   * The plan cuota by cuota, for the purchase's progress bar (DB source only; null without a
   * schedule). Σ `amount_clp` over the cuotas = `total_clp` = paid + billed + pending.
   */
  cuota_progress?: CcCuotaProgress | null;
  /**
   * The plan's note and receipt link as its expense lines carry them (card page only,
   * `withPurchaseExpenseLinks`): the `installment-h:` key the note is written under.
   */
  expense_purchase_key?: string;
  purchase_notes?: string;
  payment_receipt?: PaymentReceipt;
  /** The names its expense lines show (`expenseLineDisplayNames`): merchant, processor, link label. */
  display_merchant?: string;
  merchant_processor?: string;
  link_label?: ExpenseLinkLabel;
  /** How this purchase entered the system. */
  origin: DataOrigin;
  /** @deprecated Use `origin`. */
  purchase_source?: "pdf" | "manual";
  /** Purchase date (YYYY-MM-DD; DB ledger only). */
  purchase_date?: string;
  /** Facturación month the purchase falls into: the bank's cycle containing the purchase date. */
  purchase_billing_month?: string | null;
};

export type CcInstallmentMonthBreakdown = {
  purchase_id: string;
  label: string;
  installment_index: number;
  installment_count: number;
  amount_clp: number;
};

export type CcInstallmentMonthRow = {
  /** Facturación (statement) month — the close that bills these cuotas. */
  month: string;
  total_clp: number;
  breakdown: CcInstallmentMonthBreakdown[];
};

/** Cuotas-del-mes calendar row: one facturación event with its pay-by date and the plan debt left after it. */
export type CcInstallmentCalendarMonthRow = CcInstallmentMonthRow & {
  /** Statement `PAGAR HASTA` when the facturación is closed; derived (~10th of next month) for open/projected. */
  pay_by_date: string;
  /** Plan debt remaining after this facturación's cuotas are paid (suffix sum; last row = 0). */
  debt_after_clp: number;
};
