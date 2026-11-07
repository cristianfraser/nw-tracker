/**
 * The Fintual goals the app tracks, in one table (in display order) (docs/untangle-valuation-core.md, step 1): each
 * goal's fund account (by its import key), Fintual's goal id, the account's name and leaf kind,
 * its valor cuota series, the public serie the official prices come from, and whether the Risky
 * Norris basket proxies it intraday. Every per-goal map and every series set (the proxied series,
 * the APV series, the public series) derives from it. A leaf: no imports.
 */
export type FintualGoal = Readonly<{
  importKey: string;
  goalId: string;
  name: string;
  /** Leaf kind slug (`apv_a` / `apv_b` stay distinct: `apv` alone matches both régimen leaves). */
  categorySlug: string;
  /** The régimen leaf of an APV goal (`leafAssetGroupIdForKindSlug('apv')` ties to apv-b). */
  apvLeafSlug: string | null;
  seriesKey: string;
  /** Fintual's public `managed_fund_serie` id (official prices since inception). */
  publicSerie: number;
  /** The Risky Norris basket proxies the fund intraday (`riskyNorrisProxyMtm.ts`). */
  rnProxy: boolean;
  /** An APV régimen serie (the APV/RN ratio's numerator). */
  apv: boolean;
}>;

export const FINTUAL_GOALS: readonly FintualGoal[] = [
  {
    importKey: "import:fintual|cert|key=reserva2",
    goalId: "1164983",
    name: "Reserva2",
    categorySlug: "fondo_reserva",
    apvLeafSlug: null,
    seriesKey: "fintual_cert_reserva2",
    publicSerie: 1, // Very Conservative Streep, serie A.
    rnProxy: false,
    apv: false,
  },
  {
    importKey: "import:fintual|cert|key=risky_norris",
    goalId: "2859",
    name: "caca daca",
    categorySlug: "fintual_risky_norris",
    apvLeafSlug: null,
    seriesKey: "fintual_cert_risky_norris",
    publicSerie: 6, // Risky Norris, serie A.
    rnProxy: true,
    apv: false,
  },
  {
    importKey: "import:fintual|cert|key=apv_a",
    goalId: "16749",
    name: "mega caca",
    categorySlug: "apv_a",
    apvLeafSlug: "retirement_apv_a__apv",
    seriesKey: "fintual_cert_apv_a",
    publicSerie: 7, // Risky Norris, serie APV — the fund both APV goals hold.
    rnProxy: true,
    apv: true,
  },
  {
    importKey: "import:fintual|cert|key=apv_b",
    goalId: "78515",
    name: "mega cbcb",
    categorySlug: "apv_b",
    apvLeafSlug: "retirement_apv_b__apv",
    seriesKey: "fintual_cert_apv_b",
    publicSerie: 7,
    rnProxy: true,
    apv: true,
  },
];

/**
 * The series of the accounts that held these funds before the certificado accounts
 * (`import:excel|key=fintual_rn` / `apv_a`): still read by the proxy and the rates page.
 */
export const LEGACY_FINTUAL_SERIES: readonly { excelKey: string; seriesKey: string; rnProxy: boolean; apv: boolean }[] = [
  { excelKey: "fintual_rn", seriesKey: "fintual_risky_norris", rnProxy: true, apv: false },
  { excelKey: "apv_a", seriesKey: "fintual_risky_norris_apv", rnProxy: true, apv: true },
];

export const FINTUAL_GOAL_IMPORT_KEY_PREFIX = "import:fintual|cert|key=";

/** True for a Fintual goal's fund account import key. */
export function isFintualGoalImportKey(importKey: string | null | undefined): boolean {
  return typeof importKey === "string" && importKey.startsWith(FINTUAL_GOAL_IMPORT_KEY_PREFIX);
}

export function fintualGoalByImportKey(importKey: string): FintualGoal | null {
  return FINTUAL_GOALS.find((g) => g.importKey === importKey) ?? null;
}

/** Every series the Risky Norris basket proxies (certificado and legacy). */
export const RISKY_NORRIS_PROXY_SERIES_KEYS: ReadonlySet<string> = new Set([
  ...FINTUAL_GOALS.filter((g) => g.rnProxy).map((g) => g.seriesKey),
  ...LEGACY_FINTUAL_SERIES.filter((g) => g.rnProxy).map((g) => g.seriesKey),
]);

/** The proxied APV régimen series (certificado and legacy). */
export const RISKY_NORRIS_APV_SERIES_KEYS: ReadonlySet<string> = new Set([
  ...FINTUAL_GOALS.filter((g) => g.rnProxy && g.apv).map((g) => g.seriesKey),
  ...LEGACY_FINTUAL_SERIES.filter((g) => g.rnProxy && g.apv).map((g) => g.seriesKey),
]);

/** `fund_unit_daily.series_key` → public `managed_fund_serie` id. */
export const FINTUAL_PUBLIC_SERIE_BY_SERIES_KEY: Readonly<Record<string, number>> = Object.fromEntries(
  FINTUAL_GOALS.map((g) => [g.seriesKey, g.publicSerie])
);
