/**
 * Global decimal-separator preference. Every number in the app (CLP, USD, UF,
 * instrument units, percents) shares one separator convention regardless of
 * the currency being displayed; only the fraction-digit count stays per value
 * type.
 *
 * Seeded once from the IANA timezone on first load — period-decimal regions
 * (US, Canada, Mexico, UK) get `period`, everywhere else gets `comma` — then
 * the stored value is authoritative. The locale (`navigator.language`) is NOT
 * used: it reflects OS/browser language (often en-US on machines in
 * comma-decimal countries), not the regional number convention.
 */
export type DecimalSeparator = "comma" | "period";

export const DECIMAL_SEPARATOR_LS_KEY = "nw-tracker.decimalSeparator";

export type NumberLocale = "es-CL" | "en-US";

/** `es-CL` renders 1.234.567,89; `en-US` renders 1,234,567.89. */
export function numberLocaleForSeparator(sep: DecimalSeparator): NumberLocale {
  return sep === "period" ? "en-US" : "es-CL";
}

/** Exact IANA zones for the UK, Mexico, Canada, and the US (see prefixes below for the rest). */
const PERIOD_DECIMAL_TIMEZONES = new Set<string>([
  // United Kingdom
  "Europe/London",
  "Europe/Belfast",
  // Mexico
  "America/Mexico_City",
  "America/Cancun",
  "America/Merida",
  "America/Monterrey",
  "America/Matamoros",
  "America/Chihuahua",
  "America/Ciudad_Juarez",
  "America/Ojinaga",
  "America/Mazatlan",
  "America/Bahia_Banderas",
  "America/Hermosillo",
  "America/Tijuana",
  // Canada
  "America/St_Johns",
  "America/Halifax",
  "America/Glace_Bay",
  "America/Moncton",
  "America/Goose_Bay",
  "America/Blanc-Sablon",
  "America/Toronto",
  "America/Nipigon",
  "America/Thunder_Bay",
  "America/Iqaluit",
  "America/Pangnirtung",
  "America/Atikokan",
  "America/Winnipeg",
  "America/Rainy_River",
  "America/Resolute",
  "America/Rankin_Inlet",
  "America/Regina",
  "America/Swift_Current",
  "America/Edmonton",
  "America/Cambridge_Bay",
  "America/Yellowknife",
  "America/Inuvik",
  "America/Creston",
  "America/Dawson_Creek",
  "America/Fort_Nelson",
  "America/Vancouver",
  "America/Whitehorse",
  "America/Dawson",
  // United States
  "America/New_York",
  "America/Detroit",
  "America/Chicago",
  "America/Menominee",
  "America/Denver",
  "America/Boise",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Juneau",
  "America/Sitka",
  "America/Metlakatla",
  "America/Yakutat",
  "America/Nome",
  "America/Adak",
  "Pacific/Honolulu",
]);

/** Country-scoped IANA prefixes: legacy aliases plus the nested US sub-zones. */
const PERIOD_DECIMAL_TZ_PREFIXES = [
  "US/",
  "Canada/",
  "Mexico/",
  "America/Indiana/",
  "America/Kentucky/",
  "America/North_Dakota/",
];

export function decimalSeparatorFromTimeZone(
  timeZone: string | null | undefined
): DecimalSeparator {
  if (!timeZone) return "comma";
  if (PERIOD_DECIMAL_TIMEZONES.has(timeZone)) return "period";
  if (PERIOD_DECIMAL_TZ_PREFIXES.some((p) => timeZone.startsWith(p))) return "period";
  return "comma";
}

export function persistDecimalSeparator(sep: DecimalSeparator): void {
  try {
    localStorage.setItem(DECIMAL_SEPARATOR_LS_KEY, sep);
  } catch {
    /* ignore (private mode / node tests) */
  }
}

/** Stored value if present; otherwise derive from the timezone and persist the seed. */
export function readInitialDecimalSeparator(): DecimalSeparator {
  try {
    const stored = localStorage.getItem(DECIMAL_SEPARATOR_LS_KEY);
    if (stored === "comma" || stored === "period") return stored;
  } catch {
    /* ignore (private mode / node tests) */
  }
  const derived = decimalSeparatorFromTimeZone(
    Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  persistDecimalSeparator(derived);
  return derived;
}
