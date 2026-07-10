/**
 * Global UI-language preference (es | en). Same model as the decimal-separator
 * preference (numberFormatPreference.ts): seeded once from the browser on
 * first load, then the stored value is authoritative and editable from the
 * settings panel (/panel/settings).
 *
 * Unlike the separator (which derives from the IANA timezone), the language
 * seed DOES read `navigator.language`: OS/browser language is exactly the
 * signal we want here — a Spanish-language browser gets `es`, anything else
 * gets `en`. Dates keep the fixed `es-CL` locale regardless (AGENTS.md), and
 * the decimal separator stays an independent setting.
 */
export type AppLanguage = "es" | "en";

export const LANGUAGE_LS_KEY = "nw-tracker.language";

export function languageFromNavigatorLanguage(
  navigatorLanguage: string | null | undefined
): AppLanguage {
  if (!navigatorLanguage) return "es";
  return navigatorLanguage.toLowerCase().startsWith("es") ? "es" : "en";
}

export function persistLanguage(lang: AppLanguage): void {
  try {
    localStorage.setItem(LANGUAGE_LS_KEY, lang);
  } catch {
    /* ignore (private mode / node tests) */
  }
}

/** Stored value if present; otherwise derive from the browser language and persist the seed. */
export function readInitialLanguage(): AppLanguage {
  // Non-browser (vitest / node): modern Node exposes navigator.language = "en-US",
  // which would flip test snapshots — stay deterministic at the app's home locale.
  if (typeof window === "undefined") return "es";
  try {
    const stored = localStorage.getItem(LANGUAGE_LS_KEY);
    if (stored === "es" || stored === "en") return stored;
  } catch {
    /* ignore (private mode) */
  }
  const derived = languageFromNavigatorLanguage(navigator.language);
  persistLanguage(derived);
  return derived;
}
