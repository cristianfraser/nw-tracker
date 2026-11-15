import { InputError } from "./inputError.js";
import { HOME_CURRENCY } from "nw-tracker-contracts/dto/apiConstants";
import { db } from "./db.js";
import { insertMovement } from "./movementWrites.js";

import { accountHasRole, deptoPropertyIdOfAccount } from "./accountRoles.js";
import { deptoLedgerForLoan } from "./deptoLedgerFromMovements.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { accountRowForId } from "./accountRowForMovement.js";
import {
  deptoPaymentHumanNote,
  insertLoanPaymentRow,
  loanPaymentColumnsFromPaymentRow,
  mortgageFlowKindFromCuota,
  sheetRowToPaymentRow,
  type DeptoMortgageSheetRow,
} from "./deptoDividendosLedger.js";
import {
  computeMortgagePaymentRow,
  defaultIncendioClpFromLedger,
  suggestNextMortgageCuota,
  type MortgagePaymentInput,
  type MortgagePaymentComputeResult,
} from "./mortgagePaymentCompute.js";
import { syncLoanPaymentFlowParts } from "./flows/loanPaymentParts.js";

export type MortgagePaymentCreateSchema = {
  next_cuota: string;
  default_incendio_clp: number | null;
};

export type MortgagePaymentPreviewResponse = MortgagePaymentComputeResult & {
  property_net_clp: number;
  mortgage_balance_clp: number;
};


export function mortgagePaymentCreateSchemaForAccount(
  accountId: number
): MortgagePaymentCreateSchema | null {
  if (!Number.isFinite(accountId) || accountId <= 0) return null;
  const account = accountRowForId(accountId);
  if (!account) return null;
  if (accountBucketKindSlug(account.bucket_slug) !== "mortgage") return null;
  if (!accountHasRole(accountId, "loan_of")) return null;
  const ledger = deptoLedgerForLoan(accountId);
  if (ledger.length === 0) return null;
  return {
    next_cuota: suggestNextMortgageCuota(ledger),
    default_incendio_clp: defaultIncendioClpFromLedger(ledger),
  };
}

function requireDeptoMortgageAccount(accountId: number): void {
  const account = accountRowForId(accountId);
  if (!account) throw new InputError("Account not found");
  if (accountBucketKindSlug(account.bucket_slug) !== "mortgage") {
    throw new InputError("Mortgage payments can only be logged on the depto mortgage account");
  }
  if (!accountHasRole(accountId, "loan_of")) {
    throw new InputError("Mortgage payment entry is only enabled for a loan of a property (loan_of role)");
  }
}

function deptoPaymentExists(loanAccountId: number, cuota: string, occurredOn: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS o FROM loan_payments p JOIN movements m ON m.id = p.movement_id
       WHERE p.loan_account_id = ? AND p.cuota = ? AND m.occurred_on = ? LIMIT 1`
    )
    .get(loanAccountId, cuota, occurredOn) as { o: number } | undefined;
  return row != null;
}

export function previewMortgagePayment(
  accountId: number,
  rawInput: MortgagePaymentInput
): MortgagePaymentPreviewResponse {
  requireDeptoMortgageAccount(accountId);
  const ledger = deptoLedgerForLoan(accountId);
  const computed = computeMortgagePaymentRow(ledger, rawInput);
  return {
    ...computed,
    property_net_clp: computed.sheet.valor_neto_clp ?? 0,
    mortgage_balance_clp: computed.sheet.restante_clp ?? 0,
  };
}

export type CommitMortgagePaymentResult = {
  sheet_row: DeptoMortgageSheetRow;
  mortgage_movement_id: number;
  property_movement_id: number;
};

/**
 * Writes the cuota's two movements (mortgage + property) and their `loan_payments` rows. The
 * property's appraisal is not written: the ledger carries the latest one forward.
 * `origin` names the writer — `manual` for the form, `import` for the lender's portal (`mortgage.lender_statement`) — and the
 * human note follows it.
 */
export function commitMortgagePayment(
  accountId: number,
  rawInput: MortgagePaymentInput,
  opts: { origin: "manual" | "import" } = { origin: "manual" }
): CommitMortgagePaymentResult {
  const manual = opts.origin === "manual";
  requireDeptoMortgageAccount(accountId);
  // The loan the payment is logged on, and the property its `loan_of` names.
  const mortgageId = accountId;
  const propertyId = deptoPropertyIdOfAccount(mortgageId);
  if (propertyId == null) throw new Error(`Mortgage account ${mortgageId} is the loan of no property`);

  const ledger = deptoLedgerForLoan(mortgageId);
  const computed = computeMortgagePaymentRow(ledger, rawInput);
  const { sheet } = computed;
  const cuota = sheet.cuota;
  const occurred_on = sheet.occurred_on;

  if (deptoPaymentExists(mortgageId, cuota, occurred_on)) {
    throw new InputError(`Depto payment already exists for cuota ${cuota} on ${occurred_on}`);
  }
  if (ledger.some((r) => r.cuota === cuota && r.occurred_on === occurred_on)) {
    throw new InputError(`Movement ledger already has cuota ${cuota} on ${occurred_on}`);
  }

  const paymentRow = sheetRowToPaymentRow(sheet);
  const paymentCols = loanPaymentColumnsFromPaymentRow(paymentRow);
  const mortgageFlowKind = mortgageFlowKindFromCuota(cuota);

  const tx = db.transaction(() => {
    const mortgageMovementId = insertMovement({
      accountId: mortgageId,
      amount: Math.abs(sheet.pago_clp),
      currency: HOME_CURRENCY,
      occurredOn: occurred_on,
      note: deptoPaymentHumanNote("loan", cuota, manual),
      flowKind: mortgageFlowKind,
    });
    const propertyMovementId = insertMovement({
      accountId: propertyId,
      amount: sheet.pago_clp,
      currency: HOME_CURRENCY,
      occurredOn: occurred_on,
      note: deptoPaymentHumanNote("property", cuota, manual),
    });
    insertLoanPaymentRow({
      movement_id: mortgageMovementId,
      loan_account_id: mortgageId,
      leg: "loan",
      origin: opts.origin,
      ...paymentCols,
    });
    insertLoanPaymentRow({
      movement_id: propertyMovementId,
      loan_account_id: mortgageId,
      leg: "property",
      origin: opts.origin,
      ...paymentCols,
    });
    // The new cuota's parts on its property-leg flow (the compute makes them add up to the payment).
    syncLoanPaymentFlowParts([]);
    return {
      sheet_row: sheet,
      mortgage_movement_id: mortgageMovementId,
      property_movement_id: propertyMovementId,
    };
  });

  const result = tx();
  return result;
}

export function parseMortgagePaymentBody(body: Record<string, unknown>): MortgagePaymentInput {
  const occurred_on = String(body.occurred_on ?? "").trim();
  const pago_clp = Number(body.pago_clp);
  const interes_clp = Number(body.interes_clp);
  const incendio_clp = Number(body.incendio_clp);
  const desgravamen_clp =
    body.desgravamen_clp === undefined || body.desgravamen_clp === null
      ? null
      : Number(body.desgravamen_clp);
  const cuota =
    body.cuota === undefined || body.cuota === null ? null : String(body.cuota).trim();
  const min_uf =
    body.min_uf === undefined || body.min_uf === null ? null : Number(body.min_uf);
  const max_uf =
    body.max_uf === undefined || body.max_uf === null ? null : Number(body.max_uf);
  const amortizacion_ext_clp =
    body.amortizacion_ext_clp === undefined || body.amortizacion_ext_clp === null
      ? null
      : Number(body.amortizacion_ext_clp);
  const credito_restante_uf =
    body.credito_restante_uf === undefined || body.credito_restante_uf === null
      ? null
      : Number(body.credito_restante_uf);

  if (!occurred_on) throw new InputError("occurred_on is required");
  if (!Number.isFinite(pago_clp)) throw new InputError("pago_clp is required");
  if (!Number.isFinite(interes_clp)) throw new InputError("interes_clp is required");
  if (!Number.isFinite(incendio_clp)) throw new InputError("incendio_clp is required");
  if (desgravamen_clp != null && !Number.isFinite(desgravamen_clp)) {
    throw new InputError("desgravamen_clp must be a number when provided");
  }
  if (min_uf != null && !Number.isFinite(min_uf)) {
    throw new InputError("min_uf must be a number when provided");
  }
  if (max_uf != null && !Number.isFinite(max_uf)) {
    throw new InputError("max_uf must be a number when provided");
  }
  if (amortizacion_ext_clp != null && !Number.isFinite(amortizacion_ext_clp)) {
    throw new InputError("amortizacion_ext_clp must be a number when provided");
  }
  if (credito_restante_uf != null && !Number.isFinite(credito_restante_uf)) {
    throw new InputError("credito_restante_uf must be a number when provided");
  }

  return {
    occurred_on,
    pago_clp,
    interes_clp,
    incendio_clp,
    desgravamen_clp,
    cuota,
    min_uf,
    max_uf,
    amortizacion_ext_clp,
    credito_restante_uf,
  };
}
