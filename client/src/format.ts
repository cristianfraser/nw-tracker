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

/** Matches `@number-flow/react` `format` prop (subset of `Intl.NumberFormatOptions`). */
export const NUMBER_FLOW_INT_FORMAT = {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
  signDisplay: "never",
} as const;

export type CurrencyDisplayUnit = "clp" | "usd" | "usd-fine";

const CURRENCY_SYMBOL: Record<Exclude<CurrencyDisplayUnit, "usd-fine">, string> = {
  clp: "$",
  usd: "US$",
};

function intlFormatter(unit: CurrencyDisplayUnit): Intl.NumberFormat {
  if (unit === "usd-fine") return usdFineNum;
  return unit === "clp" ? intEsCl : intEnUs;
}

function currencyLocales(unit: CurrencyDisplayUnit): string {
  return unit === "clp" ? "es-CL" : "en-US";
}

/**
 * Grouped digits only (no sign, no currency). For deltas and other non-currency amounts.
 */
export function formatNumberGrouped(n: number, unit: Exclude<CurrencyDisplayUnit, "usd-fine"> = "clp"): string {
  if (!Number.isFinite(n)) return "—";
  return normalizeIntlNum(intlFormatter(unit).format(Math.abs(Math.round(n))));
}

/** Grouped digits with up to 2 fraction digits; trailing zeros omitted (e.g. `902`, `40,41`). */
export function formatGroupedDecimalTrimmed(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return normalizeIntlNum(ufUnitsFmt.format(n));
}

/**
 * Currency display string. Negatives use accounting parentheses: `$-1` → `($1)`.
 * No leading `+` on positives.
 */
export function formatCurrency(n: number, unit: CurrencyDisplayUnit = "clp"): string {
  if (!Number.isFinite(n)) return "—";
  const rounded = unit === "usd-fine" ? n : Math.round(n);
  const abs = Math.abs(rounded);
  const sym = unit === "usd-fine" ? CURRENCY_SYMBOL.usd : CURRENCY_SYMBOL[unit];
  const digits = normalizeIntlNum(intlFormatter(unit).format(abs));
  const body = `${sym}${digits}`;
  if (rounded < 0) return `(${body})`;
  return body;
}

/** Whole pesos: `$` + es-CL thousands (e.g. `$95.817.344`; negative `($1.234)`). */
export function formatClp(n: number): string {
  return formatCurrency(n, "clp");
}

export function clpToUsd(clp: number, clpPerUsd: number) {
  if (!clpPerUsd) return 0;
  return clp / clpPerUsd;
}

/** Whole USD: `US$` + en-US thousands (e.g. `US$123,456`; negative `(US$1,234)`). */
export function formatUsd(n: number): string {
  return formatCurrency(n, "usd");
}

/** USD with cents — still prefixed `US$`; negatives `(US$1,234.56)`. */
export function formatUsdFine(n: number): string {
  return formatCurrency(n, "usd-fine");
}

/** Props for {@link https://number-flow.barvian.me/ NumberFlow} currency (no `+`/`-` digit; negatives via parens). */
export function accountingCurrencyNumberFlowParts(
  n: number,
  unit: Exclude<CurrencyDisplayUnit, "usd-fine">,
  /** Dashboard card values use `$` for both CLP and USD. */
  symbolOverride?: string
): {
  value: number;
  prefix: string;
  suffix: string;
  locales: string;
  format: typeof NUMBER_FLOW_INT_FORMAT;
} {
  const rounded = Math.round(n);
  const abs = Math.abs(rounded);
  const symbol = symbolOverride ?? CURRENCY_SYMBOL[unit];
  if (rounded < 0) {
    return {
      value: abs,
      prefix: `(${symbol}`,
      suffix: ")",
      locales: currencyLocales(unit),
      format: NUMBER_FLOW_INT_FORMAT,
    };
  }
  return {
    value: abs,
    prefix: symbol,
    suffix: "",
    locales: currencyLocales(unit),
    format: NUMBER_FLOW_INT_FORMAT,
  };
}

/** Plain percent for NumberFlow (no sign) — direction via ▲/▼; suffix `%`. */
export function plainPercentNumberFlowParts(
  n: number,
  fractionDigits = 2
): {
  value: number;
  suffix: string;
  locales: string;
  format: { minimumFractionDigits: number; maximumFractionDigits: number; signDisplay: "never" };
} {
  const fd = Math.max(0, Math.min(4, Math.trunc(fractionDigits)));
  const factor = 10 ** fd;
  return {
    value: Math.abs(Math.round(n * factor) / factor),
    suffix: "%",
    locales: "en-US",
    format: {
      minimumFractionDigits: fd,
      maximumFractionDigits: fd,
      signDisplay: "never",
    },
  };
}

/** Plain grouped amount for NumberFlow (no sign, no currency) — use color/icon for direction. */
export function plainNumberFlowParts(
  n: number,
  unit: Exclude<CurrencyDisplayUnit, "usd-fine"> = "clp",
  fractionDigits = 0
): {
  value: number;
  locales: string;
  format: { minimumFractionDigits: number; maximumFractionDigits: number; signDisplay: "never" };
} {
  const fd = Math.max(0, Math.min(8, Math.trunc(fractionDigits)));
  const factor = 10 ** fd;
  return {
    value: Math.abs(Math.round(n * factor) / factor),
    locales: currencyLocales(unit),
    format: {
      minimumFractionDigits: fd,
      maximumFractionDigits: fd,
      signDisplay: "never",
    },
  };
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
