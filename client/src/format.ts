import {
  numberLocaleForSeparator,
  readInitialDecimalSeparator,
  type DecimalSeparator,
  type NumberLocale,
} from "./numberFormatPreference";

/** Narrow / figure spaces from Intl — normalize for mono display */
function normalizeIntlNum(s: string): string {
  return s.replace(/\u202f|\u2007|\u00a0/g, " ").trim();
}

/**
 * One separator convention for every number in the app, regardless of the
 * currency displayed (see numberFormatPreference.ts). Module-level so plain
 * format helpers follow the toggle without threading React context; AppTree
 * consumes the display-preferences context, so a change re-renders the whole
 * tree and every render-time format call re-runs. Do not cache formatted
 * strings in useMemo/state without `decimalSeparator` in the deps — memoize
 * raw numbers and format at render time instead.
 */
let numberLocale: NumberLocale = numberLocaleForSeparator(readInitialDecimalSeparator());

export function setDecimalSeparatorForFormatting(sep: DecimalSeparator): void {
  numberLocale = numberLocaleForSeparator(sep);
}

const numFmtCache = new Map<string, Intl.NumberFormat>();

function numFmt(minFrac: number, maxFrac: number): Intl.NumberFormat {
  const key = `${numberLocale}|${minFrac}|${maxFrac}`;
  let f = numFmtCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(numberLocale, {
      minimumFractionDigits: minFrac,
      maximumFractionDigits: maxFrac,
    });
    numFmtCache.set(key, f);
  }
  return f;
}

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
  return unit === "usd-fine" ? numFmt(2, 2) : numFmt(0, 0);
}

/** Grouped digits with up to 2 fraction digits; trailing zeros omitted (e.g. `902`, `40,41`). */
export function formatGroupedDecimalTrimmed(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return normalizeIntlNum(numFmt(0, 2).format(n));
}

/** Grouped digits with a fixed fraction-digit range in the active separator convention. */
export function formatGroupedDecimal(n: number, minFrac: number, maxFrac = minFrac): string {
  if (!Number.isFinite(n)) return "—";
  return normalizeIntlNum(numFmt(minFrac, maxFrac).format(n));
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

/** Whole pesos: `$` + grouped thousands (e.g. `$95.817.344`; negative `($1.234)`). */
export function formatClp(n: number): string {
  return formatCurrency(n, "clp");
}

/** CLP per 1 UF (UF día) — `$` + exactly 2 decimals (e.g. `$40.763,45`). */
export function formatClpUfDay(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${normalizeIntlNum(numFmt(2, 2).format(n))}`;
}

/** Whole USD: `US$` + grouped thousands (e.g. `US$123.456`; negative `(US$1.234)`). */
export function formatUsd(n: number): string {
  return formatCurrency(n, "usd");
}

/** CC expense line: CLP with optional original USD in parentheses. */
export function formatCcExpenseLineAmount(
  amountClp: number,
  amountUsd: number | null | undefined
): string {
  const clp = formatClp(amountClp);
  if (amountUsd == null || !Number.isFinite(amountUsd) || amountUsd === 0) return clp;
  return `${clp} (${formatUsdFine(amountUsd)})`;
}

/** USD with cents — still prefixed `US$`; negatives `(US$1,234.56)`. */
export function formatUsdFine(n: number): string {
  return formatCurrency(n, "usd-fine");
}

/** Percent (value already ×100) with fixed decimals in the active separator convention (e.g. `12,34%`). */
export function formatPct(n: number | null | undefined, frac = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${normalizeIntlNum(numFmt(frac, frac).format(n))}%`;
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
      locales: numberLocale,
      format: NUMBER_FLOW_INT_FORMAT,
    };
  }
  return {
    value: abs,
    prefix: symbol,
    suffix: "",
    locales: numberLocale,
    format: NUMBER_FLOW_INT_FORMAT,
  };
}

/** Card title balance Δ: `+$…` / `($…)` / `$0` (muted row; no ▲/▼ or green/red). */
export function titleBalanceDeltaNumberFlowParts(
  n: number,
  unit: Exclude<CurrencyDisplayUnit, "usd-fine"> = "clp",
  symbolOverride?: string
): ReturnType<typeof accountingCurrencyNumberFlowParts> {
  const rounded = Math.round(n);
  if (rounded < 0) {
    return accountingCurrencyNumberFlowParts(rounded, unit, symbolOverride);
  }
  const base = accountingCurrencyNumberFlowParts(rounded, unit, symbolOverride);
  if (rounded > 0) {
    return { ...base, prefix: `+${base.prefix}` };
  }
  return base;
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
    locales: numberLocale,
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
    locales: numberLocale,
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
  return normalizeIntlNum(numFmt(0, max).format(n));
}

/** Values already in UF units (e.g. CLP / clp_per_uf) — suffix ` UF`, up to 2 decimals. */
export function formatUfUnits(uf: number): string {
  if (!Number.isFinite(uf)) return "—";
  // NBSP keeps the unit attached to the number so line wrapping can't split "123,45 UF".
  return `${normalizeIntlNum(numFmt(0, 2).format(uf))}\u00A0UF`;
}

/** UF with up to 4 decimals (tables / certificates). */
export function formatUfUnitsFine(uf: number | null | undefined): string {
  if (uf == null || !Number.isFinite(uf)) return "—";
  // NBSP keeps the unit attached to the number so line wrapping can't split "123,45 UF".
  return `${normalizeIntlNum(numFmt(0, 4).format(uf))}\u00A0UF`;
}

/** Mortgage / loan remaining balance — up to 4 UF decimals, no trailing zeros. */
export function formatUfBalance(uf: number | null | undefined): string {
  return formatUfUnitsFine(uf);
}

/** Returns `fmt(value)` when value is a finite number, otherwise `"—"`. */
export function formatOrDash(value: number | null | undefined, fmt: (n: number) => string): string {
  return value != null && Number.isFinite(value) ? fmt(value) : "—";
}

export type PieMoneyUnit = "clp" | "usd";

/** Legend / tooltips on pies: CLP whole pesos; USD with cents. */
export function formatMoneyForPie(v: number, unit: PieMoneyUnit): string {
  return unit === "usd" ? formatUsdFine(v) : formatClp(v);
}

