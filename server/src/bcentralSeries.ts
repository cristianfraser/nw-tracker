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
  /** IPC index level (INE base), monthly. */
  ipc: seriesEnv("BCENTRAL_SERIES_IPC", "G073.IPC.IND.2018.M"),
} as const;
