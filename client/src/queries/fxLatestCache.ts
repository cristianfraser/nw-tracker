import type { FxLatest } from "../types";

const STORAGE_KEY = "nw:fx-latest-v1";

export function readFxLatestCache(): FxLatest | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as FxLatest;
    if (
      typeof parsed.date !== "string" ||
      typeof parsed.clp_per_usd !== "number" ||
      !Number.isFinite(parsed.clp_per_usd) ||
      parsed.clp_per_usd <= 0
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeFxLatestCache(fx: FxLatest | null | undefined): void {
  if (
    fx == null ||
    typeof fx.clp_per_usd !== "number" ||
    !Number.isFinite(fx.clp_per_usd) ||
    fx.clp_per_usd <= 0
  ) {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fx));
  } catch {
    // quota / private mode
  }
}
