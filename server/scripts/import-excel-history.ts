/**
 * Loads monthly history from cfraser.xlsx + companion CSVs in cfraser/ (Numbers CSV export).
 *
 * - Wipes prior import accounts/valuations/movements, fx_daily, uf_daily, import:excel income/expense.
 * - Valuations from xlsx; retirement cumulative deps from Table 1-3; brokerage/cash movements from CSVs.
 * - **Real estate (property) capital flows:** one movement per payment from **`cfraser/depto-dividendos.csv`**
 *   (Numbers export of the “dividendos” / amortization sheet). Dates are actual payment days; CLP/UF/UF día, crédito
 *   restante, valor neto and pago acumulado are stored in the movement note for the account-detail ledger. No resumen
 *   monthly aggregation.
 * - Crypto (BTC/ETH): monthly **mark-to-market CLP** from Numbers CSV `net worth-Table 1-2.csv` (cols “Cripto total”, “BTC”, “ETH”);
 *   legs are reconciled to the total when they disagree (same logic as before for the sparse xlsx sheet, which is not used).
 *   **Movements** from xlsx “cripto - Bitcoin – BTC” / “cripto - Ether – ETH”: col 1 Depositado CLP (+), col 4 Retirado CLP (−);
 *   coin amounts in notes for audit.
 * - Sheet “stocks”: monthly valuations from Table 1-3 col 18 (total). **SPY/VEA `brokerage_flows`:** keep
 *   **`cfraser/stocks-lots.csv`** in the repo (broker / certificate SoT: CLP **`deposit_clp`**, **`compra_usd`**, **`dividend_usd`**,
 *   **`units`**). `import:excel` loads it **first**; it is **not** derived from Excel. If the file is missing or invalid,
 *   import falls back to one **`deposit_clp` per ticker** from Numbers `net worth-stocks.csv` only (no lots → broken MTM / VEA).
 *   Extra CLP wires may use **`omit:split`** in the note so they do not inflate the SPY/VEA share of combined Table 1-3 `stocks`.
 *   **SPY/VEA monthly CLP** when `stocks-lots.csv` has **`units`**: no `valuations`
 *   rows for those accounts — MTM at read time from **`equity_daily`** (Yahoo EOD) × cumulative units × **`fx_daily`**.
 *   Otherwise SPY/VEA use the Table 1-3 combined `stocks` split into `valuations`.
 *   **Import** calls Yahoo for SPY, VEA, BTC-USD, ETH-USD closes into `equity_daily` — needs **network** during `import:excel`.
 * - **`fund-unit-values.csv`** (optional): semicolon CSV with header `series_key;day;unit_value_clp;note` for valor-cuota
 *   series (e.g. `afp_uno_cuota_a`, `fintual_risky_norris`, `fintual_risky_norris_apv`). Upserts **`fund_unit_daily`**.
 * - Monthly snapshots (`valuations`, `fx_daily`, `uf_daily`, import movements tied to sheet months) use the **last calendar day** of each month.
 *   For **`compra_usd`** in lots CSV use dot decimals
 *   (`612.36`) — `numCsv` would misread that as 61236 USD.
 * - UF (CLF): month-end from Excel / **`variables-Table 1-1.csv`** (CLP per 1 UF), then optional **`uf-daily.csv`**
 *   (semicolon `date;clp_per_uf`, official daily values) **overrides** those dates — run `npm run fetch-uf` to refresh from SII (valores y fechas / UF). EUR/CLP from same variables sheet → **`eur_daily`**.
 * - Optional **`ipc-index.csv`**: semicolon `date;ipc_index` (month-ends) → **`ipc_daily`** (IPC price index level).
 * - AFC: balance from Table 1-3 col 35. **Valuations** allow 0 after a full withdrawal (no stale forward-fill).
 *   **Movements** combine that balance series with `net worth-retiro.csv` col 14 when signs match (retiro amount for
 *   outflows; min(retiro, Δbalance) for inflows). Pure balance deltas are used when retiro disagrees in sign.
 * - Tarjeta de crédito from sheet “flujos - Gasto mensual”: monthly balance col “Saldo tc” (index 8);
 * - **Reserva (`fondo_reserva`):** month-end `movements` / “aportes” use **month-on-month Δ of Table 1-3 col 26**
 *   (cumulative Reserva “depositado”), same pattern as AFP/APV — not `net worth-cash and cash equivalents.csv` cols 7–8,
 *   which can disagree with the sheet (e.g. gross in/out vs net capital) and blow up P/L mes.
 *
 * Run: `cd server && npm run import:excel`
 * Env: EXCEL_PATH, CFRASER_CSV_DIR (default ../cfraser), IMPORT_MAX_MONTH.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import {
  emitSignedMonthlyMovement,
  monthEndDate,
  monthKey,
  numCsv,
  numUsdDotDecimal,
  parseSheetMonthCell,
  readSemicolonCsv,
  type MonthKey,
} from "./cfraser-csv.js";
import { deleteEquityDailyForImportTickers, EQUITY_DAILY_IMPORT_TICKERS, upsertEquityDailySeries } from "../src/brokerageEquityMtm.js";
import { db } from "../src/db.js";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";
import {
  buildDeptoDividendosMovementNote,
  loadDeptoDividendosPaymentRows,
} from "../src/deptoDividendosLedger.js";
import {
  fetchYahooDailyCloses,
  yahooChartPeriodSeconds,
  type EodCloseSeries,
} from "../src/equityYahooEod.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Row = (string | number | Date | null | undefined)[];

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.replace(/[$\s]/g, "").replace(/\./g, "").replace(/,/g, ".");
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** “flujos - Gasto mensual”: two headers “Crédito”; cuota mes is col 9 when filled, else col 28 (never both non-zero in sample data). */
function creditCardInstallmentClp(row: Row): number | null {
  const nextSaldoTc = num(row[9]);
  const inGastoBreakdown = num(row[28]);
  if (nextSaldoTc != null && nextSaldoTc > 0) return nextSaldoTc;
  if (inGastoBreakdown != null && inGastoBreakdown > 0) return inGastoBreakdown;
  return null;
}

function readSheetRows(wb: XLSX.WorkBook, sheetName: string): Row[] {
  const sh = wb.Sheets[sheetName];
  if (!sh) {
    console.warn(`missing sheet: ${sheetName}`);
    return [];
  }
  return XLSX.utils.sheet_to_json<Row>(sh, { header: 1, defval: null, raw: true }) as Row[];
}

function eachDateRow(rows: Row[], fn: (date: Date, row: Row) => void) {
  for (const row of rows) {
    const d = row[0];
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) continue;
    fn(d, row);
  }
}

/**
 * Reconcile BTC/ETH CLP legs to a portfolio total (Numbers “Cripto total” vs split columns).
 * When only total is set, split 50/50. When sum of legs ≤ 0 or total missing, return raw legs.
 */
function reconcileCryptoSplit(
  total: number | null,
  rawBtc: number | null,
  rawEth: number | null
): { btc: number | null; eth: number | null } {
  const b = rawBtc ?? 0;
  const e = rawEth ?? 0;
  const sum = b + e;

  if (rawBtc == null && rawEth == null) {
    if (total != null && total > 0) return { btc: total / 2, eth: total / 2 };
    return { btc: null, eth: null };
  }

  if (sum <= 0) {
    return { btc: rawBtc, eth: rawEth };
  }

  if (total == null || !Number.isFinite(total)) {
    return { btc: rawBtc, eth: rawEth };
  }

  const tol = Math.max(1, Math.abs(sum) * 1e-9);
  if (Math.abs(total - sum) <= tol) {
    return { btc: rawBtc, eth: rawEth };
  }

  const scale = total / sum;
  if (rawBtc != null && rawEth != null) {
    return { btc: b * scale, eth: e * scale };
  }
  if (rawBtc != null && rawEth == null) {
    return { btc: total, eth: null };
  }
  if (rawBtc == null && rawEth != null) {
    return { btc: null, eth: total };
  }
  return { btc: rawBtc, eth: rawEth };
}

/** `net worth-Table 1-2.csv`: col 2 Cripto total, col 5 BTC CLP, col 8 Ether CLP (0-based string row from readSemicolonCsv). */
function mergeCryptoValuationsFromTable12Csv(
  cfraserDir: string,
  maxMonth: MonthKey,
  bump: (mk: MonthKey, patch: Partial<Bucket>) => void
) {
  const rows = readSemicolonCsv(path.join(cfraserDir, "net worth-Table 1-2.csv"));
  for (let i = 3; i < rows.length; i++) {
    const row = rows[i];
    const d = parseSheetMonthCell(String(row[0] ?? ""));
    if (!d) continue;
    const mk = monthKey(d);
    if (mk > maxMonth) continue;
    const { btc, eth } = reconcileCryptoSplit(numCsv(row[2]), numCsv(row[5]), numCsv(row[8]));
    bump(mk, { btc, eth });
  }
}

type Bucket = {
  fintual_direct?: number | null;
  stocks?: number | null;
  brokerage_total?: number | null;
  reserva?: number | null;
  afp?: number | null;
  apv_a?: number | null;
  apv_b?: number | null;
  afc?: number | null;
  cuenta?: number | null;
  btc?: number | null;
  eth?: number | null;
  property?: number | null;
  liabilities?: number | null;
  fx?: number | null;
  eur?: number | null;
  uf?: number | null;
  dep_fintual?: number | null;
  dep_stocks?: number | null;
  dep_afp?: number | null;
  dep_apv_a?: number | null;
  dep_apv_b?: number | null;
  /** Table 1-3 col 26: cumulative Reserva “depositado” (authoritative net external capital vs cash CSV gross in/out). */
  dep_reserva?: number | null;
};

type MovStmt = ReturnType<typeof db.prepare>;

/**
 * AFC capital-flow movements: prefer `net worth-retiro.csv` col 14 when it agrees in sign with the
 * month-on-month change in Table 1-3 col 35 (balance). Large withdrawals (e.g. Mar 2021) use the retiro amount;
 * co-directional inflows use min(retiro, balance delta) so sheet “afc” cash beats mark-to-market noise.
 */
function importAfcMovementsFromTable13AndRetiro(
  monthsAsc: MonthKey[],
  byMonth: Map<MonthKey, Bucket>,
  cfraserDir: string,
  maxMonth: MonthKey,
  afcAccountId: number,
  insMov: MovStmt
) {
  const retiroAfcByMonth = new Map<MonthKey, number>();
  const rRows = readSemicolonCsv(path.join(cfraserDir, "net worth-retiro.csv"));
  for (let i = 3; i < rRows.length; i++) {
    const row = rRows[i];
    const d = parseSheetMonthCell(String(row[0] ?? ""));
    if (!d) continue;
    const mk = monthKey(d);
    if (mk > maxMonth) continue;
    const r14 = numCsv(row[14]);
    if (r14 != null && r14 !== 0) retiroAfcByMonth.set(mk, r14);
  }

  const note = "import:excel|afc-flow|Table1-3+retiro-col14";
  let prevBal: number | null = null;
  for (const mk of monthsAsc) {
    const cur = byMonth.get(mk)?.afc;
    if (cur == null || !Number.isFinite(cur)) continue;
    if (prevBal === null) {
      prevBal = cur;
      continue;
    }
    const dBal = cur - prevBal;
    prevBal = cur;
    if (dBal === 0 || !Number.isFinite(dBal)) continue;

    const ret = retiroAfcByMonth.get(mk);
    let amt = dBal;
    if (ret != null && ret !== 0) {
      if (ret < 0 && dBal < 0) amt = ret;
      else if (ret > 0 && dBal > 0) amt = Math.min(ret, dBal);
    }

    insMov.run(afcAccountId, amt, monthEndDate(mk), note);
  }
}

function emitCumulativeDeltas(
  months: MonthKey[],
  getCum: (mk: MonthKey) => number | null | undefined,
  ins: ReturnType<typeof db.prepare>,
  accountId: number,
  note: string,
  /** Split sheet-level cumulative between accounts (e.g. 0.5 each for SPY / VEA). */
  scale = 1
) {
  let prev: number | null = null;
  for (const mk of months) {
    const cum = getCum(mk);
    if (cum == null || !Number.isFinite(cum)) continue;
    const c = cum * scale;
    if (prev === null) {
      prev = c;
      continue;
    }
    const delta = c - prev;
    prev = c;
    if (delta === 0 || !Number.isFinite(delta)) continue;
    const day = monthEndDate(mk);
    ins.run(accountId, delta, day, note);
  }
}

/**
 * Optional `cfraser/fund-unit-values.csv`: semicolon; header `series_key;day;unit_value_clp;note`.
 * Series keys (examples): `afp_uno_cuota_a`, `fintual_risky_norris`, `fintual_risky_norris_apv`.
 */
function importFundUnitDailyCsv(cfraserDir: string): number {
  const fp = path.join(cfraserDir, "fund-unit-values.csv");
  if (!fs.existsSync(fp)) return 0;
  const rows = readSemicolonCsv(fp);
  if (rows.length < 2) return 0;
  const h0 = rows[0]!.map((c) => String(c ?? "").trim().toLowerCase().replace(/^\ufeff/, ""));
  const col = (name: string) => h0.indexOf(name);
  const ik = col("series_key");
  const idy = col("day");
  const iv = col("unit_value_clp");
  const inote = col("note");
  if (ik < 0 || idy < 0 || iv < 0) {
    console.warn("import:excel: fund-unit-values.csv needs headers series_key;day;unit_value_clp;note(optional)");
    return 0;
  }
  const ins = db.prepare(
    `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note) VALUES (?,?,?,?)
     ON CONFLICT(series_key, day) DO UPDATE SET unit_value_clp = excluded.unit_value_clp, note = excluded.note`
  );
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.some((c) => String(c ?? "").trim())) continue;
    const sk = String(row[ik] ?? "").trim();
    const day = String(row[idy] ?? "").trim();
    const v = numCsv(row[iv]);
    if (!sk || !/^\d{4}-\d{2}-\d{2}$/.test(day) || v == null || !Number.isFinite(v)) continue;
    const note = inote >= 0 && row[inote] != null ? String(row[inote]).trim() || null : null;
    ins.run(sk, day, v, note);
    n += 1;
  }
  if (n > 0) console.log(`import:excel: fund_unit_daily rows upserted: ${n}`);
  return n;
}

function mergeUfFromVariablesCsv(
  cfraserDir: string,
  maxMonth: MonthKey,
  upsertUf: ReturnType<typeof db.prepare>
) {
  const rows = readSemicolonCsv(path.join(cfraserDir, "variables-Table 1-1.csv"));
  for (let i = 3; i < rows.length; i++) {
    const row = rows[i];
    const d = parseSheetMonthCell(String(row[0] ?? ""));
    if (!d) continue;
    const mk = monthKey(d);
    if (mk > maxMonth) continue;
    const uf = numCsv(row[3]);
    if (uf == null || uf < 1000 || uf > 1e6) continue;
    upsertUf.run({ date: monthEndDate(mk), clp_per_uf: uf });
  }
}

/** Optional `cfraser/ipc-index.csv`: semicolon; header `date;ipc_index` (IPC general index level, e.g. INE). */
function importIpcDailyCsv(cfraserDir: string): number {
  const fp = path.join(cfraserDir, "ipc-index.csv");
  if (!fs.existsSync(fp)) return 0;
  const rows = readSemicolonCsv(fp);
  if (rows.length < 2) return 0;
  const h0 = rows[0]!.map((c) => String(c ?? "").trim().toLowerCase().replace(/^\ufeff/, ""));
  const col = (name: string) => h0.indexOf(name);
  const id = col("date");
  const ii = col("ipc_index");
  if (id < 0 || ii < 0) {
    console.warn("import:excel: ipc-index.csv needs headers date;ipc_index");
    return 0;
  }
  const ins = db.prepare(
    `INSERT INTO ipc_daily (date, ipc_index) VALUES (?,?)
     ON CONFLICT(date) DO UPDATE SET ipc_index = excluded.ipc_index`
  );
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.some((c) => String(c ?? "").trim())) continue;
    const day = String(row[id] ?? "").trim();
    const v = numCsv(row[ii]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || v == null || !Number.isFinite(v) || v <= 0) continue;
    ins.run(day, v);
    n += 1;
  }
  if (n > 0) console.log(`import:excel: ipc_daily rows upserted: ${n}`);
  return n;
}

/**
 * `uf-daily.csv` from `fetch-sii-uf-daily` uses dot as decimal (`40133.5`). {@link numCsv} is for Chilean
 * Numbers exports (`36.000,23`) and would misread dot-decimal as thousands (e.g. `40133.5` → `401335`).
 */
function clpPerUfFromUfDailyCell(raw: unknown): number | null {
  const dot = numUsdDotDecimal(raw);
  if (dot != null && dot >= 1000 && dot < 1e6) return dot;
  const chilean = numCsv(raw);
  if (chilean != null && chilean >= 1000 && chilean < 1e6) return chilean;
  return null;
}

/** Optional `cfraser/uf-daily.csv`: semicolon; header `date;clp_per_uf` (CLP per 1 UF, official daily). Overrides same dates from monthly UF. */
function importUfDailyCsv(cfraserDir: string, upsertUf: ReturnType<typeof db.prepare>): number {
  const fp = path.join(cfraserDir, "uf-daily.csv");
  if (!fs.existsSync(fp)) return 0;
  const rows = readSemicolonCsv(fp);
  if (rows.length < 2) return 0;
  const h0 = rows[0]!.map((c) => String(c ?? "").trim().toLowerCase().replace(/^\ufeff/, ""));
  const col = (name: string) => h0.indexOf(name);
  const id = col("date");
  const iu = col("clp_per_uf");
  if (id < 0 || iu < 0) {
    console.warn("import:excel: uf-daily.csv needs headers date;clp_per_uf");
    return 0;
  }
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.some((c) => String(c ?? "").trim())) continue;
    const day = String(row[id] ?? "").trim();
    const v = clpPerUfFromUfDailyCell(row[iu]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || v == null || !Number.isFinite(v) || v < 1000 || v > 1e6) continue;
    upsertUf.run({ date: day, clp_per_uf: v });
    n += 1;
  }
  if (n > 0) console.log(`import:excel: uf_daily rows from uf-daily.csv: ${n}`);
  return n;
}

function mergeEurFromVariablesCsv(
  cfraserDir: string,
  maxMonth: MonthKey,
  upsertEur: ReturnType<typeof db.prepare>
) {
  const rows = readSemicolonCsv(path.join(cfraserDir, "variables-Table 1-1.csv"));
  for (let i = 3; i < rows.length; i++) {
    const row = rows[i];
    const d = parseSheetMonthCell(String(row[0] ?? ""));
    if (!d) continue;
    const mk = monthKey(d);
    if (mk > maxMonth) continue;
    const eur = numCsv(row[2]);
    if (eur == null || eur < 50 || eur > 50000) continue;
    upsertEur.run({ date: monthEndDate(mk), clp_per_eur: eur });
  }
}

/** Monthly Fintual RN cash flows from Numbers CSV (col 5). Acciones use Table 1-3 cumulative stocks depositado only to avoid double counting. */
/** One CLP `deposit_clp` per ticker from Numbers `net worth-stocks.csv` “depositado” (not cumulative Table 1-3). */
function importSpyVeaDepositadoFromStocksCsv(
  cfraserDir: string,
  maxMonth: MonthKey,
  spyId: number,
  veaId: number
): number {
  const fp = path.join(cfraserDir, "net worth-stocks.csv");
  if (!fs.existsSync(fp)) return 0;
  const rows = readSemicolonCsv(fp);
  const ins = db.prepare(
    `INSERT INTO brokerage_flows (account_id, occurred_on, flow_kind, amount_clp, amount_usd, ticker, note, units_delta)
     VALUES (?, ?, 'deposit_clp', ?, NULL, ?, ?, NULL)`
  );
  // SPY: Numbers “depositado” + Fintual first buy align to **2024-12-10** (certificate trade date).
  // VEA: keep Jan 2025 month-end when that row exists in Numbers (rare after stocks-lots SoT).
  const spyDepositDay = maxMonth >= "2024-12" ? "2024-12-10" : monthEndDate(maxMonth);
  const veaDepositMonth: MonthKey = "2025-01";
  const veaDepositDay =
    maxMonth >= veaDepositMonth ? monthEndDate(veaDepositMonth) : monthEndDate(maxMonth);
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const key = String(row[0] ?? "")
      .trim()
      .replace(/^\ufeff/, "")
      .toLowerCase();
    const dep = numCsv(row[3]);
    if (dep == null || dep <= 0) continue;
    if (key === "spy") {
      ins.run(spyId, spyDepositDay, dep, "SPY", "import:excel|net worth-stocks.csv|depositado");
      n += 1;
    } else if (key === "vea") {
      ins.run(veaId, veaDepositDay, dep, "VEA", "import:excel|net worth-stocks.csv|depositado");
      n += 1;
    }
  }
  return n;
}

/** Sum `deposit_clp` per ticker in `stocks-lots.csv` for Table 1-3 `stocks` split (Numbers-level only). Rows whose note contains `omit:split` are extra broker wires and must not inflate the SPY/VEA ratio. */
function readSpyVeaDepositadoWeightsFromStocksLots(cfraserDir: string): { spy: number; vea: number } {
  const out = { spy: 0, vea: 0 };
  const filePath = path.join(cfraserDir, "stocks-lots.csv");
  if (!fs.existsSync(filePath)) return out;
  const rows = readSemicolonCsv(filePath);
  if (rows.length < 2) return out;
  const header = rows[0].map((c) =>
    String(c ?? "")
      .trim()
      .replace(/^\ufeff/, "")
      .toLowerCase()
  );
  if (header[0] !== "occurred_on" || header[1] !== "ticker" || header[2] !== "flow_kind") return out;
  const useUnitsCol = header[5] === "units";
  const noteCol = useUnitsCol ? 6 : 5;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const flowKind = String(row[2] ?? "").trim();
    if (flowKind !== "deposit_clp") continue;
    const noteRaw = row[noteCol] != null ? String(row[noteCol]).trim() : "";
    if (noteRaw.toLowerCase().includes("omit:split")) continue;
    const aclp = numCsv(row[3]);
    if (aclp == null || aclp <= 0) continue;
    const ticker = String(row[1] ?? "")
      .trim()
      .replace(/^\ufeff/, "")
      .toUpperCase();
    if (ticker === "SPY") out.spy += aclp;
    else if (ticker === "VEA") out.vea += aclp;
  }
  return out;
}

/** Sum USD notionals on `compra_usd` per ticker — splits Table 1-3 `stocks` when deposit weights are one-sided (VEA CLP wires often use omit:split). */
function readSpyVeaCompraUsdNotionalFromStocksLots(cfraserDir: string): { spy: number; vea: number } {
  const out = { spy: 0, vea: 0 };
  const filePath = path.join(cfraserDir, "stocks-lots.csv");
  if (!fs.existsSync(filePath)) return out;
  const rows = readSemicolonCsv(filePath);
  if (rows.length < 2) return out;
  const header = rows[0].map((c) =>
    String(c ?? "")
      .trim()
      .replace(/^\ufeff/, "")
      .toLowerCase()
  );
  if (header[0] !== "occurred_on" || header[1] !== "ticker" || header[2] !== "flow_kind") return out;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (String(row[2] ?? "").trim() !== "compra_usd") continue;
    const ausd = numUsdDotDecimal(row[4]) ?? numCsv(row[4]);
    if (ausd == null || !Number.isFinite(ausd) || ausd <= 0) continue;
    const ticker = String(row[1] ?? "")
      .trim()
      .replace(/^\ufeff/, "")
      .toUpperCase();
    if (ticker === "SPY") out.spy += ausd;
    else if (ticker === "VEA") out.vea += ausd;
  }
  return out;
}

/** Resolve SPY vs VEA weight for splitting combined `stocks`: broker lots first, then Numbers `depositado`, then compra USD notionals from lots. */
function resolveSpyVeaStockSplitWeights(cfraserDir: string): { spy: number; vea: number } {
  const fromLots = readSpyVeaDepositadoWeightsFromStocksLots(cfraserDir);
  if (fromLots.spy > 0 && fromLots.vea > 0) return fromLots;
  const fromNw = readSpyVeaDepositadoWeights(cfraserDir);
  if (fromNw.spy > 0 && fromNw.vea > 0) return fromNw;
  if (fromNw.spy > 0 || fromNw.vea > 0) {
    return {
      spy: fromLots.spy > 0 ? fromLots.spy : fromNw.spy,
      vea: fromLots.vea > 0 ? fromLots.vea : fromNw.vea,
    };
  }
  const cap = readSpyVeaCompraUsdNotionalFromStocksLots(cfraserDir);
  if (cap.spy + cap.vea > 0) return cap;
  if (fromLots.spy + fromLots.vea > 0) return fromLots;
  return { spy: 0, vea: 0 };
}

/** CLP “depositado” per ticker from `net worth-stocks.csv` (row 0 = ticker, col 3 = depositado); used to split combined Table 1-3 `stocks`. */
function readSpyVeaDepositadoWeights(cfraserDir: string): { spy: number; vea: number } {
  const out = { spy: 0, vea: 0 };
  const fp = path.join(cfraserDir, "net worth-stocks.csv");
  if (!fs.existsSync(fp)) return out;
  const rows = readSemicolonCsv(fp);
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const key = String(row[0] ?? "")
      .trim()
      .replace(/^\ufeff/, "")
      .toLowerCase();
    const dep = numCsv(row[3]);
    if (dep == null || dep <= 0) continue;
    if (key === "spy") out.spy = dep;
    else if (key === "vea") out.vea = dep;
  }
  return out;
}

function accountHasUnitsDelta(accountId: number): boolean {
  const r = db
    .prepare(
      `SELECT 1 FROM brokerage_flows WHERE account_id = ? AND COALESCE(units_delta, 0) != 0 LIMIT 1`
    )
    .get(accountId) as { 1: number } | undefined;
  return r != null;
}

/** Optional `stocks-lots.csv`: `occurred_on;ticker;flow_kind;amount_clp;amount_usd;units;note` (`units` optional). */
function importStocksLotsCsv(
  cfraserDir: string,
  maxMonth: MonthKey,
  spyId: number,
  veaId: number
): number {
  const filePath = path.join(cfraserDir, "stocks-lots.csv");
  if (!fs.existsSync(filePath)) return 0;
  const rows = readSemicolonCsv(filePath);
  if (rows.length < 2) return 0;
  const header = rows[0].map((c) =>
    String(c ?? "")
      .trim()
      .replace(/^\ufeff/, "")
      .toLowerCase()
  );
  if (header[0] !== "occurred_on" || header[1] !== "ticker" || header[2] !== "flow_kind") {
    console.warn(
      "import:excel: stocks-lots.csv: expected header occurred_on;ticker;flow_kind;amount_clp;amount_usd;[units;]note"
    );
    return 0;
  }
  const useUnitsCol = header[5] === "units";
  const noteCol = useUnitsCol ? 6 : 5;
  const ins = db.prepare(
    `INSERT INTO brokerage_flows (account_id, occurred_on, flow_kind, amount_clp, amount_usd, ticker, note, units_delta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const kinds = new Set(["deposit_clp", "compra_usd", "dividend_usd", "withdrawal_clp", "other"]);
  let inserted = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const occurredOn = String(row[0] ?? "")
      .trim()
      .replace(/^\ufeff/, "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) continue;
    const mk = occurredOn.slice(0, 7) as MonthKey;
    if (mk > maxMonth) continue;
    const ticker = String(row[1] ?? "")
      .trim()
      .replace(/^\ufeff/, "")
      .toUpperCase();
    const flowKind = String(row[2] ?? "").trim();
    if (!kinds.has(flowKind)) continue;
    const accountId = ticker === "SPY" ? spyId : ticker === "VEA" ? veaId : 0;
    if (!accountId) continue;
    const aclp = numCsv(row[3]);
    const ausd = numUsdDotDecimal(row[4]) ?? numCsv(row[4]);
    const unitsRaw = useUnitsCol ? row[5] : undefined;
    const unitsDelta = unitsRaw != null && String(unitsRaw).trim() !== "" ? numUsdDotDecimal(unitsRaw) : null;
    const note =
      row[noteCol] != null && String(row[noteCol]).trim() !== "" ? String(row[noteCol]).trim() : null;
    const hasMoney =
      (aclp != null && aclp !== 0) ||
      (ausd != null && ausd !== 0) ||
      (unitsDelta != null && unitsDelta !== 0);
    if (!hasMoney) continue;
    ins.run(accountId, occurredOn, flowKind, aclp, ausd, ticker || null, note, unitsDelta);
    inserted += 1;
  }
  return inserted;
}

function importBrokerageCsvMovements(
  cfraserDir: string,
  maxMonth: MonthKey,
  accounts: { fintual_rn: number },
  insMov: MovStmt
) {
  const rows = readSemicolonCsv(path.join(cfraserDir, "net worth-brokerage.csv"));
  const noteF = "import:excel|csv|brokerage|Risky Norris";
  for (const row of rows) {
    const d = parseSheetMonthCell(String(row[0] ?? ""));
    if (!d) continue;
    const mk = monthKey(d);
    if (mk > maxMonth) continue;
    const day = monthEndDate(mk);
    const vF = numCsv(row[5]);
    emitSignedMonthlyMovement(insMov, accounts.fintual_rn, vF, day, noteF);
  }
}

/**
 * Property payments from Numbers `depto-dividendos.csv` (one row per transfer; real payment dates, e.g. several in Feb).
 */
function importDeptoDividendosPropertyPayments(
  cfraserDir: string,
  maxMonth: MonthKey,
  propertyId: number,
  insMov: MovStmt
): number {
  const rows = loadDeptoDividendosPaymentRows(cfraserDir);
  if (rows.length === 0) {
    console.warn(
      "import:excel: depto-dividendos.csv has no CLP payment rows — export the sheet from Numbers to cfraser/depto-dividendos.csv"
    );
    return 0;
  }
  const sorted = [...rows].sort((a, b) => {
    const c = a.occurred_on.localeCompare(b.occurred_on);
    return c !== 0 ? c : a.cuota.localeCompare(b.cuota);
  });
  let n = 0;
  let sumClp = 0;
  let lastPaclp: number | null = null;
  for (const r of sorted) {
    const mk = r.occurred_on.slice(0, 7) as MonthKey;
    if (mk > maxMonth) continue;
    sumClp += r.amount_clp;
    if (r.pago_acumulado_clp != null) lastPaclp = r.pago_acumulado_clp;
    insMov.run(propertyId, r.amount_clp, r.occurred_on, buildDeptoDividendosMovementNote(r));
    n += 1;
  }
  if (lastPaclp != null) {
    const diff = Math.round(lastPaclp - sumClp);
    if (Math.abs(diff) > 2) {
      console.warn(
        `import:excel: depto-dividendos ΣCLP ${Math.round(sumClp)} vs sheet pago acumulado ${Math.round(lastPaclp)} (diff ${diff})`
      );
    } else {
      console.log(
        `import:excel: depto-dividendos → ${n} property payments; ΣCLP matches sheet pago acumulado (diff ${diff})`
      );
    }
  } else {
    console.log(`import:excel: depto-dividendos → ${n} property payments (ΣCLP ${Math.round(sumClp)})`);
  }
  return n;
}

/** Ledger rows: [0]=month, [1]=dep CLP, [2–3]=coin/rate, [4]=withdraw CLP, [5]=coin out. */
function importCriptoLedgerSheets(
  wb: XLSX.WorkBook,
  maxMonth: MonthKey,
  btcId: number,
  ethId: number,
  insMov: MovStmt
): number {
  let inserted = 0;
  const emit = (
    accountId: number,
    signedClp: number,
    day: string,
    asset: "BTC" | "ETH",
    leg: "dep" | "wdw",
    coinA: unknown,
    coinB?: unknown
  ) => {
    if (!Number.isFinite(signedClp) || signedClp === 0) return;
    const a = num(coinA);
    const b = coinB !== undefined ? num(coinB) : null;
    const note = [
      `import:excel|cripto-sheet|${asset}|${leg}`,
      a != null ? `coin=${a}` : null,
      b != null ? `x=${b}` : null,
    ]
      .filter(Boolean)
      .join("|");
    insMov.run(accountId, signedClp, day, note);
    inserted += 1;
  };

  const walk = (sheetLabel: string | undefined, accountId: number, asset: "BTC" | "ETH") => {
    if (!sheetLabel) {
      console.warn(`import:excel: missing sheet for ${asset} ledger`);
      return;
    }
    const rows = readSheetRows(wb, sheetLabel);
    for (const row of rows) {
      const d = row[0];
      if (!(d instanceof Date) || Number.isNaN(d.getTime())) continue;
      const mk = monthKey(d);
      if (mk > maxMonth) continue;
      const day = monthEndDate(mk);
      const dep = num(row[1]);
      const wdw = num(row[4]);
      if (dep != null && dep !== 0) emit(accountId, dep, day, asset, "dep", row[2], row[3]);
      if (wdw != null && wdw !== 0) emit(accountId, -Math.abs(wdw), day, asset, "wdw", row[5]);
    }
  };

  const btcSheet = wb.SheetNames.find((s) => /cripto/i.test(s) && /bitcoin/i.test(s));
  const ethSheet = wb.SheetNames.find((s) => /cripto/i.test(s) && /ether/i.test(s));
  walk(btcSheet, btcId, "BTC");
  walk(ethSheet, ethId, "ETH");
  return inserted;
}

function importCashCsvMovements(
  cfraserDir: string,
  maxMonth: MonthKey,
  cuentaId: number,
  /** When null, Reserva flows come from Table 1-3 cumulative `dep_reserva` (see `emitCumulativeDeltas`), not cash CSV 7–8. */
  reservaId: number | null,
  insMov: MovStmt
) {
  const rows = readSemicolonCsv(path.join(cfraserDir, "net worth-cash and cash equivalents.csv"));
  for (let i = 5; i < rows.length; i++) {
    const row = rows[i];
    const d = parseSheetMonthCell(String(row[0] ?? ""));
    if (!d) continue;
    const mk = monthKey(d);
    if (mk > maxMonth) continue;
    const day = monthEndDate(mk);
    /** Row shape: `Jun 17;total;;depósitos;abonos;intereses` → 3–5 cuenta. */
    const cuentaDep = numCsv(row[3]);
    emitSignedMonthlyMovement(insMov, cuentaId, cuentaDep, day, "import:excel|csv|cash|Depósitos");
    if (reservaId != null) {
      const reservaIn = numCsv(row[7]);
      const reservaOut = numCsv(row[8]);
      let reservaNet: number | null = null;
      if (reservaIn != null) reservaNet = (reservaNet ?? 0) + reservaIn;
      if (reservaOut != null) reservaNet = (reservaNet ?? 0) + reservaOut;
      emitSignedMonthlyMovement(
        insMov,
        reservaId,
        reservaNet,
        day,
        "import:excel|csv|cash|Reserva Fintual (depósitos + retiros)"
      );
    }
  }
}

async function main() {
  const excelPath = process.env.EXCEL_PATH
    ? path.resolve(process.env.EXCEL_PATH)
    : path.resolve(__dirname, "..", "..", "cfraser.xlsx");

  if (!fs.existsSync(excelPath)) {
    console.error(`Excel not found: ${excelPath}`);
    process.exit(1);
  }

  const wipe = db.transaction(() => {
    db.exec(`
      DELETE FROM valuations WHERE account_id IN (
        SELECT id FROM accounts WHERE notes LIKE 'import:excel%' OR notes LIKE 'import:cfraser%'
      );
      DELETE FROM movements WHERE account_id IN (
        SELECT id FROM accounts WHERE notes LIKE 'import:excel%' OR notes LIKE 'import:cfraser%'
      );
      DELETE FROM accounts WHERE notes LIKE 'import:excel%' OR notes LIKE 'import:cfraser%';
      DELETE FROM income_entries WHERE note LIKE 'import:excel%';
      DELETE FROM expense_entries WHERE note LIKE 'import:excel%';
      DELETE FROM fx_daily;
      DELETE FROM uf_daily;
      DELETE FROM eur_daily;
      DELETE FROM ipc_daily;
      DELETE FROM fund_unit_daily;
    `);
    deleteEquityDailyForImportTickers();
  });
  wipe();

  const catStmt = db.prepare("SELECT id FROM categories WHERE slug = ?");
  const catId = (slug: string) => (catStmt.get(slug) as { id: number }).id;

  const insAcc = db.prepare(
    "INSERT INTO accounts (category_id, name, notes) VALUES (?, ?, ?)"
  );

  function ensureAccount(slug: string, name: string, key: string): number {
    const note = `import:excel|key=${key}`;
    const row = db.prepare("SELECT id FROM accounts WHERE notes = ?").get(note) as { id: number } | undefined;
    if (row) return row.id;
    const r = insAcc.run(catId(slug), name, note);
    return Number(r.lastInsertRowid);
  }

  const accounts = {
    afp: ensureAccount("afp", "AFP", "afp"),
    apv_a: ensureAccount("apv", "APV régimen A", "apv_a"),
    apv_b: ensureAccount("apv", "APV régimen B", "apv_b"),
    afc: ensureAccount("afc", "AFC", "afc"),
    fintual_rn: ensureAccount("fintual_risky_norris", "Fintual RN", "fintual_rn"),
    fondo_reserva: ensureAccount("fondo_reserva", "Reserva (Fintual / sheet)", "fondo_reserva"),
    cuenta_corriente: ensureAccount("cuenta_corriente", "Cuenta corriente", "cuenta_corriente"),
    bitcoin: ensureAccount("bitcoin", "Bitcoin", "bitcoin"),
    eth: ensureAccount("eth", "Ether", "eth"),
    property: ensureAccount("property", "Inmuebles (total hoja)", "property"),
    mortgage: ensureAccount("mortgage", "Pasivos (total hoja)", "mortgage"),
    spy: ensureAccount("spy", "SPY", "spy"),
    vea: ensureAccount("vea", "VEA", "vea"),
    credit_card: ensureAccount("credit_card", "Tarjeta de crédito", "credit_card"),
  };

  const upsertVal = db.prepare(`
    INSERT INTO valuations (account_id, as_of_date, value_clp)
    VALUES (@account_id, @as_of_date, @value_clp)
    ON CONFLICT(account_id, as_of_date) DO UPDATE SET value_clp = excluded.value_clp
  `);

  const upsertFx = db.prepare(`
    INSERT INTO fx_daily (date, clp_per_usd) VALUES (@date, @clp_per_usd)
    ON CONFLICT(date) DO UPDATE SET clp_per_usd = excluded.clp_per_usd
  `);

  const upsertEur = db.prepare(`
    INSERT INTO eur_daily (date, clp_per_eur) VALUES (@date, @clp_per_eur)
    ON CONFLICT(date) DO UPDATE SET clp_per_eur = excluded.clp_per_eur
  `);

  const upsertUf = db.prepare(`
    INSERT INTO uf_daily (date, clp_per_uf) VALUES (@date, @clp_per_uf)
    ON CONFLICT(date) DO UPDATE SET clp_per_uf = excluded.clp_per_uf
  `);

  const insMov = db.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note) VALUES (?,?,?,?)`
  );

  const insIncome = db.prepare(
    `INSERT INTO income_entries (amount_clp, received_on, source, note) VALUES (?,?,?,?)`
  );

  const insExpense = db.prepare(
    `INSERT INTO expense_entries (amount_clp, spent_on, category, note) VALUES (?,?,?,?)`
  );

  const byMonth = new Map<MonthKey, Bucket>();

  const maxMonth: MonthKey =
    (process.env.IMPORT_MAX_MONTH as MonthKey | undefined) ??
    monthKey(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)));

  function bump(mk: MonthKey, patch: Partial<Bucket>) {
    if (mk > maxMonth) return;
    const cur = byMonth.get(mk) ?? {};
    Object.assign(cur, patch);
    byMonth.set(mk, cur);
  }

  const cfraserDir = resolveCfraserCsvDir();

  const buf = fs.readFileSync(excelPath);
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });

  const t13 = readSheetRows(wb, "net worth - Table 1-3");
  eachDateRow(t13, (d, row) => {
    const mk = monthKey(d);
    bump(mk, {
      fintual_direct: num(row[11]),
      stocks: num(row[18]),
      brokerage_total: num(row[4]),
      reserva: num(row[25]),
      dep_reserva: num(row[26]),
      afp: num(row[43]),
      apv_a: num(row[50]),
      apv_b: num(row[57]),
      afc: num(row[35]),
      dep_fintual: num(row[12]),
      dep_stocks: num(row[19]),
      dep_afp: num(row[44]),
      dep_apv_a: num(row[51]),
      dep_apv_b: num(row[58]),
    });
  });

  const t121 = readSheetRows(wb, "net worth - Table 1-2-1");
  eachDateRow(t121, (d, row) => {
    bump(monthKey(d), { cuenta: num(row[2]) });
  });

  const t11 = readSheetRows(wb, "net worth - Table 1-1");
  eachDateRow(t11, (d, row) => {
    bump(monthKey(d), {
      property: num(row[6]),
      liabilities: num(row[11]),
    });
  });

  mergeCryptoValuationsFromTable12Csv(cfraserDir, maxMonth, bump);

  const fxRows = readSheetRows(wb, "variables - Table 1-1");
  eachDateRow(fxRows, (d, row) => {
    const rate = num(row[1]);
    const eurVal = num(row[2]);
    const ufVal = num(row[3]);
    const patch: Partial<Bucket> = { fx: rate };
    if (eurVal != null && eurVal > 50 && eurVal < 50000) patch.eur = eurVal;
    if (ufVal != null && ufVal > 1000 && ufVal < 1e6) patch.uf = ufVal;
    bump(monthKey(d), patch);
  });

  for (const [, b] of byMonth) {
    if (b.fintual_direct != null) {
      (b as Bucket & { fintual?: number }).fintual = b.fintual_direct;
    } else if (b.brokerage_total != null) {
      if (b.stocks != null) {
        (b as Bucket & { fintual?: number }).fintual = b.brokerage_total - b.stocks;
      } else {
        (b as Bucket & { fintual?: number }).fintual = b.brokerage_total;
      }
    }
  }

  const monthsSorted = [...byMonth.keys()].sort();

  const stockDep = resolveSpyVeaStockSplitWeights(cfraserDir);
  const stockDepSum = stockDep.spy + stockDep.vea;
  const spyStocksShare = stockDepSum > 0 ? stockDep.spy / stockDepSum : 0.5;
  const veaStocksShare = stockDepSum > 0 ? stockDep.vea / stockDepSum : 0.5;

  const eodByTicker = new Map<string, EodCloseSeries>();
  if (monthsSorted.length > 0) {
    try {
      const { period1, period2 } = yahooChartPeriodSeconds(
        monthsSorted[0],
        monthsSorted[monthsSorted.length - 1]
      );
      const settled = await Promise.allSettled(
        [...EQUITY_DAILY_IMPORT_TICKERS].map((sym) => fetchYahooDailyCloses(sym, period1, period2))
      );
      for (let i = 0; i < EQUITY_DAILY_IMPORT_TICKERS.length; i++) {
        const sym = EQUITY_DAILY_IMPORT_TICKERS[i]!;
        const r = settled[i]!;
        if (r.status === "fulfilled") {
          eodByTicker.set(sym, r.value);
        } else {
          console.warn(`import:excel: Yahoo EOD ${sym} failed`, r.reason);
        }
      }
      const parts = [...EQUITY_DAILY_IMPORT_TICKERS].map((sym) => {
        const s = eodByTicker.get(sym);
        return s ? `${sym} ${s.dates.length}d` : `${sym} —`;
      });
      console.log(`import:excel: Yahoo EOD (${parts.join(", ")}) — MTM when stocks-lots has units (SPY/VEA)`);
    } catch (e) {
      console.warn("import:excel: Yahoo EOD fetch failed; SPY/VEA use Table 1-3 split only", e);
    }
  }

  const spyEod = eodByTicker.get("SPY") ?? null;
  const veaEod = eodByTicker.get("VEA") ?? null;

  const tx = db.transaction(() => {
    let valCount = 0;
    let movCount = 0;

    const stocksLotsPath = path.join(cfraserDir, "stocks-lots.csv");
    let stocksLotsN = importStocksLotsCsv(cfraserDir, maxMonth, accounts.spy, accounts.vea);
    if (stocksLotsN === 0) {
      if (fs.existsSync(stocksLotsPath)) {
        console.warn(
          "import:excel: cfraser/stocks-lots.csv exists but no SPY/VEA rows were inserted — check header occurred_on;ticker;flow_kind;amount_clp;amount_usd;units;note, flow kinds, and IMPORT_MAX_MONTH."
        );
      } else {
        console.warn(
          "import:excel: cfraser/stocks-lots.csv missing — SPY/VEA use net worth-stocks.csv fallback (deposit_clp only, no lots). Restore stocks-lots.csv for statement-accurate history."
        );
      }
      stocksLotsN = importSpyVeaDepositadoFromStocksCsv(cfraserDir, maxMonth, accounts.spy, accounts.vea);
      if (stocksLotsN > 0) {
        console.log(
          `import:excel: SPY/VEA deposit_clp from net worth-stocks.csv (${stocksLotsN} rows); skipping 50/50 dep_stocks movements`
        );
      }
    } else {
      console.log(
        `import:excel: stocks-lots.csv → ${stocksLotsN} brokerage_flows (SPY/VEA); skipping 50/50 dep_stocks movements`
      );
    }

    importBrokerageCsvMovements(cfraserDir, maxMonth, { fintual_rn: accounts.fintual_rn }, insMov);

    const spyUsesMtm = spyEod != null && accountHasUnitsDelta(accounts.spy);
    const veaUsesMtm = veaEod != null && accountHasUnitsDelta(accounts.vea);
    if (spyUsesMtm) db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(accounts.spy);
    if (veaUsesMtm) db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(accounts.vea);

    deleteEquityDailyForImportTickers();
    for (const sym of EQUITY_DAILY_IMPORT_TICKERS) {
      const ser = eodByTicker.get(sym);
      if (!ser) continue;
      const nd = upsertEquityDailySeries(sym, ser);
      if (nd > 0) console.log(`import:excel: equity_daily ${sym} ${nd} rows`);
    }

    for (const [mk, b] of [...byMonth.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const asOf = monthEndDate(mk);
      const put = (accountId: number, v: number | null | undefined, allowNonPositive = false) => {
        if (v == null || !Number.isFinite(v)) return;
        if (!allowNonPositive && v <= 0) return;
        upsertVal.run({ account_id: accountId, as_of_date: asOf, value_clp: v });
        valCount += 1;
      };

      const fint = (b as Bucket & { fintual?: number }).fintual;
      if (fint != null && fint > 0) put(accounts.fintual_rn, fint);
      if (!spyUsesMtm && b.stocks != null && b.stocks > 0) {
        put(accounts.spy, b.stocks * spyStocksShare);
      }
      if (!veaUsesMtm && b.stocks != null && b.stocks > 0) {
        put(accounts.vea, b.stocks * veaStocksShare);
      }
      put(accounts.fondo_reserva, b.reserva);
      put(accounts.afp, b.afp);
      put(accounts.apv_a, b.apv_a);
      put(accounts.apv_b, b.apv_b);
      // AFC can go to 0 after a full withdrawal; must persist 0 or valuations forward-fill stale balances.
      put(accounts.afc, b.afc, true);
      put(accounts.cuenta_corriente, b.cuenta);
      // Table 1-2 legs can be negative while total stays positive; still store for correct crypto_total sum.
      put(accounts.bitcoin, b.btc, true);
      put(accounts.eth, b.eth, true);
      put(accounts.property, b.property);
      put(accounts.mortgage, b.liabilities, true);

      if (b.fx != null && b.fx > 50 && b.fx < 50000) {
        upsertFx.run({ date: asOf, clp_per_usd: b.fx });
      }
      if (b.eur != null && b.eur > 50 && b.eur < 50000) {
        upsertEur.run({ date: asOf, clp_per_eur: b.eur });
      }
      if (b.uf != null && b.uf > 1000 && b.uf < 1e6) {
        upsertUf.run({ date: asOf, clp_per_uf: b.uf });
      }
    }

    mergeUfFromVariablesCsv(cfraserDir, maxMonth, upsertUf);
    mergeEurFromVariablesCsv(cfraserDir, maxMonth, upsertEur);
    importUfDailyCsv(cfraserDir, upsertUf);
    importFundUnitDailyCsv(cfraserDir);
    importIpcDailyCsv(cfraserDir);

    emitCumulativeDeltas(
      monthsSorted,
      (mk) => byMonth.get(mk)?.dep_afp,
      insMov,
      accounts.afp,
      "import:excel|cumulative-depositado|Table1-3|AFP"
    );
    emitCumulativeDeltas(
      monthsSorted,
      (mk) => byMonth.get(mk)?.dep_apv_a,
      insMov,
      accounts.apv_a,
      "import:excel|cumulative-depositado|Table1-3|APV-a"
    );
    emitCumulativeDeltas(
      monthsSorted,
      (mk) => byMonth.get(mk)?.dep_apv_b,
      insMov,
      accounts.apv_b,
      "import:excel|cumulative-depositado|Table1-3|APV-b"
    );

    if (stocksLotsN === 0) {
      emitCumulativeDeltas(
        monthsSorted,
        (mk) => byMonth.get(mk)?.dep_stocks,
        insMov,
        accounts.spy,
        "import:excel|cumulative-depositado|Table1-3|stocks|SPY",
        0.5
      );
      emitCumulativeDeltas(
        monthsSorted,
        (mk) => byMonth.get(mk)?.dep_stocks,
        insMov,
        accounts.vea,
        "import:excel|cumulative-depositado|Table1-3|stocks|VEA",
        0.5
      );
    }
    importAfcMovementsFromTable13AndRetiro(monthsSorted, byMonth, cfraserDir, maxMonth, accounts.afc, insMov);
    emitCumulativeDeltas(
      monthsSorted,
      (mk) => byMonth.get(mk)?.dep_reserva,
      insMov,
      accounts.fondo_reserva,
      "import:excel|cumulative-depositado|Table1-3|Reserva"
    );
    importDeptoDividendosPropertyPayments(cfraserDir, maxMonth, accounts.property, insMov);
    const cryptoMovN = importCriptoLedgerSheets(wb, maxMonth, accounts.bitcoin, accounts.eth, insMov);
    importCashCsvMovements(cfraserDir, maxMonth, accounts.cuenta_corriente, null, insMov);

    const gastoRows = readSheetRows(wb, "flujos - Gasto mensual");
    let incomeN = 0;
    let expenseN = 0;
    let tcValN = 0;
    let tcPayN = 0;
    for (const row of gastoRows) {
      const d = row[0];
      if (!(d instanceof Date) || Number.isNaN(d.getTime())) continue;
      const mk = monthKey(d);
      if (mk > maxMonth) continue;
      const day = monthEndDate(mk);
      const ingreso = num(row[2]);
      const gasto = num(row[13]) ?? num(row[12]);
      if (ingreso != null && ingreso !== 0) {
        insIncome.run(ingreso, day, "Flujo mensual (Excel)", "import:excel|flujos|Gasto mensual|Ingreso");
        incomeN += 1;
      }
      if (gasto != null && gasto > 0) {
        insExpense.run(gasto, day, "Total mensual (Gasto)", "import:excel|flujos|Gasto mensual|Gasto");
        expenseN += 1;
      }

      const saldoTc = num(row[8]);
      if (saldoTc != null && Number.isFinite(saldoTc)) {
        upsertVal.run({
          account_id: accounts.credit_card,
          as_of_date: day,
          value_clp: saldoTc,
        });
        valCount += 1;
        tcValN += 1;
      }

      const cuota = creditCardInstallmentClp(row);
      if (cuota != null) {
        insMov.run(
          accounts.credit_card,
          -Math.abs(cuota),
          day,
          "import:excel|flujos|Gasto mensual|Crédito (cuota TC)"
        );
        tcPayN += 1;
      }
    }

    movCount = (db.prepare("SELECT COUNT(*) AS c FROM movements WHERE note LIKE 'import:excel%'").get() as {
      c: number;
    }).c;

    console.log(`import:excel valuations upserted: ${valCount}`);
    console.log(`import:excel movements inserted: ${movCount} (crypto ledger rows: ${cryptoMovN})`);
    console.log(
      `import:excel income rows: ${incomeN}, expense rows: ${expenseN}; TC valuations (Saldo tc): ${tcValN}, TC payments (Crédito): ${tcPayN}`
    );
  });
  tx();

  console.log(`Done. Source: ${excelPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
