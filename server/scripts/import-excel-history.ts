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
 *   coin cells may include an “ETH 0,…” prefix; some Retirado rows have **coin only** (CLP blank) — those still emit a movement with placeholder CLP flagged `cripto-coin-only-wdw` (excluded from aportes).
 *   `units_delta` follows cumulative-vs-monthly rules in `cryptoSheetUnits.ts` (not raw ±coin per row).
 * - Sheet “stocks”: monthly valuations from Table 1-3 col 18 (total). **SPY/VEA equity flows** in `movements` (`flow_kind`): keep
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
 * - **UF (CLF):** only from committed **`server/data/uf-sii-daily.csv`** (SII [valores y fechas / UF](https://www.sii.cl/valores_y_fechas/uf/uf2026.htm)).
 *   Not from Excel or `variables-Table 1-1.csv`. Refresh with `npm run fetch-uf -w nw-tracker-server`.
 *   USD/EUR daily observado: SBIF (`npm run backfill:sbif-fx-eur -w nw-tracker-server`, `sync:all`). Excel variables sheet seeds month-end only when SBIF is absent.
 * - Optional **`ipc-index.csv`**: semicolon `date;ipc_index` (month-ends) → **`ipc_daily`** (IPC price index level).
 * - AFC: balance from Table 1-3 col 35. **Valuations** allow 0 after a full withdrawal (no stale forward-fill).
 *   **Movements** combine that balance series with `net worth-retiro.csv` col 14 when signs match (retiro amount for
 *   outflows; min(retiro, Δbalance) for inflows). Pure balance deltas are used when retiro disagrees in sign.
 * - Tarjeta de crédito from sheet “flujos - Gasto mensual”: monthly balance col “Saldo tc” (index 8) **unless**
 *   `cc_installment_purchases` already has rows for that account (PDF import ran first): then Saldo tc is skipped and
 *   month-end `valuations` are overwritten from the PDF ledger in the same transaction. **Accounts with a CC ledger
 *   are not removed** on wipe (`DELETE FROM accounts` skips any id referenced by `cc_installment_purchases`) so
 *   `ON DELETE CASCADE` does not drop parsed PDF rows when you re-run `import:excel`. If the ledger is empty but
 *   `cfraser/cc-statements-parsed-all.csv` exists, the importer logs a reminder to run `import:cc-parsed`.
 * - **AFP (UNO Fondo A):** cumulative **depositado** from Table 1-3 col 44 → monthly `movements`, with **10% retiros (2021):**
 *   three dated net lines (CLP + cuotas from the AFP cargo rows). The sheet’s month-on-month `dep_afp` Δ in **2021-03**
 *   and **2021-05** already reflects those outflows on the cumulative series, so that Δ is **reduced by the same CLP**
 *   before insert to avoid duplicating them on the month-end row. Adjust retiro dates in `AFP_UNO_RETIROS_10_PCT` if needed.
 *   Optional **`cfraser/afp-modelo-certificado-cotizaciones.csv`**: AFP **Modelo** “CERTIFICADO COTIZACIONES” from
 *   `npm run afp:modelo:cert-pdf-to-csv` (pre-UNO employer history). When present **and** the UNO cert file exists,
 *   `import:excel` inserts one **`import:excel|afp-modelo-prior-cuotas`** movement with **Σ(Modelo − UNO)** cuotas for
 *   months that match Table 1-3 **dep_afp** CLP deltas (overlap months) plus thin UNO months before **2017-07**.
 *   Optional **`cfraser/afp-modelo-cuotas-supplement.txt`**: one line (e.g. `13,78`) added to the computed gap when the
 *   AFP website total still differs (rounding / older AFP history not on the Modelo PDF).
 *   Optional **`cfraser/afp-uno-website-cuotas.txt`**: one line with official Σ cuotas (default **293.51**); import inserts
 *   **`import:excel|afp-cuotas-website-reconcile`** when ledger Σ differs.
 *   **`cfraser/afp-modelo-antecedentes.csv`** / **`afp-modelo-traspaso.csv`** from `afp:modelo:antecedentes-pdf-to-csv` and
 *   `afp:modelo:traspaso-pdf-to-csv` (logged on import; traspaso Planvital→Modelo is not added to UNO cuotas).
 *   Inserts **`import:excel|afp-orphan-cert-month`** rows for UNO cert periods **before** the first Table 1-3 month
 *   (e.g. 2017-05–06 when Excel `dep_afp` starts at 2017-06).
 *   Optional **`cfraser/afp-uno-certificado-cotizaciones.csv`** (preferred) or **`.txt`**: UNO certificate as
 *   “CERTIFICADO COTIZACIONES”. When present, the import sets **`movements.units_delta`** on each monthly AFP
 *   cumulative row from certificate **cuotas** (movimientos: signed Abono/Cargo net per month). Seeds **`fund_unit_daily`**
 *   from monto/cuotas only for the legacy cotizaciones extract, not for movimientos CSV.
 * - **Reserva / Fintual RN / APV-a / APV-b:** when **`FINTUAL_CERTIFICADO_CSV`** is set to an existing file, or
 *   **`cfraser/fintual-certificado-de-transacciones.csv`** exists, that Fintual “certificado de transacciones” CSV is the
 *   **source of truth** for dated CLP flows and cuotas (`movements` with real calendar days). Table 1-3 cumulative
 *   deltas for those accounts are skipped. **Reserva month-end `valuations`** use the certificate’s latest
 *   **`Saldo Pesos Chilenos Final Día`** per month (so monthly P/L matches Fintual balances, not a divergent Excel cell).
 *   Optional **`server/data/fintual-goal-map.json`** (`byGoalId`, merged with
 *   built-in defaults) augments goal-id
 *   → account mapping. With APV-a in the certificate, pre-Fintual Excel APV-a history is written to **APV régimen A —
 *   principal (pre-Fintual)** (`import:excel|key=apv_a_principal`) and valuations are split at the first certificate month.
 *   On the first Fintual APV-a flow date, a **−CLP movement** on principal (Excel balance at last pre-Fintual month-end)
 *   records the rollover; the matching inflow stays **only** on Fintual APV-a from the certificate (no duplicate +CLP
 *   on `apv_a`). Principal **valuations** are forced to **0** from the cut month onward so MTM charts do not forward-fill.
 * - **Cuenta de ahorro para la vivienda (BancoEstado):** from **`net worth-cash and cash equivalents.csv`**, block
 *   “Cuenta ahorro”: cols **Depósitos**, **Abonos**, **Intereses** → signed `movements` + month-end `valuations` as the
 *   running sum of those flows (`cuenta_ahorro_vivienda`). **Cuenta corriente** month-end CLP is **`net worth - Table 1-2-1`**
 *   col “cuenta corriente” (same as `cfraser/net worth-Table 1-2-1.csv`); valuations use **`put(..., allowNonPositive=true)`**
 *   so **0** (and any negative) persist — otherwise missing rows forward-fill stale balances. Do not use the cash CSV’s
 *   first money column for checking; it is not the same series as Table 1-2-1.
 *
 * Run: `cd server && npm run import:excel`
 * Env: EXCEL_PATH, CFRASER_CSV_DIR (default ../cfraser), IMPORT_MAX_MONTH, FINTUAL_CERTIFICADO_CSV (optional).
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
  type ExcelMovementInsertStmt,
  type MonthKey,
} from "../src/cfraserCsv.js";
import { signedAmountClpForBrokerageFlow } from "../src/brokerageFlowMovement.js";
import { deleteEquityDailyForImportTickers, EQUITY_DAILY_IMPORT_TICKERS, upsertEquityDailySeries } from "../src/brokerageEquityMtm.js";
import {
  cryptoDepositCoinUnitsDelta,
  cryptoWdwCoinUnitsDelta,
  type CryptoLedgerImportState,
} from "../src/cryptoSheetUnits.js";
import { chileCalendarTodayYmd } from "../src/chileDate.js";
import { ufClpBySnapshotDatesAsc } from "../src/fxRates.js";
import { applyCryptoValuationsFromCoinHoldings } from "../src/cryptoValuation.js";
import { db } from "../src/db.js";
import { ccInstallmentLedgerRowCount, upsertCreditCardValuationsFromLedger } from "../src/ccInstallmentLedgerDb.js";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";
import { resolveBundledUfSiiDailyCsvPath } from "../src/ufSiiDailyPath.js";
import {
  enrichDeptoLedgerFromBankFile,
  resolveBankDividendosHistoricosPath,
} from "../src/bankDividendosHistoricos.js";
import {
  buildDeptoDividendosMovementNote,
  buildDeptoMortgageMovementNote,
  DEPTO_SUECIA_ACCOUNT_DISPLAY_NAME,
  deptoMortgageCloseClpBySnapshotDates,
  deptoSueciaPropertyCloseClpBySnapshotDates,
  firstDeptoPropertyOwnershipYmd,
  isDeptoMortgagePaymentCuota,
  loadDeptoDividendosPaymentRows,
  loadDeptoDividendosSheetLedger,
} from "../src/deptoDividendosLedger.js";
import {
  fetchYahooDailyCloses,
  yahooChartPeriodSeconds,
  type EodCloseSeries,
} from "../src/equityYahooEod.js";
import {
  aggregateFintualCertificado,
  insertFintualCertificadoMovementsFromAggregates,
  resolveFintualCertificadoCsvPath,
  type FintualCertificadoAccounts,
} from "../src/fintualCertificadoTransacciones.js";
import { loadGoalIdOverrides, matchGoalToImportNotes } from "./fintualApiLib.js";
import { applyAfpUnoCertificadoCuotasToMovements } from "../src/afpUnoCertMovementSync.js";
import {
  AFP_UNO_WEBSITE_CUOTAS_TARGET,
  buildDepAfpDeltaByMonth,
  computeAfpCuotasWebsiteReconciliationDelta,
  computeModeloVersusUnoPriorCuotasDelta,
  readOptionalAfpModeloCuotasSupplement,
  readOptionalAfpUnoWebsiteCuotasTarget,
  tryReadModeloAntecedentesSnapshot,
  tryReadModeloCotizacionesRows,
} from "../src/afpModeloPriorCuotasBackfill.js";
import { afpCuotasCumulativeThroughDate } from "../src/afpUnoValuation.js";
import {
  computeOrphanUnoCertMonthMovements,
  firstAfpCumulativeMovementMonth,
} from "../src/afpUnoOrphanCertMonths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Default Fintual “certificado” goal id → `import:excel|key=…` (merged with `server/data/fintual-goal-map.json`). */
const DEFAULT_FINTUAL_CERT_GOAL_IDS: Record<string, string> = {
  "2859": "import:excel|key=fintual_rn",
  "16749": "import:excel|key=apv_a",
  "78515": "import:excel|key=apv_b",
  "1164983": "import:excel|key=fondo_reserva",
};

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

/** Ledger “BTC 0,0183” / plain number from xlsx — `num()` fails when a currency prefix precedes the figure. */
function criptoSheetCoinAmount(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) && Math.abs(v) > 0 ? Math.abs(v) : null;
  if (typeof v === "string") {
    const m = v.match(/([0-9][0-9.,]*)/);
    if (!m) return null;
    const t = m[1].replace(/\./g, "").replace(/,/g, ".");
    const n = Number(t);
    return Number.isFinite(n) && n > 0 ? n : null;
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
  dep_fintual?: number | null;
  dep_stocks?: number | null;
  dep_afp?: number | null;
  dep_apv_a?: number | null;
  dep_apv_b?: number | null;
  /** Table 1-3 col 26: cumulative Reserva “depositado” (authoritative net external capital vs cash CSV gross in/out). */
  dep_reserva?: number | null;
};

/** `INSERT INTO movements (… five columns …)` used by `import:excel`. */
type MovStmt = ExcelMovementInsertStmt;

/**
 * Net 10% AFP withdrawals (UNO Fondo A) — one row per retiro from the statement cargo lines (not provisión pairs).
 * Table 1-3 `dep_afp` month-on-month Δ often **already includes** those CLP drops on the month-end row; we subtract
 * the same totals in {@link emitCumulativeDeltasAfpMinusDocumentedRetiros} so only these dated movements carry the retiros.
 */
const AFP_UNO_RETIROS_10_PCT: readonly {
  occurred_on: string;
  amount_clp: number;
  units_delta: number;
  label: string;
}[] = [
    {
      occurred_on: "2021-03-18",
      amount_clp: -1_014_454,
      units_delta: -17.72,
      label: "202103|1er-retiro-10pct|Fondo-A",
    },
    {
      occurred_on: "2021-03-29",
      amount_clp: -1_019_948,
      units_delta: -17.72,
      label: "202103|2do-retiro-10pct|Fondo-A",
    },
    {
      occurred_on: "2021-05-31",
      amount_clp: -1_020_863,
      units_delta: -18.1,
      label: "202105|3er-retiro-10pct|Fondo-A",
    },
  ];

function afpUnoRetiroNetAmountClpByMonth(maxMonth: MonthKey): Map<MonthKey, number> {
  const m = new Map<MonthKey, number>();
  for (const r of AFP_UNO_RETIROS_10_PCT) {
    const mk = r.occurred_on.slice(0, 7) as MonthKey;
    if (mk > maxMonth) continue;
    m.set(mk, (m.get(mk) ?? 0) + r.amount_clp);
  }
  return m;
}

/** Like {@link emitCumulativeDeltas}, but backs out CLP already posted as dated `retiro-10pct` rows in that month. */
function emitCumulativeDeltasAfpMinusDocumentedRetiros(
  months: MonthKey[],
  getCum: (mk: MonthKey) => number | null | undefined,
  ins: MovStmt,
  accountId: number,
  note: string,
  retiroNetAmountClpByMonth: Map<MonthKey, number>,
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
    let delta = c - prev;
    prev = c;
    const retSum = retiroNetAmountClpByMonth.get(mk);
    if (retSum != null) delta -= retSum;
    if (delta === 0 || !Number.isFinite(delta)) continue;
    const day = monthEndDate(mk);
    ins.run(accountId, delta, day, note, null);
  }
}

/**
 * Three net “retiro 10%” lines from AFP Uno Fondo A extract (provisión pairs omitted). Amounts and cuotas match the
 * statement cargo lines; calendar days are placeholders when the extract only shows month-year — edit here if you
 * have exact `occurred_on` from the certificado web extract.
 */
function importAfpUnoDocumentedRetiros10Pct(afpAccountId: number, maxMonth: MonthKey, insMov: MovStmt): number {
  let n = 0;
  for (const r of AFP_UNO_RETIROS_10_PCT) {
    const mk = r.occurred_on.slice(0, 7) as MonthKey;
    if (mk > maxMonth) continue;
    insMov.run(
      afpAccountId,
      r.amount_clp,
      r.occurred_on,
      `import:excel|retiro-10pct|UNO-Fondo-A|${r.label}`,
      r.units_delta
    );
    n += 1;
  }
  if (n > 0) {
    console.log(`import:excel: AFP UNO Fondo A — documented 10% retiros (net CLP + cuotas): ${n} movement(s)`);
  }
  return n;
}

/**
 * AFC Table1-3 + retiro movements default to **month-end**. Override here when the real wire date is known
 * (e.g. from bank or AFP cargo day).
 */
const AFC_FLOW_OCCURRED_ON_BY_MONTH: Partial<Record<MonthKey, string>> = {
  "2026-05": "2026-05-13",
};

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

    const day = AFC_FLOW_OCCURRED_ON_BY_MONTH[mk] ?? monthEndDate(mk);
    insMov.run(afcAccountId, amt, day, note, null);
  }
}

function emitCumulativeDeltas(
  months: MonthKey[],
  getCum: (mk: MonthKey) => number | null | undefined,
  ins: MovStmt,
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
    ins.run(accountId, delta, day, note, null);
  }
}

/**
 * Optional `cfraser/fund-unit-values.csv`: semicolon; header `series_key;day;unit_value_clp;note`.
 * Series keys (examples): `afp_uno_cuota_a`, `fintual_risky_norris`, `fintual_risky_norris_apv`.
 * For AFP Uno Fondo A, you can also load valor cuota via `npm run afp:uno:fetch-cuotas` (short ranges), `npm run afp:uno:backfill-quetalmiafp` (historic → `fund_unit_daily` / rates since 2018), cert sync (`afp:uno:cert-sync`) then `afp:uno:apply-valuation`; for same-day cuota when Quetalmi lags, `afp:uno:fetch-cuota-website` / `afp:uno:spot-from-website`.
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
 * `uf-sii-daily.csv` from `fetch-sii-uf-daily` uses dot as decimal (`40133.5`). {@link numCsv} is for Chilean
 * Numbers exports (`36.000,23`) and would misread dot-decimal as thousands (e.g. `40133.5` → `401335`).
 */
function clpPerUfFromUfDailyCell(raw: unknown): number | null {
  const dot = numUsdDotDecimal(raw);
  if (dot != null && dot >= 1000 && dot < 1e6) return dot;
  const chilean = numCsv(raw);
  if (chilean != null && chilean >= 1000 && chilean < 1e6) return chilean;
  return null;
}

/** Semicolon `date;clp_per_uf` (CLP per 1 UF). Official SII series via `fetch-sii-uf-daily` → `server/data/uf-sii-daily.csv`. */
function importUfDailyCsvFile(csvPath: string, upsertUf: ReturnType<typeof db.prepare>): number {
  if (!fs.existsSync(csvPath)) return 0;
  const rows = readSemicolonCsv(csvPath);
  if (rows.length < 2) return 0;
  const h0 = rows[0]!.map((c) => String(c ?? "").trim().toLowerCase().replace(/^\ufeff/, ""));
  const col = (name: string) => h0.indexOf(name);
  const id = col("date");
  const iu = col("clp_per_uf");
  if (id < 0 || iu < 0) {
    console.warn(`import:excel: UF CSV needs headers date;clp_per_uf (${csvPath})`);
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
  if (n > 0) console.log(`import:excel: uf_daily rows from ${path.basename(csvPath)}: ${n}`);
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
    `INSERT INTO movements (account_id, occurred_on, flow_kind, amount_clp, amount_usd, ticker, note, units_delta)
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
      ins.run(
        spyId,
        spyDepositDay,
        signedAmountClpForBrokerageFlow("deposit_clp", dep, null),
        "SPY",
        "import:excel|net worth-stocks.csv|depositado"
      );
      n += 1;
    } else if (key === "vea") {
      ins.run(
        veaId,
        veaDepositDay,
        signedAmountClpForBrokerageFlow("deposit_clp", dep, null),
        "VEA",
        "import:excel|net worth-stocks.csv|depositado"
      );
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
      `SELECT 1 FROM movements
       WHERE account_id = ?
         AND flow_kind IN ('compra_usd', 'dividend_usd')
         AND COALESCE(units_delta, 0) != 0
       LIMIT 1`
    )
    .get(accountId) as { 1: number } | undefined;
  return r != null;
}

/** Replace SPY/VEA `flow_kind` rows before re-importing `stocks-lots.csv` (avoids 039-style duplicates). */
function deleteSpyVeaBrokerageMovements(spyId: number, veaId: number): number {
  const r = db
    .prepare(`DELETE FROM movements WHERE account_id IN (?, ?) AND flow_kind IS NOT NULL`)
    .run(spyId, veaId);
  return r.changes;
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
    `INSERT INTO movements (account_id, occurred_on, flow_kind, amount_clp, amount_usd, ticker, note, units_delta)
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
    ins.run(
      accountId,
      occurredOn,
      flowKind,
      signedAmountClpForBrokerageFlow(flowKind, aclp, ausd),
      ausd,
      ticker || null,
      note,
      unitsDelta
    );
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
/** Mortgage (pasivo): one movement per dividendos payment — positive CLP (capital pagado al crédito). */
function importDeptoDividendosMortgagePayments(
  ledger: ReturnType<typeof loadDeptoDividendosSheetLedger>,
  maxMonth: MonthKey,
  mortgageId: number,
  insMov: MovStmt
): number {
  if (ledger.length === 0) return 0;
  const rows = ledger.map((s) => ({
    cuota: s.cuota,
    occurred_on: s.occurred_on,
    amount_clp: s.pago_clp,
    amount_uf: s.pago_uf,
    uf_clp_day: s.uf_clp_day,
    credito_restante_uf: s.credito_restante_uf,
    valor_neto_uf: s.valor_neto_uf,
    valor_neto_clp: s.valor_neto_clp,
    pagado_neto_uf: s.pagado_neto_uf,
    pago_acumulado_clp: s.pago_acumulado_clp,
    min_uf: s.min_uf,
    amortizacion_clp: s.amortizacion_clp,
    amortizacion_uf: s.amortizacion_uf,
    amortizacion_ext_clp: s.amortizacion_ext_clp,
    amortizacion_ext_uf: s.amortizacion_ext_uf,
    interes_clp: s.interes_clp,
    interes_uf: s.interes_uf,
    incendio_clp: s.incendio_clp,
    desgravamen_clp: s.desgravamen_clp,
  }));
  const sorted = [...rows].sort((a, b) => {
    const c = a.occurred_on.localeCompare(b.occurred_on);
    return c !== 0 ? c : a.cuota.localeCompare(b.cuota);
  });
  let n = 0;
  for (const r of sorted) {
    if (!isDeptoMortgagePaymentCuota(r.cuota)) continue;
    const mk = r.occurred_on.slice(0, 7) as MonthKey;
    if (mk > maxMonth) continue;
    insMov.run(
      mortgageId,
      Math.abs(r.amount_clp),
      r.occurred_on,
      buildDeptoMortgageMovementNote(r),
      null
    );
    n += 1;
  }
  console.log(`import:excel: depto-dividendos → ${n} mortgage payment movements`);
  return n;
}

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
    insMov.run(propertyId, r.amount_clp, r.occurred_on, buildDeptoDividendosMovementNote(r), null);
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

/** Ledger rows: [0]=month, [1]=dep CLP, [2–3]=coin/rate, [4]=withdraw CLP, [5–6]=coin out (col 6 when CLP missing). */
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
    coinB: unknown | undefined,
    unitsDelta: number | null,
    coinOnlyWdw: boolean
  ) => {
    if (coinOnlyWdw) {
      if (!Number.isFinite(signedClp) || signedClp >= 0) return;
    } else {
      if (!Number.isFinite(signedClp) || signedClp === 0) return;
    }
    const a = criptoSheetCoinAmount(coinA);
    const b = coinB !== undefined ? num(coinB) : null;
    const note = [
      `import:excel|cripto-sheet|${asset}|${leg}`,
      coinOnlyWdw ? `cripto-coin-only-wdw` : null,
      a != null ? `coin=${a}` : null,
      b != null ? `x=${b}` : null,
    ]
      .filter(Boolean)
      .join("|");
    insMov.run(accountId, signedClp, day, note, unitsDelta);
    inserted += 1;
  };

  const walk = (sheetLabel: string | undefined, accountId: number, asset: "BTC" | "ETH") => {
    const ledgerState: CryptoLedgerImportState = { depCum: 0, held: 0, wdwCum: 0 };
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
      const depCoin = criptoSheetCoinAmount(row[2]);
      if (dep != null && dep !== 0 && depCoin != null && depCoin > 0) {
        const ud = cryptoDepositCoinUnitsDelta(depCoin, ledgerState);
        emit(accountId, dep, day, asset, "dep", row[2], row[3], ud, false);
      }
      const wdwClp = num(row[4]);
      const wdwCoin = criptoSheetCoinAmount(row[5]) ?? criptoSheetCoinAmount(row[6]);
      if (wdwCoin != null && wdwCoin > 0) {
        const ud = cryptoWdwCoinUnitsDelta(wdwCoin, ledgerState);
        if (wdwClp != null && wdwClp !== 0) {
          emit(accountId, -Math.abs(wdwClp), day, asset, "wdw", row[5] ?? row[6], undefined, ud, false);
        } else {
          emit(accountId, -1, day, asset, "wdw", row[5] ?? row[6], undefined, ud, true);
        }
      }
    }
  };

  const btcSheet = wb.SheetNames.find((s) => /cripto/i.test(s) && /bitcoin/i.test(s));
  const ethSheet = wb.SheetNames.find((s) => /cripto/i.test(s) && /ether/i.test(s));
  walk(btcSheet, btcId, "BTC");
  walk(ethSheet, ethId, "ETH");
  return inserted;
}

/** Month rows in `net worth-cash and cash equivalents.csv` (skip header + footer summary rows). */
function walkCashCsvMonthRows(
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

/**
 * Reserva-only flows from the cash CSV (cols 7–8 when present). Checking-account movements are **not** taken from
 * this file (see `net worth - Table 1-2-1` for `cuenta_corriente` valuations).
 */
function importCashCsvMovements(
  cfraserDir: string,
  maxMonth: MonthKey,
  reservaId: number | null,
  insMov: MovStmt
) {
  walkCashCsvMonthRows(cfraserDir, maxMonth, (row, mk, day) => {
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
  });
}

/** “Cuenta ahorro” cols 3–5: Depósitos, Abonos, Intereses → movements + cumulative month-end valuations. */
function importCashCsvAhorroVivienda(
  cfraserDir: string,
  maxMonth: MonthKey,
  ahorroAccountId: number,
  insMov: MovStmt,
  upsertVal: ReturnType<typeof db.prepare>
) {
  let movN = 0;
  let cum = 0;
  walkCashCsvMonthRows(cfraserDir, maxMonth, (row, _mk, day) => {
    const dep = numCsv(row[3]);
    const abo = numCsv(row[4]);
    const int = numCsv(row[5]);
    const tryEmit = (amt: number | null, tag: string) => {
      if (amt == null || !Number.isFinite(amt) || amt === 0) return;
      emitSignedMonthlyMovement(
        insMov,
        ahorroAccountId,
        amt,
        day,
        `import:excel|csv|cash|ahorro-vivienda|${tag}`
      );
      movN += 1;
    };
    tryEmit(dep, "Depósitos");
    tryEmit(abo, "Abonos");
    tryEmit(int, "Intereses");
    cum += (dep ?? 0) + (abo ?? 0) + (int ?? 0);
    if (Number.isFinite(cum)) {
      upsertVal.run({ account_id: ahorroAccountId, as_of_date: day, value_clp: cum });
    }
  });
  if (movN > 0) {
    console.log(`import:excel: cuenta ahorro vivienda (BancoEstado): ${movN} movements, valuations = cumsum of cols 3–5`);
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
      DELETE FROM accounts
      WHERE (notes LIKE 'import:excel%' OR notes LIKE 'import:cfraser%')
        AND NOT EXISTS (
          SELECT 1 FROM cc_installment_purchases p WHERE p.account_id = accounts.id
        );
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
    "INSERT INTO accounts (category_id, name, notes, exclude_from_group_totals) VALUES (?, ?, ?, ?)"
  );

  const updAccName = db.prepare("UPDATE accounts SET name = ? WHERE id = ?");

  function excludeFromGroupTotalsForCategory(categorySlug: string): number {
    return categorySlug === "cuenta_corriente" ? 1 : 0;
  }

  function ensureAccount(slug: string, name: string, key: string): number {
    const note = `import:excel|key=${key}`;
    const exclude = excludeFromGroupTotalsForCategory(slug);
    const row = db.prepare("SELECT id FROM accounts WHERE notes = ?").get(note) as { id: number } | undefined;
    if (row) {
      updAccName.run(name, row.id);
      db.prepare("UPDATE accounts SET exclude_from_group_totals = ? WHERE id = ?").run(exclude, row.id);
      return row.id;
    }
    const r = insAcc.run(catId(slug), name, note, exclude);
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
    cuenta_ahorro_vivienda: ensureAccount(
      "cuenta_ahorro_vivienda",
      "Cuenta de ahorro para la vivienda — BancoEstado",
      "cuenta_ahorro_vivienda"
    ),
    bitcoin: ensureAccount("bitcoin", "Bitcoin", "bitcoin"),
    eth: ensureAccount("eth", "Ether", "eth"),
    property: ensureAccount("property", DEPTO_SUECIA_ACCOUNT_DISPLAY_NAME, "property"),
    mortgage: ensureAccount("mortgage", DEPTO_SUECIA_ACCOUNT_DISPLAY_NAME, "mortgage"),
    spy: ensureAccount("spy", "SPY", "spy"),
    vea: ensureAccount("vea", "VEA", "vea"),
    credit_card: ensureAccount("credit_card", "santander - worldmember", "credit_card"),
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
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta) VALUES (?,?,?,?,?)`
  ) as MovStmt;

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
    const patch: Partial<Bucket> = { fx: rate };
    if (eurVal != null && eurVal > 50 && eurVal < 50000) patch.eur = eurVal;
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

  const fintualCertCsvPath = resolveFintualCertificadoCsvPath(cfraserDir);
  const useFintualCertificado = Boolean(fintualCertCsvPath);
  const fintualCertGoalMap: Record<string, string> = {
    ...DEFAULT_FINTUAL_CERT_GOAL_IDS,
    ...loadGoalIdOverrides(),
  };
  const matchFintualCertGoal = (goalId: string, name: string) =>
    matchGoalToImportNotes(goalId, name, fintualCertGoalMap);
  const fintualCertScan =
    useFintualCertificado && fintualCertCsvPath
      ? aggregateFintualCertificado(fintualCertCsvPath, maxMonth, matchFintualCertGoal)
      : null;
  const fintualApvACutMk = fintualCertScan?.apvACutMonth ?? null;
  const apv_a_principal =
    useFintualCertificado && fintualApvACutMk
      ? ensureAccount("apv", "APV régimen A — principal (pre-Fintual)", "apv_a_principal")
      : undefined;

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
    const ccFromPdf = ccInstallmentLedgerRowCount(accounts.credit_card) > 0;

    const stocksLotsPath = path.join(cfraserDir, "stocks-lots.csv");
    const clearedBrokerageMov = deleteSpyVeaBrokerageMovements(accounts.spy, accounts.vea);
    if (clearedBrokerageMov > 0) {
      console.log(
        `import:excel: cleared ${clearedBrokerageMov} existing SPY/VEA flow_kind movement(s) before re-import`
      );
    }
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
        `import:excel: stocks-lots.csv → ${stocksLotsN} equity movements (SPY/VEA); skipping 50/50 dep_stocks movements`
      );
    }

    if (!useFintualCertificado) {
      importBrokerageCsvMovements(cfraserDir, maxMonth, { fintual_rn: accounts.fintual_rn }, insMov);
    }

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

    const todayChile = chileCalendarTodayYmd();
    const curMk = todayChile.slice(0, 7) as MonthKey;

    const deptoLedger = loadDeptoDividendosSheetLedger(cfraserDir);
    const bankPath = resolveBankDividendosHistoricosPath();
    const bankEnriched = enrichDeptoLedgerFromBankFile(deptoLedger, bankPath);
    if (bankEnriched > 0) {
      console.log(
        `import:excel: depto-dividendos enriched from bank xlsx (${bankEnriched} rows, ${bankPath})`
      );
    } else if (bankPath) {
      console.warn(`import:excel: bank dividendos xlsx found but no rows matched: ${bankPath}`);
    } else {
      console.warn(
        "import:excel: no bank dividendos xlsx (set BANK_DIVIDENDOS_XLSX or copy to cfraser/dividendos-historicos-banco.xlsx)"
      );
    }
    const mortgageAsOfDates = [...byMonth.keys()]
      .sort()
      .map((mk) => {
        const monthEnd = monthEndDate(mk);
        return mk === curMk && monthEnd > todayChile ? todayChile : monthEnd;
      });
    const mortgageUfClpByAsOf =
      mortgageAsOfDates.length > 0 ? ufClpBySnapshotDatesAsc(mortgageAsOfDates) : new Map<string, number>();
    const mortgageCloseByAsOf =
      deptoLedger.length > 0
        ? deptoMortgageCloseClpBySnapshotDates(mortgageAsOfDates, deptoLedger, mortgageUfClpByAsOf)
        : new Map<string, number>();
    const propertyCloseByAsOf =
      deptoLedger.length > 0
        ? deptoSueciaPropertyCloseClpBySnapshotDates(mortgageAsOfDates, deptoLedger, mortgageUfClpByAsOf)
        : new Map<string, number>();
    const propertyFirstOwnYmd =
      deptoLedger.length > 0 ? firstDeptoPropertyOwnershipYmd(deptoLedger) : null;
    if (propertyFirstOwnYmd) {
      const delPrePurchase = db.prepare(
        `DELETE FROM valuations WHERE account_id = ? AND as_of_date < ?`
      );
      delPrePurchase.run(accounts.property, propertyFirstOwnYmd);
      delPrePurchase.run(accounts.mortgage, propertyFirstOwnYmd);
    }

    for (const [mk, b] of [...byMonth.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const monthEnd = monthEndDate(mk);
      const asOf = mk === curMk && monthEnd > todayChile ? todayChile : monthEnd;
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
      const reservaValFromCert =
        useFintualCertificado && fintualCertScan != null
          ? fintualCertScan.reservaSaldoClpByMonthKey.get(mk)
          : undefined;
      if (reservaValFromCert != null && Number.isFinite(reservaValFromCert) && reservaValFromCert > 0) {
        put(accounts.fondo_reserva, reservaValFromCert);
      } else {
        put(accounts.fondo_reserva, b.reserva);
      }
      put(accounts.afp, b.afp);
      if (useFintualCertificado && fintualApvACutMk != null && apv_a_principal != null) {
        if (mk < fintualApvACutMk) put(apv_a_principal, b.apv_a);
        if (mk >= fintualApvACutMk) {
          put(accounts.apv_a, b.apv_a);
          // Principal was closed at transfer; explicit zeros so charts do not forward-fill the pre-Fintual balance.
          put(apv_a_principal, 0, true);
        }
      } else {
        put(accounts.apv_a, b.apv_a);
      }
      put(accounts.apv_b, b.apv_b);
      // AFC can go to 0 after a full withdrawal; must persist 0 or valuations forward-fill stale balances.
      put(accounts.afc, b.afc, true);
      // Cuenta corriente is often 0 for stretches; must persist 0 (Table 1-2-1 / Numbers `net worth-Table 1-2-1.csv`).
      put(accounts.cuenta_corriente, b.cuenta, true);
      // Table 1-2 legs can be negative while total stays positive; still store for correct crypto_total sum.
      put(accounts.bitcoin, b.btc, true);
      put(accounts.eth, b.eth, true);
      if (propertyFirstOwnYmd == null || asOf >= propertyFirstOwnYmd) {
        const propertyFromDepto = propertyCloseByAsOf.get(asOf);
        if (propertyFromDepto != null && Number.isFinite(propertyFromDepto)) {
          put(accounts.property, propertyFromDepto, true);
        } else if (propertyFirstOwnYmd == null) {
          put(accounts.property, b.property);
        }
      }
      if (propertyFirstOwnYmd == null || asOf >= propertyFirstOwnYmd) {
        const mortgageFromDepto = mortgageCloseByAsOf.get(asOf);
        if (mortgageFromDepto != null && Number.isFinite(mortgageFromDepto)) {
          put(accounts.mortgage, mortgageFromDepto, true);
        } else if (b.liabilities != null && Number.isFinite(b.liabilities)) {
          console.warn(
            `import:excel: mortgage ${mk}: no depto-dividendos close for ${asOf}; skipping resumen liabilities (${b.liabilities})`
          );
        }
      }

      if (b.fx != null && b.fx > 50 && b.fx < 50000) {
        upsertFx.run({ date: monthEndDate(mk), clp_per_usd: b.fx });
      }
      if (b.eur != null && b.eur > 50 && b.eur < 50000) {
        upsertEur.run({ date: monthEndDate(mk), clp_per_eur: b.eur });
      }
    }

    const ufCsv = resolveBundledUfSiiDailyCsvPath();
    const nBundledUf = importUfDailyCsvFile(ufCsv, upsertUf);
    if (nBundledUf === 0) {
      console.error(
        `import:excel: no UF rows loaded from ${ufCsv}. Run: npm run fetch-uf -w nw-tracker-server`
      );
      process.exit(1);
    }

    if (deptoLedger.length > 0 && mortgageAsOfDates.length > 0) {
      const ufClpAfterImport = ufClpBySnapshotDatesAsc(mortgageAsOfDates);
      const propertyCloseFinal = deptoSueciaPropertyCloseClpBySnapshotDates(
        mortgageAsOfDates,
        deptoLedger,
        ufClpAfterImport
      );
      const mortgageCloseFinal = deptoMortgageCloseClpBySnapshotDates(
        mortgageAsOfDates,
        deptoLedger,
        ufClpAfterImport
      );
      for (const asOf of mortgageAsOfDates) {
        if (propertyFirstOwnYmd != null && asOf < propertyFirstOwnYmd) continue;
        const pc = propertyCloseFinal.get(asOf);
        if (pc != null && Number.isFinite(pc)) {
          upsertVal.run({ account_id: accounts.property, as_of_date: asOf, value_clp: pc });
        }
        if (propertyFirstOwnYmd == null || asOf >= propertyFirstOwnYmd) {
          const mc = mortgageCloseFinal.get(asOf);
          if (mc != null && Number.isFinite(mc)) {
            upsertVal.run({ account_id: accounts.mortgage, as_of_date: asOf, value_clp: mc });
          }
        }
      }
    }

    mergeEurFromVariablesCsv(cfraserDir, maxMonth, upsertEur);
    importFundUnitDailyCsv(cfraserDir);
    importIpcDailyCsv(cfraserDir);

    const afpRetiroNetByMonth = afpUnoRetiroNetAmountClpByMonth(maxMonth);
    emitCumulativeDeltasAfpMinusDocumentedRetiros(
      monthsSorted,
      (mk) => byMonth.get(mk)?.dep_afp,
      insMov,
      accounts.afp,
      "import:excel|cumulative-depositado|Table1-3|AFP",
      afpRetiroNetByMonth
    );
    importAfpUnoDocumentedRetiros10Pct(accounts.afp, maxMonth, insMov);
    const afpCertCsv = path.join(cfraserDir, "afp-uno-certificado-cotizaciones.csv");
    const afpCertTxt = path.join(cfraserDir, "afp-uno-certificado-cotizaciones.txt");
    const afpCertPath = fs.existsSync(afpCertCsv) ? afpCertCsv : afpCertTxt;
    if (fs.existsSync(afpCertPath)) {
      const certAbs = path.resolve(afpCertPath);
      const certBody = fs.readFileSync(afpCertPath, "utf8").replace(/^\uFEFF/, "").trim();
      if (certBody) {
        const certR = applyAfpUnoCertificadoCuotasToMovements({
          accountId: accounts.afp,
          certText: certBody,
          certSourceFileName: path.basename(afpCertPath),
          dryRun: false,
          seedFundUnitDaily: true,
        });
        console.log(
          `import:excel: AFP UNO cert (${path.basename(afpCertPath)}): path=${certAbs} matched=${certR.matched} warnings=${certR.warned} fund_unit_daily_seeded=${certR.fundUnitSeeded}`
        );
        if (certR.matched === 0) {
          const nAfp = db
            .prepare(
              `SELECT COUNT(*) AS c FROM movements WHERE account_id = ? AND note LIKE '%Table1-3|AFP%'`
            )
            .get(accounts.afp) as { c: number };
          if (nAfp.c > 0) {
            console.error(
              `import:excel: AFP UNO cert sync matched 0 rows but ${nAfp.c} cumulative AFP movement(s) exist — cuotas stay empty. ` +
              `Confirm the movimientos CSV is at ${certAbs} (cfraser dir ${path.resolve(cfraserDir)}), ` +
              `or run: npm run afp:uno:cert-sync -w nw-tracker-server -- --account-id=${accounts.afp} --csv=... --dry-run`
            );
          }
        }
        const afpMovs = db
          .prepare(
            `SELECT occurred_on, note, COALESCE(units_delta, 0) AS units_delta FROM movements WHERE account_id = ? AND note LIKE '%Table1-3|AFP%'`
          )
          .all(accounts.afp) as { occurred_on: string; note: string | null; units_delta: number }[];
        const existingMk = new Set(
          afpMovs.map((m) => m.occurred_on.slice(0, 7) as MonthKey)
        );
        const table1UnitsByMonth = new Map<MonthKey, number>();
        for (const m of afpMovs) {
          const mk = m.occurred_on.slice(0, 7) as MonthKey;
          table1UnitsByMonth.set(mk, (table1UnitsByMonth.get(mk) ?? 0) + m.units_delta);
        }
        const firstCumMk = firstAfpCumulativeMovementMonth(afpMovs);
        const modeloRows = tryReadModeloCotizacionesRows(cfraserDir);
        const orphans = computeOrphanUnoCertMonthMovements({
          unoCertText: certBody,
          unoCertSourceFileName: path.basename(afpCertPath),
          modeloRows,
          firstCumulativeMk: firstCumMk,
          existingMovementMonths: existingMk,
          table1UnitsByMonth,
          asOfYmd: chileCalendarTodayYmd(),
        });
        for (const o of orphans) {
          insMov.run(accounts.afp, o.amountClp, o.occurredOn, o.note, o.unitsDelta);
        }
        if (orphans.length > 0) {
          console.log(
            `import:excel: AFP orphan cert month(s): ${orphans.length} (${orphans.map((x) => x.periodYm).join(", ")}) Σcuotas=${orphans.reduce((s, x) => s + x.unitsDelta, 0).toFixed(2)}`
          );
        }
        const antecedentes = tryReadModeloAntecedentesSnapshot(cfraserDir);
        if (antecedentes) {
          console.log(
            `import:excel: AFP Modelo antecedentes: ${antecedentes.cuotas} cuotas @ ${antecedentes.valorCuotaDayDdMmYyyy ?? "—"} (ingreso sistema ${antecedentes.fechaIngresoSistemaDdMmYyyy ?? "—"}; Planvital→Modelo traspaso is separate from UNO ledger)`
          );
        }
        if (modeloRows.length > 0) {
          const depDeltas = buildDepAfpDeltaByMonth(monthsSorted, (mk) => byMonth.get(mk));
          const prior = computeModeloVersusUnoPriorCuotasDelta({
            modeloRows,
            unoCertText: certBody,
            unoCertSourceFileName: path.basename(afpCertPath),
            depAfpDeltaByMk: depDeltas,
          });
          const supplement = readOptionalAfpModeloCuotasSupplement(cfraserDir);
          const finalDelta = Math.round((prior.delta + supplement) * 100) / 100;
          if (finalDelta > 1e-4) {
            const adjDay = monthEndDate("2017-06");
            insMov.run(
              accounts.afp,
              1,
              adjDay,
              `import:excel|afp-modelo-prior-cuotas|delta=${finalDelta}|computed=${prior.delta}|supplement=${supplement}|modelo_rows=${modeloRows.length}|amount_clp_placeholder=1`,
              finalDelta
            );
            console.log(
              `import:excel: AFP Modelo prior cuotas: +${finalDelta} cuotas on ${adjDay} (computed=${prior.delta}` +
              (supplement > 0 ? ` + supplement=${supplement}` : "") +
              `; ${prior.lines.length} month line(s))`
            );
            const maxLog = 36;
            for (let i = 0; i < Math.min(maxLog, prior.lines.length); i++) {
              console.log(`  ${prior.lines[i]}`);
            }
            if (prior.lines.length > maxLog) {
              console.log(`  … ${prior.lines.length - maxLog} more`);
            }
          } else {
            console.log(
              `import:excel: AFP Modelo CSV (${modeloRows.length} row(s)) — prior cuotas gap ≤0; no adjustment` +
              (supplement > 0 ? ` (supplement ${supplement} ignored: computed 0)` : "")
            );
          }
        }
        const reconDay = monthEndDate("2017-06");
        const cuotasTarget =
          readOptionalAfpUnoWebsiteCuotasTarget(cfraserDir) ?? AFP_UNO_WEBSITE_CUOTAS_TARGET;
        const cuotasSum = afpCuotasCumulativeThroughDate(accounts.afp, reconDay);
        const reconDelta = computeAfpCuotasWebsiteReconciliationDelta(cuotasSum, cuotasTarget);
        if (reconDelta != null) {
          insMov.run(
            accounts.afp,
            1,
            reconDay,
            `import:excel|afp-cuotas-website-reconcile|delta=${reconDelta}|target=${cuotasTarget}|sum_before=${cuotasSum}|amount_clp_placeholder=1`,
            reconDelta
          );
          console.log(
            `import:excel: AFP cuotas website reconcile: ${reconDelta >= 0 ? "+" : ""}${reconDelta} on ${reconDay} (Σ ${cuotasSum.toFixed(2)} → ${cuotasTarget})`
          );
        } else {
          console.log(
            `import:excel: AFP cuotas already match website target (${cuotasSum.toFixed(2)} ≈ ${cuotasTarget})`
          );
        }
      } else {
        console.warn(`import:excel: ${certAbs} is empty; skipping AFP cert cuotas sync.`);
      }
    }
    if (useFintualCertificado && fintualApvACutMk != null && apv_a_principal != null) {
      emitCumulativeDeltas(
        monthsSorted.filter((mk) => mk < fintualApvACutMk),
        (mk) => byMonth.get(mk)?.dep_apv_a,
        insMov,
        apv_a_principal,
        "import:excel|cumulative-depositado|Table1-3|APV-a|pre-fintual-principal"
      );
    }
    if (!useFintualCertificado || fintualApvACutMk == null) {
      emitCumulativeDeltas(
        monthsSorted,
        (mk) => byMonth.get(mk)?.dep_apv_a,
        insMov,
        accounts.apv_a,
        "import:excel|cumulative-depositado|Table1-3|APV-a"
      );
    }
    if (!useFintualCertificado) {
      emitCumulativeDeltas(
        monthsSorted,
        (mk) => byMonth.get(mk)?.dep_apv_b,
        insMov,
        accounts.apv_b,
        "import:excel|cumulative-depositado|Table1-3|APV-b"
      );
    }

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
    if (!useFintualCertificado) {
      emitCumulativeDeltas(
        monthsSorted,
        (mk) => byMonth.get(mk)?.dep_reserva,
        insMov,
        accounts.fondo_reserva,
        "import:excel|cumulative-depositado|Table1-3|Reserva"
      );
    }

    let fintualCertMovementRows = 0;
    if (useFintualCertificado && fintualCertCsvPath != null && fintualCertScan != null) {
      const certAcc: FintualCertificadoAccounts = {
        fondo_reserva: accounts.fondo_reserva,
        fintual_rn: accounts.fintual_rn,
        apv_a: accounts.apv_a,
        apv_b: accounts.apv_b,
      };
      fintualCertMovementRows = insertFintualCertificadoMovementsFromAggregates(
        fintualCertScan,
        certAcc,
        insMov,
        matchFintualCertGoal
      );

      if (
        fintualApvACutMk &&
        apv_a_principal != null &&
        fintualCertScan.apvAFirstFlowYmd &&
        monthsSorted.length > 0
      ) {
        const before = monthsSorted.filter((m) => m < fintualApvACutMk);
        const prevMk = before.length ? before[before.length - 1]! : null;
        const T = prevMk != null ? byMonth.get(prevMk)?.apv_a : null;
        if (T != null && Number.isFinite(T) && T > 0) {
          emitSignedMonthlyMovement(
            insMov,
            apv_a_principal,
            -T,
            fintualCertScan.apvAFirstFlowYmd,
            "import:excel|transfer|pre-fintual-apv-a|to-fintual|balance-clp"
          );
        }
      }
    }

    importDeptoDividendosPropertyPayments(cfraserDir, maxMonth, accounts.property, insMov);
    importDeptoDividendosMortgagePayments(deptoLedger, maxMonth, accounts.mortgage, insMov);
    const cryptoMovN = importCriptoLedgerSheets(wb, maxMonth, accounts.bitcoin, accounts.eth, insMov);
    importCashCsvMovements(cfraserDir, maxMonth, null, insMov);
    importCashCsvAhorroVivienda(cfraserDir, maxMonth, accounts.cuenta_ahorro_vivienda, insMov, upsertVal);

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
      const monthEnd = monthEndDate(mk);
      const day = mk === curMk && monthEnd > todayChile ? todayChile : monthEnd;
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
      if (saldoTc != null && Number.isFinite(saldoTc) && !ccFromPdf) {
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
          "import:excel|flujos|Gasto mensual|Crédito (cuota TC)",
          null
        );
        tcPayN += 1;
      }
    }

    let tcPdfSyncN = 0;
    if (ccFromPdf) {
      tcPdfSyncN = upsertCreditCardValuationsFromLedger(accounts.credit_card);
      valCount += tcPdfSyncN;
    }

    movCount = (db.prepare("SELECT COUNT(*) AS c FROM movements WHERE note LIKE 'import:excel%'").get() as {
      c: number;
    }).c;

    console.log(`import:excel valuations upserted: ${valCount}`);
    console.log(`import:excel movements inserted: ${movCount} (crypto ledger rows: ${cryptoMovN})`);

    const cryptoVal = applyCryptoValuationsFromCoinHoldings({
      btcAccountId: accounts.bitcoin,
      ethAccountId: accounts.eth,
      dryRun: false,
    });
    console.log(
      `import:excel: crypto MTM valuations (units × BTC-USD/ETH-USD × FX): BTC ${cryptoVal.btcRows} rows (units recalc ${cryptoVal.btcUnitsBackfill}), ETH ${cryptoVal.ethRows} rows (units recalc ${cryptoVal.ethUnitsBackfill})`
    );
    if (useFintualCertificado && fintualCertMovementRows > 0) {
      console.log(
        `import:excel: Fintual certificado de transacciones → ${fintualCertMovementRows} dated movements (${fintualCertCsvPath}); APV-a split at month: ${fintualApvACutMk ?? "—"}`
      );
    }
    console.log(
      `import:excel income rows: ${incomeN}, expense rows: ${expenseN}; TC valuations (Saldo tc): ${tcValN}, TC payments (Crédito): ${tcPayN}` +
      (tcPdfSyncN > 0 ? `; TC valuations from PDF ledger (existing import): ${tcPdfSyncN} month-ends` : "")
    );
  });
  tx();

  try {
    const { refreshAfpUnoFundUnitFromUnoWebsite } = await import("../src/afpUnoValuation.js");
    const spot = await refreshAfpUnoFundUnitFromUnoWebsite({ signal: AbortSignal.timeout(25_000) });
    if (spot) {
      console.log(
        `import:excel: AFP UNO spot valor cuota (uno.cl): ${spot.unit_value_clp} CLP (day=${spot.day})`
      );
    }
  } catch (e) {
    console.warn(
      `import:excel: AFP UNO uno.cl spot refresh skipped: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const ccAcc = db
    .prepare(`SELECT id FROM accounts WHERE notes = ?`)
    .get("import:excel|key=credit_card") as { id: number } | undefined;
  const ccCsv = path.join(resolveCfraserCsvDir(), "cc-statements-parsed-all.csv");
  if (ccAcc && ccInstallmentLedgerRowCount(ccAcc.id) === 0 && fs.existsSync(ccCsv)) {
    console.warn(
      `import:excel: Tarjeta de crédito (account_id=${ccAcc.id}) has no PDF installment ledger in DB, but ${ccCsv} exists. ` +
      `Run: npm run import:cc-parsed -w nw-tracker-server -- --account-id=${ccAcc.id}`
    );
  }

  console.log(`Done. Source: ${excelPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
