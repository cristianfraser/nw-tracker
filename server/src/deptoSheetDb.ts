import { db } from "./db.js";
import type { DataOrigin } from "./dataOrigin.js";
import type { DeptoMortgageSheetRow } from "./deptoDividendosLedger.js";
import type { MortgagePaymentInput } from "./mortgagePaymentTypes.js";

export type StoredDeptoSheetRow = {
  sheet: DeptoMortgageSheetRow;
  origin?: DataOrigin;
  input?: MortgagePaymentInput;
};

function sortSheetRows(a: DeptoMortgageSheetRow, b: DeptoMortgageSheetRow): number {
  const c = a.occurred_on.localeCompare(b.occurred_on);
  return c !== 0 ? c : a.cuota.localeCompare(b.cuota);
}

function parseStoredRowJson(rowJson: string): StoredDeptoSheetRow {
  const parsed = JSON.parse(rowJson) as StoredDeptoSheetRow | { sheet: DeptoMortgageSheetRow };
  if (!parsed || typeof parsed !== "object" || !("sheet" in parsed)) {
    throw new Error("depto_dividendos_sheet_rows: invalid row_json (missing sheet)");
  }
  return {
    sheet: parsed.sheet,
    origin: "origin" in parsed && parsed.origin ? parsed.origin : "import_document",
    input: "input" in parsed ? parsed.input : undefined,
  };
}

function writeAllStoredRows(rows: readonly StoredDeptoSheetRow[]): number {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM depto_dividendos_sheet_rows`).run();
    const ins = db.prepare(
      `INSERT INTO depto_dividendos_sheet_rows (sort_order, cuota, occurred_on, row_json)
       VALUES (?, ?, ?, ?)`
    );
    const sorted = [...rows].sort((a, b) => sortSheetRows(a.sheet, b.sheet));
    for (let i = 0; i < sorted.length; i++) {
      const stored = sorted[i]!;
      ins.run(i, stored.sheet.cuota, stored.sheet.occurred_on, JSON.stringify(stored));
    }
    return sorted.length;
  });
  return tx();
}

export function loadStoredDeptoSheetRowsFromDb(): StoredDeptoSheetRow[] {
  const rows = db
    .prepare(`SELECT row_json FROM depto_dividendos_sheet_rows ORDER BY sort_order ASC`)
    .all() as { row_json: string }[];
  return rows.map((r) => parseStoredRowJson(r.row_json));
}

export function loadDeptoDividendosSheetRowsRawFromDb(): DeptoMortgageSheetRow[] {
  return loadStoredDeptoSheetRowsFromDb().map((r) => r.sheet);
}

/**
 * Import/bootstrap: merge file rows with existing manual rows (manual preserved unless same cuota|date).
 */
export function replaceDeptoDividendosSheetRowsInDb(rows: readonly DeptoMortgageSheetRow[]): number {
  const existing = loadStoredDeptoSheetRowsFromDb();
  const byKey = new Map<string, StoredDeptoSheetRow>();
  for (const stored of existing) {
    if (stored.origin === "manual") {
      byKey.set(`${stored.sheet.cuota}|${stored.sheet.occurred_on}`, stored);
    }
  }
  for (const sheet of rows) {
    byKey.set(`${sheet.cuota}|${sheet.occurred_on}`, { sheet, origin: "import_document" });
  }
  return writeAllStoredRows([...byKey.values()]);
}

export function appendDeptoDividendosSheetRowInDb(stored: StoredDeptoSheetRow): number {
  const maxRow = db
    .prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM depto_dividendos_sheet_rows`)
    .get() as { m: number };
  const sortOrder = maxRow.m + 1;
  db.prepare(
    `INSERT INTO depto_dividendos_sheet_rows (sort_order, cuota, occurred_on, row_json)
     VALUES (?, ?, ?, ?)`
  ).run(sortOrder, stored.sheet.cuota, stored.sheet.occurred_on, JSON.stringify(stored));
  return sortOrder;
}

export function deptoDividendosSheetRowCount(): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM depto_dividendos_sheet_rows`).get() as {
    c: number;
  };
  return row.c;
}

export function deptoSheetRowExists(cuota: string, occurredOn: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM depto_dividendos_sheet_rows WHERE cuota = ? AND occurred_on = ? LIMIT 1`
    )
    .get(cuota, occurredOn);
  return row != null;
}

export function updateDeptoDividendosSheetRowInDb(
  cuota: string,
  occurredOn: string,
  stored: StoredDeptoSheetRow
): void {
  const n = db
    .prepare(
      `UPDATE depto_dividendos_sheet_rows SET row_json = ? WHERE cuota = ? AND occurred_on = ?`
    )
    .run(JSON.stringify(stored), cuota, occurredOn).changes;
  if (n !== 1) {
    throw new Error(`depto sheet row not found for update: cuota ${cuota} on ${occurredOn}`);
  }
}
