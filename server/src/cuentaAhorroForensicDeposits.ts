/**
 * Forensic per-deposit history for the cuenta de ahorro para la vivienda (BancoEstado).
 *
 * The net-worth cash CSV only records one monthly *aggregate* Depósito per month. Where the real
 * history is known — several deposits in a month, or an aggregate that nets unrelated flows — this
 * optional file lists the individual movements so the account matches the forensic record.
 *
 * File: `cfraser/cuenta-ahorro-deposits.csv` (semicolon-separated, es-CL numbers), columns:
 *   month;amount_clp;funding;note
 *     month      YYYY-MM (which month the deposit belongs to; day is booked at month-end)
 *     amount_clp signed CLP (positive = deposit in, negative = withdrawal out)
 *     funding    optional: `self` | `family` (who put the money in; blank = unknown), or
 *                `dap_proxy` — not a real housing-savings flow, just DAP principal that was parked in
 *                this line as a cash_savings proxy in the old sheet. Dropped entirely: no movement and
 *                no valuation contribution (the DAP/checking money is now tracked on its own account).
 *     note       optional free text (provenance; ignored by matching)
 *
 * For every month that appears here, the import emits these rows *instead of* the CSV monthly
 * aggregate for that month; months absent here keep the aggregate. Sums may legitimately differ from
 * the aggregate (that is the whole point — the aggregate can be inaccurate), so the import logs the
 * delta rather than failing.
 */
import { monthEndDate, numCsv, readSemicolonCsv, type MonthKey } from "./cfraserCsv.js";
import path from "node:path";
import fs from "node:fs";

export type AhorroDepositFunding = "self" | "family";

export type ForensicAhorroDeposit = {
  month: MonthKey;
  occurred_on: string;
  amount_clp: number;
  funding: AhorroDepositFunding | null;
  /** DAP principal parked in this line as a proxy — real for the balance, not a reconcilable flow. */
  dap_proxy: boolean;
  note: string | null;
};

const MONTH_RE = /^\d{4}-\d{2}$/;

type ParsedFunding = { funding: AhorroDepositFunding | null; dap_proxy: boolean };

function parseFunding(raw: string | undefined): ParsedFunding {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "self") return { funding: "self", dap_proxy: false };
  if (v === "family") return { funding: "family", dap_proxy: false };
  if (v === "dap_proxy") return { funding: null, dap_proxy: true };
  if (v === "") return { funding: null, dap_proxy: false };
  throw new Error(
    `cuenta-ahorro forensic: invalid funding "${raw}" (expected self | family | dap_proxy | blank)`
  );
}

/** Parse the forensic rows from already-read CSV cells (pure; header row skipped). */
export function parseCuentaAhorroForensicRows(rows: readonly (readonly string[])[]): ForensicAhorroDeposit[] {
  const out: ForensicAhorroDeposit[] = [];
  for (const row of rows) {
    const month = String(row[0] ?? "").trim();
    if (!month || month.toLowerCase() === "month") continue; // header / blank
    if (!MONTH_RE.test(month)) {
      throw new Error(`cuenta-ahorro forensic: bad month "${month}" (expected YYYY-MM)`);
    }
    const amount = numCsv(row[1]);
    if (amount == null || !Number.isFinite(amount) || amount === 0) {
      throw new Error(`cuenta-ahorro forensic: bad amount for ${month}: "${row[1]}"`);
    }
    const { funding, dap_proxy } = parseFunding(row[2]);
    out.push({
      month,
      occurred_on: monthEndDate(month),
      amount_clp: Math.round(amount),
      funding,
      dap_proxy,
      note: String(row[3] ?? "").trim() || null,
    });
  }
  return out;
}

/** Group forensic deposits by month, preserving file order within a month. */
export function groupForensicDepositsByMonth(
  deposits: readonly ForensicAhorroDeposit[]
): Map<MonthKey, ForensicAhorroDeposit[]> {
  const byMonth = new Map<MonthKey, ForensicAhorroDeposit[]>();
  for (const d of deposits) {
    const list = byMonth.get(d.month) ?? [];
    list.push(d);
    byMonth.set(d.month, list);
  }
  return byMonth;
}

/** Load and group the forensic file; empty map when the file is absent. */
export function loadCuentaAhorroForensicDeposits(cfraserDir: string): Map<MonthKey, ForensicAhorroDeposit[]> {
  const fp = path.join(cfraserDir, "cuenta-ahorro-deposits.csv");
  if (!fs.existsSync(fp)) return new Map();
  return groupForensicDepositsByMonth(parseCuentaAhorroForensicRows(readSemicolonCsv(fp)));
}

export type PlannedAhorroDeposit = { amount_clp: number; noteTag: string };

/**
 * Decide the Depósito movements for one month: the individual forensic rows when the month is
 * covered, otherwise the single CSV aggregate. `dap_proxy` rows emit nothing — they suppress the
 * amount entirely (no movement, no valuation contribution), so a month whose aggregate was purely a
 * DAP placeholder produces no cuenta-ahorro flow at all. `noteTag` is appended after
 * `import:excel|csv|cash|ahorro-vivienda|` on the movement note.
 */
export function planAhorroDepositMovements(
  month: MonthKey,
  csvAggregate: number | null,
  byMonth: ReadonlyMap<MonthKey, ForensicAhorroDeposit[]>
): PlannedAhorroDeposit[] {
  const forensic = byMonth.get(month);
  if (forensic && forensic.length > 0) {
    return forensic
      .filter((d) => !d.dap_proxy)
      .map((d, i) => {
        const fundingSeg = d.funding ? `|funding=${d.funding}` : "";
        return { amount_clp: d.amount_clp, noteTag: `Depósitos|forensic:${i + 1}${fundingSeg}` };
      });
  }
  if (csvAggregate != null && Number.isFinite(csvAggregate) && csvAggregate !== 0) {
    return [{ amount_clp: Math.round(csvAggregate), noteTag: "Depósitos" }];
  }
  return [];
}

/** True when a movement note marks a forensic-family deposit (external gift, no own outflow). */
export function ahorroDepositNoteIsForensicFamily(note: string | null | undefined): boolean {
  return String(note ?? "").includes("|funding=family");
}
