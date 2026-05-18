/** Narrow / figure spaces from Intl — normalize for mono display */
function normalizeIntlNum(s: string): string {
  return s.replace(/\u202f|\u2007|\u00a0/g, " ").trim();
}

const intEsCl = new Intl.NumberFormat("es-CL", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const intEnUs = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const usdFineNum = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const ufUnitsFmt = new Intl.NumberFormat("es-CL", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** Whole pesos: `$` + es-CL thousands (e.g. `$95.817.344`). */
export function formatClp(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const rounded = Math.round(n);
  return `$${normalizeIntlNum(intEsCl.format(rounded))}`;
}

export function clpToUsd(clp: number, clpPerUsd: number) {
  if (!clpPerUsd) return 0;
  return clp / clpPerUsd;
}

/** Whole USD: `US$` + en-US thousands (e.g. `US$123,456`). */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const rounded = Math.round(n);
  return `US$${normalizeIntlNum(intEnUs.format(rounded))}`;
}

/** USD with cents — still prefixed `US$`. */
export function formatUsdFine(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `US$${normalizeIntlNum(usdFineNum.format(n))}`;
}

/** ETF shares or crypto coin units (no currency symbol) */
export function formatInstrumentUnits(n: number, kind: "shares" | "coin") {
  const max = kind === "coin" ? 8 : 6;
  return normalizeIntlNum(
    new Intl.NumberFormat("es-CL", {
      minimumFractionDigits: 0,
      maximumFractionDigits: max,
    }).format(n)
  );
}

/** Values already in UF units (e.g. CLP / clp_per_uf) — suffix ` UF`, es-CL decimals. */
export function formatUfUnits(uf: number): string {
  if (!Number.isFinite(uf)) return "—";
  return `${normalizeIntlNum(ufUnitsFmt.format(uf))} UF`;
}

/** UF with up to 4 decimals (tables / certificates). */
export function formatUfUnitsFine(uf: number | null | undefined): string {
  if (uf == null || !Number.isFinite(uf)) return "—";
  const s = new Intl.NumberFormat("es-CL", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  }).format(uf);
  return `${normalizeIntlNum(s)} UF`;
}

/** Mortgage / loan remaining balance — up to 4 UF decimals, no trailing zeros. */
export function formatUfBalance(uf: number | null | undefined): string {
  return formatUfUnitsFine(uf);
}

export type PieMoneyUnit = "clp" | "usd";

/** Legend / tooltips on pies: CLP whole pesos; USD with cents and en-US grouping. */
export function formatMoneyForPie(v: number, unit: PieMoneyUnit): string {
  return unit === "usd" ? formatUsdFine(v) : formatClp(v);
}
