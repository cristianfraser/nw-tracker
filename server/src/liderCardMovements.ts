/**
 * Adapter from the Lider BCI «últimos movimientos» CSV export to the web-paste line shape.
 *
 * A separate scheduled task drops `lider-bci-movimientos-<YYYY-MM-DD>.csv` into `cfraser/inbox/`;
 * this turns its rows into the same `CcWebPasteLine` a manual paste produces, so the whole existing
 * import path — dedupe keys, installment overlap, first-due nudges, batch logging — is reused
 * rather than duplicated (same design as `santanderCardMovements.ts`).
 *
 * Columns: `fecha,descripcion,cuotas,monto,detectado`. `detectado` is the day the fetcher first saw
 * the row and is provenance only — the ledger keys off `fecha`.
 *
 * **Sign convention is already the DB's**: BCI's web UI lists charges positive and refunds negative,
 * which `webPasteSignedAmount` keeps as-is for non-Santander card groups (payment merchants — PAGO,
 * ABONO, MONTO CANCELADO — are forced negative regardless). So `monto` passes through unchanged.
 *
 * **The feed re-lists installment cuotas** dated at the ORIGINAL purchase date and valued at the
 * MONTHLY cuota (verified 2026-08-05: TGR 2026-06-28 at 1x.xxx = 9x.xxx÷6, LIDER DOMICILIO
 * 2026-06-02 at 5.633 = 1xx.xxx÷18, both already converted plans). Those rows are not dropped
 * here — `shouldSkipOneShotStatementImport` already recognises a one-shot whose amount matches
 * either the full principal or a single cuota, and skipping them at import records the overlap
 * instead of hiding it.
 */
import { type CcWebPasteLine } from "./ccWebPasteParse.js";

export type LiderMovementCsvRow = {
  fecha?: string;
  descripcion?: string;
  cuotas?: string;
  monto?: string;
  detectado?: string;
};

export const LIDER_MOVEMENTS_REQUIRED_COLUMNS = ["fecha", "descripcion", "monto"] as const;

/** Fail fast when the export's shape changes rather than importing a misread column. */
export function assertLiderMovementsColumns(rows: readonly Record<string, string>[]): void {
  const first = rows[0];
  if (!first) return;
  const missing = LIDER_MOVEMENTS_REQUIRED_COLUMNS.filter((c) => !(c in first));
  if (missing.length > 0) {
    throw new Error(
      `Lider movements CSV missing required column(s): ${missing.join(", ")} ` +
        `(got ${Object.keys(first).join(", ")})`
    );
  }
}

/** `YYYY-MM-DD` as exported. Throws rather than guessing at an unexpected shape. */
export function liderMovementDateToIso(fecha: string): string {
  const text = String(fecha ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`Unexpected Lider movement date "${fecha}" (want YYYY-MM-DD)`);
  }
  return text;
}

/**
 * Integer pesos, sign preserved. The export is machine-generated (no thousands separators), so a
 * grouped or decimal token means the format changed and must be re-read, not coerced.
 */
export function liderMovementAmountClp(monto: string): number {
  const text = String(monto ?? "").trim();
  if (!/^-?\d+$/.test(text)) {
    throw new Error(`Unexpected Lider movement amount "${monto}" (want plain integer pesos)`);
  }
  const n = Number(text);
  if (!Number.isFinite(n) || n === 0) {
    throw new Error(`Unusable Lider movement amount "${monto}"`);
  }
  return n;
}

/**
 * The `cuotas` column has been empty on every row seen so far — including rows that ARE cuotas of a
 * converted plan — so its populated form is unknown. Guessing would risk importing a plan's total
 * as a one-shot (or vice versa), so an unexpected value throws with the row for context.
 */
function assertKnownCuotasToken(row: LiderMovementCsvRow): void {
  const cuotas = String(row.cuotas ?? "").trim();
  if (cuotas === "") return;
  throw new Error(
    `Lider movement "${row.descripcion}" (${row.fecha}) carries cuotas="${cuotas}"; ` +
      `this column has only ever been empty, so its format is unmapped — inspect the export and ` +
      `extend liderCardMovements.ts before importing`
  );
}

export function liderMovementRowToWebPasteLine(row: LiderMovementCsvRow): CcWebPasteLine {
  assertKnownCuotasToken(row);
  const merchant = String(row.descripcion ?? "").trim();
  if (!merchant) throw new Error(`Lider movement row (${row.fecha}) has no descripcion`);
  const transaction_date = liderMovementDateToIso(String(row.fecha ?? ""));
  const amount_clp = liderMovementAmountClp(String(row.monto ?? ""));
  return {
    transaction_date,
    merchant,
    amount_clp,
    amount_usd: null,
    currency: "clp",
    raw_line: [row.fecha, merchant, row.monto].filter(Boolean).join(" "),
  };
}

export function liderMovementsToWebPasteLines(
  rows: readonly Record<string, string>[]
): CcWebPasteLine[] {
  assertLiderMovementsColumns(rows);
  return rows.map((r) => liderMovementRowToWebPasteLine(r as LiderMovementCsvRow));
}
