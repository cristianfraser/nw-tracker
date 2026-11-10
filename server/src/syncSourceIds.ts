/**
 * The global sync's sources by id (a leaf: the config, the status rows and the schedule all
 * name them without importing what each source does). What a source does — its stale rule,
 * schedule and runner — is its row in `globalSyncSources.ts`.
 */
export const GLOBAL_SYNC_SOURCES = [
  "afp_uno",
  "afc_cic",
  "fintual",
  "fintual_official_serie",
  "fintual_rn_composition",
  "cmf_rn_portfolio",
  "sbif_usd",
  "sbif_eur",
  "sbif_uf",
  "sbif_utm",
  "sbif_ipc",
  "stocks_nyse",
  "stocks_santiago",
  "stocks_london",
  "yahoo_fx_usd",
  "crypto_eod",
] as const;

export type GlobalSyncSource = (typeof GLOBAL_SYNC_SOURCES)[number];

export function isGlobalSyncSource(value: string): value is GlobalSyncSource {
  return (GLOBAL_SYNC_SOURCES as readonly string[]).includes(value);
}

const LEGACY_EQUITY_EOD_SOURCE = "equity_eod";

/** @deprecated UI/API used `equity_eod` before stocks/crypto split. */
export function isLegacyEquityEodSyncSource(value: string): boolean {
  return value === LEGACY_EQUITY_EOD_SOURCE;
}

/**
 * Sources the hosted demo never runs: they read the author's own Fintual goals, or only serve
 * the Risky Norris proxy of funds the demo does not hold. The demo syncs only the public market
 * sources its holdings need (stocks, crypto, USD/CLP, Banco Central, AFP UNO — from UNO's own API,
 * `afpUnoOfficialSource`; its AFC is a book account, so `afc_cic` reads «Not configured» too).
 * Read through the deployment profile (`config.ts`).
 */
export const DEMO_SYNC_DISABLED_SOURCES: ReadonlySet<GlobalSyncSource> = new Set([
  "fintual",
  "fintual_official_serie",
  "fintual_rn_composition",
  "cmf_rn_portfolio",
]);
