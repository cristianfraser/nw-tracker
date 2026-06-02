import { db } from "./db.js";
import type { DeptoMortgageSheetRow } from "./deptoDividendosLedger.js";

type StoredDeptoSheetRow = {
  sheet: DeptoMortgageSheetRow;
};

export function replaceDeptoDividendosSheetRowsInDb(rows: readonly DeptoMortgageSheetRow[]): number {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM depto_dividendos_sheet_rows`).run();
    const ins = db.prepare(
      `INSERT INTO depto_dividendos_sheet_rows (sort_order, cuota, occurred_on, row_json)
       VALUES (?, ?, ?, ?)`
    );
    let n = 0;
    for (let i = 0; i < rows.length; i++) {
      const sheet = rows[i]!;
      const payload: StoredDeptoSheetRow = { sheet };
      ins.run(i, sheet.cuota, sheet.occurred_on, JSON.stringify(payload));
      n++;
    }
    return n;
  });
  return tx();
}

export function loadDeptoDividendosSheetRowsRawFromDb(): DeptoMortgageSheetRow[] {
  const rows = db
    .prepare(
      `SELECT row_json FROM depto_dividendos_sheet_rows ORDER BY sort_order ASC`
    )
    .all() as { row_json: string }[];
  const out: DeptoMortgageSheetRow[] = [];
  for (const r of rows) {
    const parsed = JSON.parse(r.row_json) as StoredDeptoSheetRow;
    out.push(parsed.sheet);
  }
  return out;
}

export function deptoDividendosSheetRowCount(): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM depto_dividendos_sheet_rows`).get() as {
    c: number;
  };
  return row.c;
}
