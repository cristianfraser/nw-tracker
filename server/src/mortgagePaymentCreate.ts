import { db } from "./db.js";
import { invalidateAggregationForAccountDate } from "./aggregationCache.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { accountRowForId } from "./accountRowForMovement.js";
import {
  buildDeptoDividendosMovementNote,
  buildDeptoMortgageMovementNote,
  loadDeptoDividendosSheetLedgerFromDb,
  sheetRowToPaymentRow,
  type DeptoMortgageSheetRow,
} from "./deptoDividendosLedger.js";
import {
  appendDeptoDividendosSheetRowInDb,
  deptoSheetRowExists,
  loadStoredDeptoSheetRowsFromDb,
  updateDeptoDividendosSheetRowInDb,
  type StoredDeptoSheetRow,
} from "./deptoSheetDb.js";
import {
  computeMortgagePaymentRow,
  defaultIncendioClpFromLedger,
  suggestNextMortgageCuota,
  type MortgagePaymentInput,
  type MortgagePaymentComputeResult,
} from "./mortgagePaymentCompute.js";

export type MortgagePaymentCreateSchema = {
  next_cuota: string;
  default_incendio_clp: number | null;
};

export type MortgagePaymentPreviewResponse = MortgagePaymentComputeResult & {
  property_net_clp: number;
  mortgage_balance_clp: number;
};

const PROPERTY_ACCOUNT_NOTES = "import:excel|key=property";
const MORTGAGE_ACCOUNT_NOTES = "import:excel|key=mortgage";

export function mortgagePaymentCreateSchemaForAccount(
  accountId: number
): MortgagePaymentCreateSchema | null {
  if (!Number.isFinite(accountId) || accountId <= 0) return null;
  const account = accountRowForId(accountId);
  if (!account) return null;
  if (accountBucketKindSlug(account.bucket_slug) !== "mortgage") return null;
  if (account.notes !== MORTGAGE_ACCOUNT_NOTES && account.notes !== "liability_view|mortgage") {
    const master = db
      .prepare(`SELECT notes FROM accounts WHERE id = ?`)
      .get(accountId) as { notes: string | null } | undefined;
    if (master?.notes !== MORTGAGE_ACCOUNT_NOTES) return null;
  }
  const ledger = loadDeptoDividendosSheetLedgerFromDb();
  if (ledger.length === 0) return null;
  return {
    next_cuota: suggestNextMortgageCuota(ledger),
    default_incendio_clp: defaultIncendioClpFromLedger(ledger),
  };
}

function requireSueciaMortgageAccount(accountId: number): void {
  const account = accountRowForId(accountId);
  if (!account) throw new Error("Account not found");
  if (accountBucketKindSlug(account.bucket_slug) !== "mortgage") {
    throw new Error("Mortgage payments can only be logged on the Suecia hipoteca account");
  }
  if (account.notes !== MORTGAGE_ACCOUNT_NOTES) {
    throw new Error("Mortgage payment entry is only enabled for the Suecia mortgage master account");
  }
}

function propertyAccountId(): number {
  const row = db
    .prepare(`SELECT id FROM accounts WHERE notes = ? ORDER BY id LIMIT 1`)
    .get(PROPERTY_ACCOUNT_NOTES) as { id: number } | undefined;
  if (!row) throw new Error(`Property account not found (${PROPERTY_ACCOUNT_NOTES})`);
  return row.id;
}

function mortgageAccountId(): number {
  const row = db
    .prepare(`SELECT id FROM accounts WHERE notes = ? AND account_kind = 'master' ORDER BY id LIMIT 1`)
    .get(MORTGAGE_ACCOUNT_NOTES) as { id: number } | undefined;
  if (!row) throw new Error(`Mortgage account not found (${MORTGAGE_ACCOUNT_NOTES})`);
  return row.id;
}

function buildManualDeptoMovementNote(
  paymentRow: ReturnType<typeof sheetRowToPaymentRow>,
  tag: "depto-dividendos" | "depto-mortgage"
): string {
  const note =
    tag === "depto-mortgage"
      ? buildDeptoMortgageMovementNote(paymentRow)
      : buildDeptoDividendosMovementNote(paymentRow, tag);
  return note.replace(/^import:excel\|/, "manual|");
}

export function previewMortgagePayment(
  accountId: number,
  rawInput: MortgagePaymentInput
): MortgagePaymentPreviewResponse {
  requireSueciaMortgageAccount(accountId);
  const ledger = loadDeptoDividendosSheetLedgerFromDb();
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
  sort_order: number;
};

export function commitMortgagePayment(
  accountId: number,
  rawInput: MortgagePaymentInput
): CommitMortgagePaymentResult {
  requireSueciaMortgageAccount(accountId);
  const mortgageId = mortgageAccountId();
  if (mortgageId !== accountId) {
    throw new Error("Mortgage payment account id mismatch");
  }
  const propertyId = propertyAccountId();

  const ledger = loadDeptoDividendosSheetLedgerFromDb();
  const computed = computeMortgagePaymentRow(ledger, rawInput);
  const { sheet, input } = computed;
  const cuota = sheet.cuota;
  const occurred_on = sheet.occurred_on;

  if (deptoSheetRowExists(cuota, occurred_on)) {
    throw new Error(`Sheet row already exists for cuota ${cuota} on ${occurred_on}`);
  }

  const paymentRow = sheetRowToPaymentRow(sheet);
  const mortgageNote = buildManualDeptoMovementNote(paymentRow, "depto-mortgage");
  const propertyNote = buildManualDeptoMovementNote(paymentRow, "depto-dividendos");

  const stored: StoredDeptoSheetRow = {
    sheet,
    origin: "manual",
    input,
  };

  const tx = db.transaction(() => {
    const sortOrder = appendDeptoDividendosSheetRowInDb(stored);
    const mortgageMov = db
      .prepare(
        `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
         VALUES (?, ?, ?, ?, NULL)`
      )
      .run(mortgageId, Math.abs(sheet.pago_clp), occurred_on, mortgageNote);
    const propertyMov = db
      .prepare(
        `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
         VALUES (?, ?, ?, ?, NULL)`
      )
      .run(propertyId, sheet.pago_clp, occurred_on, propertyNote);
    return {
      sheet_row: sheet,
      mortgage_movement_id: Number(mortgageMov.lastInsertRowid),
      property_movement_id: Number(propertyMov.lastInsertRowid),
      sort_order: sortOrder,
    };
  });

  const result = tx();
  invalidateAggregationForAccountDate(mortgageId, occurred_on);
  invalidateAggregationForAccountDate(propertyId, occurred_on);
  return result;
}

/** Re-run compute for an existing manual sheet row (e.g. after analytics formula changes). */
export function recomputeStoredMortgagePaymentRow(
  cuota: string,
  occurredOn: string
): DeptoMortgageSheetRow {
  const all = loadStoredDeptoSheetRowsFromDb();
  const stored = all.find((s) => s.sheet.cuota === cuota && s.sheet.occurred_on === occurredOn);
  if (!stored?.input) {
    throw new Error(`No stored manual input for cuota ${cuota} on ${occurredOn}`);
  }
  const ledger = all
    .filter((s) => !(s.sheet.cuota === cuota && s.sheet.occurred_on === occurredOn))
    .map((s) => s.sheet);
  const computed = computeMortgagePaymentRow(ledger, stored.input);
  updateDeptoDividendosSheetRowInDb(cuota, occurredOn, {
    sheet: computed.sheet,
    origin: stored.origin ?? "manual",
    input: computed.input,
  });
  return computed.sheet;
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
  const amortizacion_ext_clp =
    body.amortizacion_ext_clp === undefined || body.amortizacion_ext_clp === null
      ? null
      : Number(body.amortizacion_ext_clp);

  if (!occurred_on) throw new Error("occurred_on is required");
  if (!Number.isFinite(pago_clp)) throw new Error("pago_clp is required");
  if (!Number.isFinite(interes_clp)) throw new Error("interes_clp is required");
  if (!Number.isFinite(incendio_clp)) throw new Error("incendio_clp is required");
  if (desgravamen_clp != null && !Number.isFinite(desgravamen_clp)) {
    throw new Error("desgravamen_clp must be a number when provided");
  }
  if (amortizacion_ext_clp != null && !Number.isFinite(amortizacion_ext_clp)) {
    throw new Error("amortizacion_ext_clp must be a number when provided");
  }

  return {
    occurred_on,
    pago_clp,
    interes_clp,
    incendio_clp,
    desgravamen_clp,
    cuota,
    amortizacion_ext_clp,
  };
}
