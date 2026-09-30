/**
 * Banco Central BDE [GetSeries](https://si3.bcentral.cl/estadisticas/Principal1/Web_Services/doc_es.htm) codes.
 * Override any series via repo-root `.env` (`BCENTRAL_SERIES_*`).
 */
function seriesEnv(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : fallback;
}

export const BCENTRAL_SERIES = {
  /** Dólar observado (CLP per USD), daily. */
  usd: seriesEnv("BCENTRAL_SERIES_USD", "F073.TCO.PRE.Z.D"),
  /** Euro observado / tipo de cambio nominal euro (CLP per EUR), daily. */
  eur: seriesEnv("BCENTRAL_SERIES_EUR", "F072.CLP.EUR.N.O.D"),
  /** UF (CLP per 1 UF), daily. */
  uf: seriesEnv("BCENTRAL_SERIES_UF", "F073.UFF.PRE.Z.D"),
  /** UTM (CLP), monthly (stored on first-of-month dates in `utm_daily`). */
  utm: seriesEnv("BCENTRAL_SERIES_UTM", "F073.UTR.PRE.Z.M"),
} as const;

/**
 * IPC general, monthly, dated the first of the IPC month — the BCCh «empalme» (spliced) series,
 * base 2023 = 100, which runs from 1998 to the latest published month. The base-2018 series
 * (`G073.IPC.IND.2018.M`) stopped at 2023-12. Kept apart from {@link BCENTRAL_SERIES} because
 * these print plain decimals («68.13588542», «-0.0207») and are read by their own parser
 * (`fetchIpcMonthsVerified`), never the generic one.
 */
export const BCENTRAL_IPC_SERIES = {
  /** Index level, base 2023 = 100. */
  index: seriesEnv("BCENTRAL_SERIES_IPC", "G073.IPC.IND.2023.M"),
  /** Monthly variation in percent, published beside the index; every fetch checks one against the other. */
  variation: seriesEnv("BCENTRAL_SERIES_IPC_VARIATION", "G073.IPC.VAR.2023.M"),
} as const;
