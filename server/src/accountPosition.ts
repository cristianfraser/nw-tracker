import fs from "node:fs";
import path from "node:path";
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { AFP_UNO_CUOTA_SERIES_KEY } from "./afpQuetalmiApi.js";
import {
  afpCuotasCumulativeThroughDate,
  latestAfpUnoFundUnitRowOnOrBeforeForDisplay,
  latestFundUnitRowOnOrBefore,
} from "./afpUnoValuation.js";
import {
  computeCryptoMtmClp,
  cryptoCoinCumulativeThroughDate,
  cryptoEquityTickerForCategorySlug,
  type CryptoAsset,
} from "./cryptoValuation.js";
import { fxRowOnOrBefore } from "./fxRates.js";
import { numCsv } from "./deptoDividendosLedger.js";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";

/** Same resolution as mortgage API and `import-excel-history.ts`. */
export function cfraserCsvDir(): string {
  return resolveCfraserCsvDir();
}

/**
 * Numbers-exported “valor acción” cell: comma as decimal separator (`1,027327209`).
 * (Do not use Chilean thousands-with-dots here; that column is a plain fraction.)
 */
function parseStocksSheetShareCell(raw: string): number | null {
  const s = raw.replace(/[^\d,]/g, "").trim();
  if (!s) return null;
  const parts = s.split(",");
  if (parts.length === 2) {
    const n = Number(`${parts[0]}.${parts[1]}`);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(s.replace(/\./g, ""));
  return Number.isFinite(n) ? n : null;
}

export function readSpyVeaShareUnitsFromStocksCsv(slug: "spy" | "vea"): number | null {
  const fp = path.join(cfraserCsvDir(), "net worth-stocks.csv");
  if (!fs.existsSync(fp)) return null;
  const lines = fs.readFileSync(fp, "utf8").split(/\r?\n/);
  // Row 0 = header (`;goal;current;…`); row 1 = first ticker (`spy`, `vea`, …).
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(";");
    const key = String(cols[0] ?? "")
      .trim()
      .replace(/^\ufeff/, "")
      .toLowerCase();
    if (key !== slug) continue;
    const raw = cols[5];
    if (!raw?.trim()) return null;
    return parseStocksSheetShareCell(raw);
  }
  return null;
}

/** CLP “depositado” (col 3) from `net worth-stocks.csv` for the SPY or VEA row — same Numbers field the import uses. */
export function readSpyVeaDepositadoClpFromStocksCsv(slug: "spy" | "vea"): number | null {
  const fp = path.join(cfraserCsvDir(), "net worth-stocks.csv");
  if (!fs.existsSync(fp)) return null;
  const lines = fs.readFileSync(fp, "utf8").split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line?.trim()) continue;
    const cols = line.split(";");
    const key = String(cols[0] ?? "")
      .trim()
      .replace(/^\ufeff/, "")
      .toLowerCase();
    if (key !== slug) continue;
    const dep = numCsv(cols[3]);
    if (dep == null || !Number.isFinite(dep) || dep <= 0) return null;
    return dep;
  }
  return null;
}

/** Net coin held today from cripto-sheet ledger (Σ `units_delta`, or legacy `coin=` notes). */
export function netCryptoCoinFromMovements(accountId: number, asset: CryptoAsset): number | null {
  const has = db
    .prepare(
      `SELECT 1 FROM movements WHERE account_id = ? AND note LIKE ? LIMIT 1`
    )
    .get(accountId, `%cripto-sheet|${asset}|%`);
  if (!has) return null;
  const units = cryptoCoinCumulativeThroughDate(accountId, chileCalendarTodayYmd(), asset);
  return Number.isFinite(units) ? units : null;
}

export function tickerFromCategorySlug(slug: string): string | null {
  switch (slug) {
    case "spy":
      return "SPY";
    case "vea":
      return "VEA";
    case "bitcoin":
      return "BTC";
    case "eth":
      return "ETH";
    default:
      return null;
  }
}

export type UnitsKind = "shares" | "coin";

export type AccountPositionMeta = {
  ticker: string;
  units_kind: UnitsKind;
  /** ETF shares or coin units (BTC / ETH) */
  units: number | null;
  /**
   * AFP (UNO Fondo A): when set, account summary `position` uses these for valor hoy / fecha / valor cuota
   * instead of dividing latest DB valuation by units (Σ cuotas × latest `fund_unit_daily` row).
   */
  afp_override_value_clp?: number | null;
  afp_override_value_as_of?: string | null;
  afp_override_valor_cuota_clp?: number | null;
};

export function getAccountPositionMeta(
  accountId: number,
  categorySlug: string,
  opts?: { afpCuotasAsOfYmd?: string }
): AccountPositionMeta | null {
  const ticker = tickerFromCategorySlug(categorySlug);
  if (ticker) {
    if (categorySlug === "spy" || categorySlug === "vea") {
      const units = readSpyVeaShareUnitsFromStocksCsv(categorySlug);
      return { ticker, units_kind: "shares", units: units ?? null };
    }
    if (categorySlug === "bitcoin" || categorySlug === "eth") {
      const asset: CryptoAsset = categorySlug === "bitcoin" ? "BTC" : "ETH";
      const asOf =
        opts?.afpCuotasAsOfYmd && /^\d{4}-\d{2}-\d{2}$/.test(opts.afpCuotasAsOfYmd.trim())
          ? opts.afpCuotasAsOfYmd.trim()
          : chileCalendarTodayYmd();
      const units = cryptoCoinCumulativeThroughDate(accountId, asOf, asset);
      const equityTicker = cryptoEquityTickerForCategorySlug(categorySlug)!;
      const mtm = computeCryptoMtmClp(accountId, asOf);
      const closeRow = db
        .prepare(
          `SELECT trade_date, close_usd FROM equity_daily
           WHERE ticker = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 1`
        )
        .get(equityTicker, asOf) as { trade_date: string; close_usd: number } | undefined;
      const out: AccountPositionMeta = {
        ticker,
        units_kind: "coin",
        units: units > 1e-12 && Number.isFinite(units) ? units : null,
      };
      if (mtm != null && Number.isFinite(mtm) && closeRow?.trade_date) {
        out.afp_override_value_clp = Math.round(mtm * 100) / 100;
        out.afp_override_value_as_of = closeRow.trade_date;
        const u = out.units;
        if (u != null && u > 1e-12) {
          const fx = fxRowOnOrBefore(closeRow.trade_date);
          const pxUsd = closeRow.close_usd;
          if (fx && fx.clp_per_usd > 0 && Number.isFinite(pxUsd)) {
            out.afp_override_valor_cuota_clp = Math.round(pxUsd * fx.clp_per_usd * 10000) / 10000;
          } else {
            out.afp_override_valor_cuota_clp = Math.round((mtm / u) * 10000) / 10000;
          }
        }
      }
      return out;
    }
  }
  if (categorySlug === "afp") {
    const asOfCuotas =
      opts?.afpCuotasAsOfYmd && /^\d{4}-\d{2}-\d{2}$/.test(opts.afpCuotasAsOfYmd.trim())
        ? opts.afpCuotasAsOfYmd.trim()
        : chileCalendarTodayYmd();
    const cuotas = afpCuotasCumulativeThroughDate(accountId, asOfCuotas);
    const series = AFP_UNO_CUOTA_SERIES_KEY;
    let fu = latestAfpUnoFundUnitRowOnOrBeforeForDisplay(series, asOfCuotas);
    if (fu == null) fu = latestFundUnitRowOnOrBefore(series, asOfCuotas);
    const px = fu?.unit_value_clp;
    const pxDay = fu?.day;
    const out: AccountPositionMeta = {
      ticker: "UNO-A",
      units_kind: "shares",
      units: cuotas > 1e-9 && Number.isFinite(cuotas) ? cuotas : null,
    };
    if (cuotas > 1e-9 && px != null && px > 0 && pxDay) {
      out.afp_override_value_clp = Math.round(cuotas * px * 100) / 100;
      out.afp_override_value_as_of = pxDay;
      out.afp_override_valor_cuota_clp = Math.round(px * 10000) / 10000;
    }
    return out;
  }
  return null;
}

/** Live AFP mark: Σ cuotas × latest valor cuota (same as dashboard / account summary). */
export function liveAfpDisplayValueClp(
  accountId: number,
  asOfYmd?: string
): { value_clp: number; as_of_date: string } | null {
  const asOf =
    asOfYmd && /^\d{4}-\d{2}-\d{2}$/.test(asOfYmd.trim()) ? asOfYmd.trim() : chileCalendarTodayYmd();
  const meta = getAccountPositionMeta(accountId, "afp", { afpCuotasAsOfYmd: asOf });
  const clp = meta?.afp_override_value_clp;
  const date = meta?.afp_override_value_as_of;
  if (clp != null && Number.isFinite(clp) && date) {
    return { value_clp: clp, as_of_date: date };
  }
  return null;
}

/** Chart / pie trailing point: live AFP when requested, else stored valuation snapshot. */
export function afpValuationRawClpForChart(
  accountId: number,
  storedClp: number | null | undefined,
  useLiveMark: boolean
): number | null {
  if (useLiveMark) {
    const live = liveAfpDisplayValueClp(accountId);
    if (live) return live.value_clp;
  }
  return storedClp != null && Number.isFinite(storedClp) ? storedClp : null;
}

export function applyLiveAfpToAccountValueMap(
  lastVal: Map<number, number>,
  accountMeta: Map<number, { category_slug: string }>
): void {
  for (const [id, m] of accountMeta) {
    if (m.category_slug !== "afp") continue;
    const live = liveAfpDisplayValueClp(id);
    if (live) lastVal.set(id, live.value_clp);
  }
}
