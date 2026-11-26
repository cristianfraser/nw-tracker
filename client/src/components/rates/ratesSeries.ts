import type { RatesGlanceRow } from "../../types";

/**
 * The «Currencies» series, in the order drawn. The server's glance lists the same five
 * (`RATES_SERIES` in `server/src/ratesPage.ts`); this is the page's frame before that answer
 * arrives, so every tile is on screen from the first paint.
 */
export const RATES_CURRENCY_SERIES: readonly Pick<RatesGlanceRow, "id" | "kind" | "base" | "quote" | "value_currency">[] = [
  { id: "usd_clp", kind: "fx_usd", base: "usd", quote: "clp", value_currency: "clp" },
  { id: "uf_clp", kind: "uf", base: "uf", quote: "clp", value_currency: "clp" },
  { id: "eur_clp", kind: "fx_pair", base: "eur", quote: "clp", value_currency: "clp" },
  { id: "eur_usd", kind: "fx_pair", base: "eur", quote: "usd", value_currency: "usd" },
  { id: "ipc", kind: "index", base: null, quote: null, value_currency: "none" },
];

/** A valueless glance row for a series whose figures have not arrived. */
export function pendingGlanceRow(
  series: Pick<RatesGlanceRow, "id" | "kind" | "base" | "quote" | "value_currency">
): RatesGlanceRow {
  return { ...series, label: null, series_key: null, value: null, as_of_date: null, changes: null };
}

/** A rate pair as the page names it (`USD/CLP`): codes, not copy. */
export function ratesPairLabel(p: { base: string; quote: string }): string {
  return `${p.base.toUpperCase()}/${p.quote.toUpperCase()}`;
}

/** A glance row's name: a pair by its codes, the IPC by its title, an instrument by the server's label. */
export function ratesRowLabel(row: Pick<RatesGlanceRow, "id" | "base" | "quote" | "label">, t: (key: string) => string): string {
  if (row.base != null && row.quote != null) return ratesPairLabel({ base: row.base, quote: row.quote });
  if (row.label != null) return row.label;
  if (row.id === "ipc") return t("rates.fx.ipcTitle");
  throw new Error(`rates: series ${row.id} has no name`);
}
