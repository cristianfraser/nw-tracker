/**
 * The CMF's monthly «Cartera de inversiones extranjeras» of every Chilean mutual fund
 * (`https://www.cmfchile.cl/institucional/estadisticas/ffm_cartera.php`, `ffm_download.php` with
 * `mm`, `aa`, `cartera=EXTR`; file `FFM_INV_EXTR_YYYYMM.txt`): one semicolon-separated row per
 * holding, columns named after Circular 1333. Only what the basket history needs is read: the
 * fund (RUN + name), the instrument's nemotécnico («FTEC US», «SPXS LN» — ticker + market), its
 * issuer, and the last column, the holding's share of the fund's total assets in percent.
 * Everything else travels as text. A row that does not fit the header throws: the file is the
 * regulator's and a shape change must be looked at, not skipped.
 */

export type CmfForeignHolding = {
  fund_run: number;
  fund_name: string;
  /** The bare ticker («SPXS»), the market suffix removed. */
  ticker: string;
  /** The nemotécnico's market («US», «LN»), null when the file prints none. */
  market: string | null;
  issuer: string;
  /** Instrument type as filed («ETFA»). */
  instrument_type: string;
  quantity: number | null;
  /** Share of the fund's total assets, as a fraction (the file prints percent). */
  share_of_assets: number;
};

const HEADER_PREFIX = "Run Fondo;Nombre Fondo;FFM_6020100;";
const COLUMN_COUNT = 24;
const COL_NEMO = 2;
const COL_ISSUER = 3;
const COL_TYPE = 5;
const COL_QUANTITY = 10;

/** Parses one monthly file; `fundRun` narrows to one fund (the whole industry is in the file). */
export function parseCmfForeignPortfolio(text: string, fundRun?: number): CmfForeignHolding[] {
  const lines = text.split(/\r?\n/);
  const header = lines[0] ?? "";
  if (!header.startsWith(HEADER_PREFIX)) {
    throw new Error(`CMF cartera: unexpected header «${header.slice(0, 60)}»`);
  }
  if (header.split(";").length !== COLUMN_COUNT) {
    throw new Error(`CMF cartera: header has ${header.split(";").length} columns, expected ${COLUMN_COUNT}`);
  }
  const out: CmfForeignHolding[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cells = line.split(";");
    if (cells.length !== COLUMN_COUNT) {
      throw new Error(`CMF cartera line ${i + 1}: ${cells.length} columns, expected ${COLUMN_COUNT}`);
    }
    const run = Number(cells[0]);
    if (!Number.isInteger(run)) throw new Error(`CMF cartera line ${i + 1}: RUN «${cells[0]}» is not a number`);
    if (fundRun != null && run !== fundRun) continue;
    const nemo = cells[COL_NEMO].trim();
    if (!nemo) throw new Error(`CMF cartera line ${i + 1}: empty nemotécnico`);
    const parts = nemo.split(/\s+/);
    const ticker = parts[0].toUpperCase();
    const market = parts.length > 1 ? parts.slice(1).join(" ").toUpperCase() : null;
    const pctText = cells[COLUMN_COUNT - 1].trim();
    const pct = Number(pctText);
    if (!Number.isFinite(pct) || pct < 0) {
      throw new Error(`CMF cartera line ${i + 1}: share of assets «${pctText}» is not a number`);
    }
    const qtyText = cells[COL_QUANTITY].trim();
    const quantity = qtyText === "" || qtyText === "NA" ? null : Number(qtyText);
    if (quantity != null && !Number.isFinite(quantity)) {
      throw new Error(`CMF cartera line ${i + 1}: quantity «${qtyText}» is not a number`);
    }
    out.push({
      fund_run: run,
      fund_name: cells[1].trim(),
      ticker,
      market,
      issuer: cells[COL_ISSUER].trim(),
      instrument_type: cells[COL_TYPE].trim(),
      quantity,
      share_of_assets: pct / 100,
    });
  }
  return out;
}

/** The last calendar day of a YYYYMM period, ISO. */
export function cmfPeriodEndIso(yyyymm: string): string {
  const m = /^(\d{4})(\d{2})$/.exec(yyyymm);
  if (!m) throw new Error(`CMF period «${yyyymm}» is not YYYYMM`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`CMF period «${yyyymm}» has month ${month}`);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${m[1]}-${m[2]}-${String(lastDay).padStart(2, "0")}`;
}

/**
 * One fund's holdings as a basket in the shape the history stores: the ticker's share of the
 * foreign-ETF sleeve (shares renormalized to sum to 1) plus the sleeve's share of fund assets.
 * Two rows of one ticker (two markets, two lots) are merged. An empty sleeve throws.
 */
export function cmfBasketForFund(
  holdings: CmfForeignHolding[],
  fundRun: number
): { etf_weight_sum: number; holdings: { ticker: string; weight: number }[] } {
  const rows = holdings.filter((h) => h.fund_run === fundRun);
  if (!rows.length) throw new Error(`CMF cartera: fund ${fundRun} has no foreign holdings in this file`);
  const byTicker = new Map<string, number>();
  for (const r of rows) byTicker.set(r.ticker, (byTicker.get(r.ticker) ?? 0) + r.share_of_assets);
  const sum = [...byTicker.values()].reduce((a, b) => a + b, 0);
  if (!(sum > 0)) throw new Error(`CMF cartera: fund ${fundRun} foreign sleeve sums to ${sum}`);
  return {
    etf_weight_sum: sum,
    holdings: [...byTicker]
      .map(([ticker, share]) => ({ ticker, weight: share / sum }))
      .sort((a, b) => b.weight - a.weight || a.ticker.localeCompare(b.ticker)),
  };
}
