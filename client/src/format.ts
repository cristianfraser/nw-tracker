import i18n from "./i18n";
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
 * raw numbers and format at render time instead. Number inputs read typed
 * text with the same preference ({@link parseNumberInput}).
 */
let decimalSeparator: DecimalSeparator = readInitialDecimalSeparator();
let numberLocale: NumberLocale = numberLocaleForSeparator(decimalSeparator);

export function setDecimalSeparatorForFormatting(sep: DecimalSeparator): void {
  decimalSeparator = sep;
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

/**
 * `full` spells the currency out where there is room (desktop, cards, tables);
 * `bare` keeps only the symbol for space-constrained surfaces (mobile chart axes,
 * dashboard card values). A new currency adds both forms in one place — `bare`
 * is what mobile drops the qualifier to, so it can never drift per-surface.
 */
export type CurrencySymbolVariant = "full" | "bare";

const CURRENCY_SYMBOL: Record<
  Exclude<CurrencyDisplayUnit, "usd-fine">,
  Record<CurrencySymbolVariant, string>
> = {
  clp: { full: "$", bare: "$" },
  usd: { full: "US$", bare: "$" },
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
  const sym =
    unit === "usd-fine" ? CURRENCY_SYMBOL.usd.full : CURRENCY_SYMBOL[unit].full;
  const digits = normalizeIntlNum(intlFormatter(unit).format(abs));
  const body = `${sym}${digits}`;
  if (rounded < 0) return `(${body})`;
  return body;
}

/** Whole pesos: `$` + grouped thousands (e.g. `$9x.xxx.xxx`; negative `($1.234)`). */
export function formatClp(n: number): string {
  return formatCurrency(n, "clp");
}

/** CLP per 1 UF (UF día) — `$` + exactly 2 decimals (e.g. `$4x.xxx,xx`). */
export function formatClpUfDay(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${normalizeIntlNum(numFmt(2, 2).format(n))}`;
}

/** Whole USD: `US$` + grouped thousands (e.g. `US$1xx.xxx`; negative `(US$1.234)`). */
export function formatUsd(n: number): string {
  return formatCurrency(n, "usd");
}

/**
 * Short-notation money for space-constrained surfaces — today the mobile chart Y axes
 * ({@link import("./components/charts/chartLayout").moneyYAxisProps}). Two things shrink at
 * once: the magnitude (`$10.000.000` → `$10M`) and the symbol, which drops to its `bare`
 * form so a USD axis reads `$350k`, not `US$xxxk` (the CLP/USD toolbar toggle carries the
 * unit on those screens).
 *
 * Thresholds: below 1.000 stays whole (`$950`); 1.000–9xx.xxx → `k`; 1M and up → `M` all
 * the way (`$1.400M`) — one suffix per magnitude keeps an axis unambiguous at 11px, where
 * `M` next to `MM` reads as a typo. Mantissa carries 1 decimal below 100 and none above
 * (`$2,xx M`, `$350k`), trailing zeros trimmed, separator per the app-wide convention.
 * Negatives keep the accounting parentheses every other money surface uses: `($5M)`.
 *
 * NOT `Intl` `notation: "compact"`: es-CL renders locale words there (`10 M`, `350 mil`),
 * which breaks both the bilingual contract and the separator convention.
 */
export function formatCompactMoney(n: number, unit: Exclude<CurrencyDisplayUnit, "usd-fine">): string {
  if (!Number.isFinite(n)) return "—";
  const rounded = Math.round(n);
  const abs = Math.abs(rounded);
  const sym = CURRENCY_SYMBOL[unit].bare;
  const { mantissa, suffix, frac } = compactMagnitude(abs);
  const body = `${sym}${normalizeIntlNum(numFmt(0, frac).format(mantissa))}${suffix}`;
  return rounded < 0 ? `(${body})` : body;
}

/** Magnitude split for {@link formatCompactMoney}; `frac` is the max (trimmed) decimal count. */
function compactMagnitude(abs: number): { mantissa: number; suffix: string; frac: 0 | 1 } {
  if (abs < 1_000) return { mantissa: abs, suffix: "", frac: 0 };
  if (abs < 1_000_000) {
    const thousands = abs / 1_000;
    const frac: 0 | 1 = thousands >= 100 ? 0 : 1;
    // 9xx.xxx → "1.000k" would be a lie about the magnitude; promote it to the M band.
    if (roundTo(thousands, frac) < 1_000) return { mantissa: thousands, suffix: "k", frac };
  }
  const millions = abs / 1_000_000;
  return { mantissa: millions, suffix: "M", frac: millions >= 100 ? 0 : 1 };
}

function roundTo(n: number, frac: number): number {
  const factor = 10 ** frac;
  return Math.round(n * factor) / factor;
}

/**
 * Adaptive USD decimals for summary-card values: keep ≥4 significant digits capped
 * at cents — |n| < 100 → 2, < 1.000 → 1, ≥ 1.000 → 0. The big main balance adapts
 * per value (trailing zeros trimmed: 55,00 → 55; 42,40 → 42,4); a card's sub-balance
 * list and its red/green delta pair each share the LEAST adaptive decimals of their
 * group ({@link minAdaptiveUsdFractionDigits} — the largest amount's precision wins).
 * Everything else (flows, tables, charts, title deltas) keeps fixed 0/2-decimal USD.
 */
export function adaptiveUsdFractionDigits(abs: number): 0 | 1 | 2 {
  if (abs < 100) return 2;
  if (abs < 1000) return 1;
  return 0;
}

/** Round to the adaptive USD precision (see {@link adaptiveUsdFractionDigits}). */
export function roundUsdAdaptive(n: number): number {
  const factor = 10 ** adaptiveUsdFractionDigits(Math.abs(n));
  return Math.round(n * factor) / factor;
}

/**
 * Least adaptive decimals across a card's USD values (sub-balances, or the two
 * red/green deltas) — the largest amount's precision caps the whole group so big
 * numbers stay clean and small siblings follow.
 */
export function minAdaptiveUsdFractionDigits(values: Array<number | null | undefined>): 0 | 1 | 2 {
  let fd: 0 | 1 | 2 = 2;
  let any = false;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    any = true;
    const band = adaptiveUsdFractionDigits(Math.abs(v));
    if (band < fd) fd = band;
  }
  return any ? fd : 0;
}

/** CC expense line: CLP with optional original USD in parentheses. */
/** Pesos with dollars beside them (`$13.881 (US$15,00)`): an import preview's movement legs. */
export function formatCcExpenseLineAmount(amountClp: number, amountUsd: number | null | undefined): string {
  const clp = formatClp(amountClp);
  if (amountUsd == null || !Number.isFinite(amountUsd) || amountUsd === 0) return clp;
  return `${clp} (${formatUsdFine(amountUsd)})`;
}

/**
 * An amount in its own currency (lowercase ISO 4217): pesos whole, dollars with cents, any other
 * currency as its code and its own minor digits (`EUR 12,50`). Negatives in parentheses.
 */
export function formatMoney(m: { value: number; currency: string }): string {
  if (m.currency === "clp") return formatClp(m.value);
  if (m.currency === "usd") return formatUsdFine(m.value);
  if (!Number.isFinite(m.value)) return "—";
  const code = m.currency.toUpperCase();
  let digits = 2;
  try {
    digits = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    throw new Error(`formatMoney: unknown currency ${m.currency}`);
  }
  const body = `${code} ${normalizeIntlNum(numFmt(digits, digits).format(Math.abs(m.value)))}`;
  return m.value < 0 ? `(${body})` : body;
}

/**
 * An expense line's amount: in its own currency, and its value in the display unit beside it when
 * the unit is another currency («US$13,30 ($13.083)», «$12.345 (US$12,70)»); «≈» marks a value at
 * today's rate (a facturación not paid yet). The line's money is the server's (`amount`, `values`).
 */
export function formatLineAmount(
  line: { amount: { value: number; currency: string }; values: Record<string, { value: number; rate_source: string }> },
  unit: string
): string {
  const own = formatMoney(line.amount);
  if (line.amount.currency === unit) return own;
  const v = line.values[unit];
  if (!v) return own;
  const shown = formatMoney({ value: v.value, currency: unit });
  return `${own} (${v.rate_source === "live" ? "≈ " : ""}${shown})`;
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
  /** Dashboard card values pass `"bare"` — `$` for both CLP and USD. */
  variant: CurrencySymbolVariant = "full"
): {
  value: number;
  prefix: string;
  suffix: string;
  locales: string;
  format: typeof NUMBER_FLOW_INT_FORMAT;
} {
  const rounded = Math.round(n);
  const abs = Math.abs(rounded);
  const symbol = CURRENCY_SYMBOL[unit][variant];
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

/**
 * {@link accountingCurrencyNumberFlowParts} with adaptive USD decimals — summary-card
 * balances only (see {@link adaptiveUsdFractionDigits}). CLP and every non-card USD
 * surface keep the fixed-decimal parts above.
 *
 * `fixedFractionDigits` pins the decimals instead (no trimming) — card sub-balance
 * lists align every sibling to the group's least adaptive decimals so the column
 * reads uniformly.
 */
export function adaptiveUsdAccountingNumberFlowParts(
  n: number,
  /** Dashboard card values pass `"bare"` — `$` for both CLP and USD. */
  variant: CurrencySymbolVariant = "full",
  fixedFractionDigits?: 0 | 1 | 2
): {
  value: number;
  prefix: string;
  suffix: string;
  locales: string;
  format: { minimumFractionDigits: number; maximumFractionDigits: number; signDisplay: "never" };
} {
  const fd = fixedFractionDigits ?? adaptiveUsdFractionDigits(Math.abs(n));
  const factor = 10 ** fd;
  const rounded = Math.round(n * factor) / factor;
  const abs = Math.abs(rounded);
  const symbol = CURRENCY_SYMBOL.usd[variant];
  // Adaptive (min 0) trims trailing decimal zeros (55,00 → 55; 42,40 → 42,4);
  // fixed keeps them so sibling rows align.
  const format = {
    minimumFractionDigits: fixedFractionDigits ?? 0,
    maximumFractionDigits: fd,
    signDisplay: "never",
  } as const;
  if (rounded < 0) {
    return { value: abs, prefix: `(${symbol}`, suffix: ")", locales: numberLocale, format };
  }
  return { value: abs, prefix: symbol, suffix: "", locales: numberLocale, format };
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

/** ETF shares, crypto coin units or option contracts (whole, signed — a short position is negative); no currency symbol. */
export function formatInstrumentUnits(n: number, kind: "shares" | "coin" | "contracts") {
  const max = kind === "coin" ? 8 : kind === "contracts" ? 0 : 6;
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

/**
 * Outcome of reading a number typed into a form field ({@link parseNumberInput}): `value` is
 * null for an empty field; `message` is the localized reason a non-empty field isn't a number.
 */
export type NumberInputResult =
  | { ok: true; value: number | null }
  | { ok: false; message: string };

/** Thousands grouped with `mark`: 1–3 leading digits (no leading zero), then `mark` + 3 digits, repeated. */
const GROUPED_INTEGER: Record<"." | ",", RegExp> = {
  ".": /^[1-9]\d{0,2}(?:\.\d{3})+$/,
  ",": /^[1-9]\d{0,2}(?:,\d{3})+$/,
};

/**
 * The one parser behind every number field (amounts, units, rates, counts), so «1.500» means
 * the same in every form. A number that can only be read one way is read that way — «1500,5»,
 * «1.5», «1.500.000», «1,234.56», «1.234,56». Only an input that fits both conventions — a single
 * mark followed by exactly three digits, «1.500» / «1,500» — is settled by the decimal-separator
 * preference: 1500 when the mark is the thousands separator, 1.5 when it is the decimal mark.
 * Anything else (letters, inner spaces, a repeated decimal mark, a broken group such as
 * «1.50.000» or «1,2,3») is rejected with a message naming both marks. A leading `-` is read;
 * each form keeps its own sign, integer and range rules on the value. `separator` defaults to
 * the active preference (tests pass it explicitly).
 */
export function parseNumberInput(
  raw: string,
  separator: DecimalSeparator = decimalSeparator
): NumberInputResult {
  const text = raw.trim();
  if (text === "") return { ok: true, value: null };
  const value = readNumberText(text, separator);
  if (value == null) return { ok: false, message: numberInputErrorMessage(text, separator) };
  return { ok: true, value };
}

/** {@link parseNumberInput} for submit paths: the value (null when empty), or throws the message. */
export function parseNumberInputOrThrow(raw: string): number | null {
  const parsed = parseNumberInput(raw);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

/** Grammar of {@link parseNumberInput} on trimmed, non-empty text; null = malformed. */
function readNumberText(text: string, separator: DecimalSeparator): number | null {
  const negative = text.startsWith("-");
  const body = negative ? text.slice(1) : text;
  if (!/^[\d.,]+$/.test(body) || !/\d/.test(body)) return null;
  const decimalMark = separator === "period" ? "." : ",";
  const lastDot = body.lastIndexOf(".");
  const lastComma = body.lastIndexOf(",");
  let integerDigits: string;
  let fractionDigits = "";
  if (lastDot === -1 && lastComma === -1) {
    integerDigits = body;
  } else if (lastDot !== -1 && lastComma !== -1) {
    // Both marks: the later one is the decimal point (once), the other groups thousands.
    const point = lastDot > lastComma ? "." : ",";
    const group = point === "." ? "," : ".";
    const at = body.indexOf(point);
    if (at !== body.lastIndexOf(point)) return null;
    const head = body.slice(0, at);
    fractionDigits = body.slice(at + 1);
    if (!/^\d+$/.test(fractionDigits) || !GROUPED_INTEGER[group].test(head)) return null;
    integerDigits = head.split(group).join("");
  } else {
    const mark = lastDot !== -1 ? "." : ",";
    const parts = body.split(mark);
    if (parts.length > 2) {
      // A repeated mark can only group thousands.
      if (!GROUPED_INTEGER[mark].test(body)) return null;
      integerDigits = parts.join("");
    } else {
      const [head, tail] = parts as [string, string];
      if (!/^\d+$/.test(tail)) return null;
      const fitsGrouping = /^[1-9]\d{0,2}$/.test(head) && tail.length === 3;
      if (fitsGrouping && mark !== decimalMark) {
        integerDigits = head + tail;
      } else {
        integerDigits = head === "" ? "0" : head;
        fractionDigits = tail;
      }
    }
  }
  const n = Number(fractionDigits ? `${integerDigits}.${fractionDigits}` : integerDigits);
  if (!Number.isFinite(n)) return null;
  const value = negative ? -n : n;
  return value === 0 ? 0 : value;
}

function numberInputErrorMessage(text: string, separator: DecimalSeparator): string {
  const decimal = separator === "period" ? "." : ",";
  const group = separator === "period" ? "," : ".";
  return i18n.t("common.numberInvalid", {
    value: text,
    decimal,
    group,
    example: `1${group}234${decimal}56`,
  });
}

/**
 * A number as a form field's text (prefills, example placeholders): the active decimal mark,
 * no thousands grouping, every digit — the form {@link parseNumberInput} reads back exactly.
 */
export function formatNumberInput(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`formatNumberInput: not a finite number (${n})`);
  const plain = plainDecimalString(n);
  return decimalSeparator === "comma" ? plain.replace(".", ",") : plain;
}

/** `String(n)` spelled without exponent notation (1.5e-7 → "0.00000015"). */
function plainDecimalString(n: number): string {
  const s = String(n);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const [, sign, int, frac = "", exp] = m;
  const digits = `${int}${frac}`;
  const point = int.length + Number(exp);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}
