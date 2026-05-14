import fs from "node:fs";
import path from "node:path";
import { db } from "./db.js";
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

/** Net coin from import notes `import:excel|cripto-sheet|BTC|…|coin=…` */
export function netCryptoCoinFromMovements(accountId: number, asset: "BTC" | "ETH"): number | null {
  const rows = db
    .prepare(
      `SELECT amount_clp, note FROM movements
       WHERE account_id = ? AND note LIKE ?
       ORDER BY occurred_on, id`
    )
    .all(accountId, `%cripto-sheet|${asset}|%`) as { amount_clp: number; note: string | null }[];
  if (rows.length === 0) return null;
  let sum = 0;
  const coinRe = /coin=([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/;
  for (const r of rows) {
    const m = r.note?.match(coinRe);
    if (!m) continue;
    const qty = Number(m[1]);
    if (!Number.isFinite(qty)) continue;
    const wdw = r.note?.includes("|wdw");
    sum += wdw ? -qty : qty;
  }
  return Number.isFinite(sum) ? sum : null;
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
};

export function getAccountPositionMeta(accountId: number, categorySlug: string): AccountPositionMeta | null {
  const ticker = tickerFromCategorySlug(categorySlug);
  if (!ticker) return null;
  if (categorySlug === "spy" || categorySlug === "vea") {
    const units = readSpyVeaShareUnitsFromStocksCsv(categorySlug);
    return { ticker, units_kind: "shares", units: units ?? null };
  }
  if (categorySlug === "bitcoin") {
    return { ticker, units_kind: "coin", units: netCryptoCoinFromMovements(accountId, "BTC") };
  }
  if (categorySlug === "eth") {
    return { ticker, units_kind: "coin", units: netCryptoCoinFromMovements(accountId, "ETH") };
  }
  return null;
}
