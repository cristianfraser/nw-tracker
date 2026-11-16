import { InputError } from "./inputError.js";
import { HOME_CURRENCY } from "nw-tracker-contracts/dto/apiConstants";
import { db } from "./db.js";
import { insertMovement } from "./movementWrites.js";

import { accountHasRole, deptoPropertyIdOfAccount } from "./accountRoles.js";
import { deptoLedgerForLoan } from "./deptoLedgerFromMovements.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { accountRowForId } from "./accountRowForMovement.js";
import type { MortgagePaymentCreateSchema, MortgagePaymentPreviewResponse } from "nw-tracker-contracts/dto";
import {
  DEPTO_LOAN_CURRENCY,
  DEPTO_PAYMENT_CURRENCY,
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
} from "./mortgagePaymentCompute.js";
import { mortgageLedgerRowDto } from "./mortgageLedgerDto.js";
import { syncLoanPaymentFlowParts } from "./flows/loanPaymentParts.js";

export type { MortgagePaymentCreateSchema, MortgagePaymentPreviewResponse };

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
    loan_currency: DEPTO_LOAN_CURRENCY,
    payment_currency: DEPTO_PAYMENT_CURRENCY,
    default_incendio_pay: defaultIncendioClpFromLedger(ledger),
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

/** A peso figure `computeMortgagePaymentRow` always computes (the row type allows null for stored rows of other kinds). */
function requireComputed(value: number | null, field: string): number {
  if (value == null) throw new Error(`mortgage payment: the computed row has no ${field}`);
  return value;
}

/** The form's preview, in the payload's role-named keys (`mortgageLedgerDto.ts`). */
export function previewMortgagePayment(
  accountId: number,
  rawInput: MortgagePaymentInput
): MortgagePaymentPreviewResponse {
  requireDeptoMortgageAccount(accountId);
  const ledger = deptoLedgerForLoan(accountId);
  const computed = computeMortgagePaymentRow(ledger, rawInput);
  const { input } = computed;
  return {
    sheet: mortgageLedgerRowDto(computed.sheet),
    input: {
      occurred_on: input.occurred_on,
      pago_pay: input.pago_clp,
      interes_pay: input.interes_clp,
      incendio_pay: input.incendio_clp,
      ...(input.desgravamen_clp !== undefined ? { desgravamen_pay: input.desgravamen_clp } : {}),
      ...(input.cuota !== undefined ? { cuota: input.cuota } : {}),
      ...(input.min_uf !== undefined ? { min_loan: input.min_uf } : {}),
      ...(input.max_uf !== undefined ? { max_loan: input.max_uf } : {}),
      ...(input.amortizacion_ext_clp !== undefined ? { amortizacion_ext_pay: input.amortizacion_ext_clp } : {}),
      ...(input.credito_restante_uf !== undefined ? { credito_restante_loan: input.credito_restante_uf } : {}),
    },
    loan_currency: DEPTO_LOAN_CURRENCY,
    payment_currency: DEPTO_PAYMENT_CURRENCY,
    desgravamen_default_pay: computed.desgravamen_default_clp,
    desgravamen_used_override: computed.desgravamen_used_override,
    credito_restante_derived_loan: computed.credito_restante_derived_uf,
    credito_restante_used_override: computed.credito_restante_used_override,
    property_net_pay: requireComputed(computed.sheet.valor_neto_clp, "valor_neto_clp"),
    mortgage_balance_pay: requireComputed(computed.sheet.restante_clp, "restante_clp"),
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

/** The form's body (`MortgagePaymentInputDto`: role-named keys) as the compute's input. */
export function parseMortgagePaymentBody(body: Record<string, unknown>): MortgagePaymentInput {
  const optionalNumber = (key: string): number | null => {
    const raw = body[key];
    if (raw === undefined || raw === null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new InputError(`${key} must be a number when provided`);
    return n;
  };
  const requiredNumber = (key: string): number => {
    const n = Number(body[key]);
    if (!Number.isFinite(n)) throw new InputError(`${key} is required`);
    return n;
  };
  const occurred_on = String(body.occurred_on ?? "").trim();
  if (!occurred_on) throw new InputError("occurred_on is required");
  const pago_clp = requiredNumber("pago_pay");
  const interes_clp = requiredNumber("interes_pay");
  const incendio_clp = requiredNumber("incendio_pay");
  return {
    occurred_on,
    pago_clp,
    interes_clp,
    incendio_clp,
    desgravamen_clp: optionalNumber("desgravamen_pay"),
    cuota: body.cuota === undefined || body.cuota === null ? null : String(body.cuota).trim(),
    min_uf: optionalNumber("min_loan"),
    max_uf: optionalNumber("max_loan"),
    amortizacion_ext_clp: optionalNumber("amortizacion_ext_pay"),
    credito_restante_uf: optionalNumber("credito_restante_loan"),
  };
}
