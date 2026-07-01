/**
 * Import logic for the cuenta de ahorro para la vivienda (BancoEstado), shared by the full
 * `import:excel` and the standalone `rebuild:cuenta-ahorro` script. Reads the monthly cash CSV block
 * and applies the optional per-deposit forensic history (see {@link ./cuentaAhorroForensicDeposits}).
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "./db.js";
import {
  emitSignedMonthlyMovement,
  monthEndDate,
  monthKey,
  numCsv,
  parseSheetMonthCell,
  readSemicolonCsv,
  type ExcelMovementInsertStmt,
  type MonthKey,
} from "./cfraserCsv.js";
import {
  loadCuentaAhorroForensicDeposits,
  planAhorroDepositMovements,
} from "./cuentaAhorroForensicDeposits.js";

/** Month rows in `net worth-cash and cash equivalents.csv` (skip header + footer summary rows). */
export function walkCashCsvMonthRows(
  cfraserDir: string,
  maxMonth: MonthKey,
  visitor: (row: string[], mk: MonthKey, day: string) => void
) {
  const fp = path.join(cfraserDir, "net worth-cash and cash equivalents.csv");
  if (!fs.existsSync(fp)) return;
  const rows = readSemicolonCsv(fp);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row?.some((c) => String(c ?? "").trim())) continue;
    const a0 = String(row[0] ?? "").trim();
    if (/^(Depositado|Actual|Diferencia)$/i.test(a0)) break;
    if (/^%[-\d]/i.test(a0) || /^%;/.test(a0)) break;
    const d = parseSheetMonthCell(a0);
    if (!d) continue;
    const mk = monthKey(d);
    if (mk > maxMonth) continue;
    visitor(row, mk, monthEndDate(mk));
  }
}

type UpsertValuationStmt = {
  run: (params: { account_id: number; as_of_date: string; value_clp: number }) => unknown;
};

/**
 * “Cuenta ahorro” cols 3–5: Depósitos, Abonos, Intereses → movements + cumulative month-end
 * valuations. Abonos/Intereses always get flow_kind='savings_earnings' (BancoEstado annual yield,
 * not personal capital). Depósitos are de-aggregated per the forensic file where covered; their
 * capital classification (self / family / dap_proxy) is carried in the note by the forensic planner.
 * Returns the number of movements emitted.
 */
export function importCuentaAhorroViviendaMovements(
  cfraserDir: string,
  maxMonth: MonthKey,
  ahorroAccountId: number,
  insMov: ExcelMovementInsertStmt,
  upsertVal: UpsertValuationStmt
): number {
  const insMovWithFlowKind = db.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note, flow_kind, units_delta) VALUES (?,?,?,?,?,?)`
  );
  let movN = 0;
  let cum = 0;
  // Optional per-deposit forensic history — de-aggregates the monthly Depósitos where it's known.
  const forensicByMonth = loadCuentaAhorroForensicDeposits(cfraserDir);
  walkCashCsvMonthRows(cfraserDir, maxMonth, (row, mk, day) => {
    const dep = numCsv(row[3]);
    const abo = numCsv(row[4]);
    const int = numCsv(row[5]);
    const tryEmit = (amt: number | null, tag: string, flowKind: string | null = null) => {
      if (amt == null || !Number.isFinite(amt) || amt === 0) return;
      const note = `import:excel|csv|cash|ahorro-vivienda|${tag}`;
      if (flowKind != null) {
        insMovWithFlowKind.run(ahorroAccountId, amt, day, note, flowKind, null);
      } else {
        emitSignedMonthlyMovement(insMov, ahorroAccountId, amt, day, note);
      }
      movN += 1;
    };
    // Depósitos: individual forensic rows when the month is covered, else the CSV monthly aggregate.
    let depSum = 0;
    for (const p of planAhorroDepositMovements(mk, dep, forensicByMonth)) {
      tryEmit(p.amount_clp, p.noteTag);
      depSum += p.amount_clp;
    }
    if (forensicByMonth.has(mk) && dep != null && Math.round(depSum) !== Math.round(dep)) {
      console.log(
        `cuenta ahorro ${mk} forensic Depósitos ${Math.round(depSum)} ≠ CSV aggregate ${Math.round(dep)} (Δ ${Math.round(depSum - dep)}) — using forensic`
      );
    }
    tryEmit(abo, "Abonos", "savings_earnings");
    tryEmit(int, "Intereses", "savings_earnings");
    cum += depSum + (abo ?? 0) + (int ?? 0);
    if (Number.isFinite(cum)) {
      upsertVal.run({ account_id: ahorroAccountId, as_of_date: day, value_clp: cum });
    }
  });
  return movN;
}
