import { db } from "./db.js";
import { invalidateAggregationForAccountDate } from "./aggregationCache.js";
import { loadDeptoLedgerFromMovements } from "./deptoLedgerFromMovements.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { accountRowForId } from "./accountRowForMovement.js";
import {
  deptoPaymentColumnsFromPaymentRow,
  deptoPaymentHumanNote,
  insertDeptoPaymentRow,
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
  const ledger = loadDeptoLedgerFromMovements();
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

function deptoPaymentExists(cuota: string, occurredOn: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS o FROM depto_payments p JOIN movements m ON m.id = p.movement_id
       WHERE p.cuota = ? AND m.occurred_on = ? LIMIT 1`
    )
    .get(cuota, occurredOn) as { o: number } | undefined;
  return row != null;
}

export function previewMortgagePayment(
  accountId: number,
  rawInput: MortgagePaymentInput
): MortgagePaymentPreviewResponse {
  requireSueciaMortgageAccount(accountId);
  const ledger = loadDeptoLedgerFromMovements();
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

  const ledger = loadDeptoLedgerFromMovements();
  const computed = computeMortgagePaymentRow(ledger, rawInput);
  const { sheet } = computed;
  const cuota = sheet.cuota;
  const occurred_on = sheet.occurred_on;

  if (deptoPaymentExists(cuota, occurred_on)) {
    throw new Error(`Depto payment already exists for cuota ${cuota} on ${occurred_on}`);
  }
  if (ledger.some((r) => r.cuota === cuota && r.occurred_on === occurred_on)) {
    throw new Error(`Movement ledger already has cuota ${cuota} on ${occurred_on}`);
  }

  const paymentRow = sheetRowToPaymentRow(sheet);
  const paymentCols = deptoPaymentColumnsFromPaymentRow(paymentRow);
  const mortgageFlowKind = mortgageFlowKindFromCuota(cuota);

  const tx = db.transaction(() => {
    const mortgageMov = db
      .prepare(
        `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta, flow_kind)
         VALUES (?, ?, ?, ?, NULL, ?)`
      )
      .run(
        mortgageId,
        Math.abs(sheet.pago_clp),
        occurred_on,
        deptoPaymentHumanNote("mortgage", cuota, true),
        mortgageFlowKind
      );
    const propertyMov = db
      .prepare(
        `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
         VALUES (?, ?, ?, ?, NULL)`
      )
      .run(propertyId, sheet.pago_clp, occurred_on, deptoPaymentHumanNote("dividendos", cuota, true));
    insertDeptoPaymentRow({
      movement_id: Number(mortgageMov.lastInsertRowid),
      kind: "mortgage",
      origin: "manual",
      ...paymentCols,
    });
    insertDeptoPaymentRow({
      movement_id: Number(propertyMov.lastInsertRowid),
      kind: "dividendos",
      origin: "manual",
      ...paymentCols,
    });
    return {
      sheet_row: sheet,
      mortgage_movement_id: Number(mortgageMov.lastInsertRowid),
      property_movement_id: Number(propertyMov.lastInsertRowid),
    };
  });

  const result = tx();
  invalidateAggregationForAccountDate(mortgageId, occurred_on);
  invalidateAggregationForAccountDate(propertyId, occurred_on);
  return result;
}

/**
 * Re-run compute for an existing manual payment (e.g. after analytics formula changes).
 * The manual input is reconstructed from the stored `depto_payments` row + movement amount;
 * both depto_payments rows (mortgage + property) are updated in place.
 */
export function recomputeStoredMortgagePaymentRow(
  cuota: string,
  occurredOn: string
): DeptoMortgageSheetRow {
  const target = db
    .prepare(
      `SELECT p.*, m.amount_clp FROM depto_payments p JOIN movements m ON m.id = p.movement_id
       WHERE p.cuota = ? AND m.occurred_on = ? AND p.origin = 'manual' AND p.kind = 'dividendos'`
    )
    .get(cuota, occurredOn) as
    | { amount_clp: number; interes_clp: number | null; incendio_clp: number | null; desgravamen_clp: number | null; amortizacion_ext_clp: number | null }
    | undefined;
  if (!target) {
    throw new Error(`No stored manual input for cuota ${cuota} on ${occurredOn}`);
  }
  const input: MortgagePaymentInput = {
    occurred_on: occurredOn,
    pago_clp: Math.abs(target.amount_clp),
    interes_clp: target.interes_clp ?? 0,
    incendio_clp: target.incendio_clp ?? 0,
    desgravamen_clp: target.desgravamen_clp,
    cuota,
    amortizacion_ext_clp: target.amortizacion_ext_clp,
  };
  const ledger = loadDeptoLedgerFromMovements().filter(
    (r) => !(r.cuota === cuota && r.occurred_on === occurredOn)
  );
  const computed = computeMortgagePaymentRow(ledger, input);
  const paymentRow = sheetRowToPaymentRow(computed.sheet);
  const cols = deptoPaymentColumnsFromPaymentRow(paymentRow);
  const tx = db.transaction(() => {
    const upd = db.prepare(
      `UPDATE depto_payments SET
         amount_uf=@amount_uf, credito_restante_uf=@credito_restante_uf,
         valor_vivienda_uf=@valor_vivienda_uf, valor_neto_uf=@valor_neto_uf,
         valor_neto_clp=@valor_neto_clp, pagado_neto_uf=@pagado_neto_uf,
         pago_acumulado_clp=@pago_acumulado_clp, min_uf=@min_uf,
         amortizacion_clp=@amortizacion_clp, amortizacion_uf=@amortizacion_uf,
         amortizacion_ext_clp=@amortizacion_ext_clp, amortizacion_ext_uf=@amortizacion_ext_uf,
         interes_clp=@interes_clp, interes_uf=@interes_uf,
         incendio_clp=@incendio_clp, desgravamen_clp=@desgravamen_clp
       WHERE movement_id IN (
         SELECT p.movement_id FROM depto_payments p JOIN movements m ON m.id = p.movement_id
         WHERE p.cuota = @cuota AND m.occurred_on = @occurred_on
       )`
    );
    upd.run({ ...cols, occurred_on: occurredOn });
  });
  tx();
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
