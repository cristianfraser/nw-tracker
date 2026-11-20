import { formatPct } from "../../format";

/**
 * The year so far's % beside a detalle row's YTD amount: the server's `ytd_pct` (a fraction, the
 * Rentabilidad YTD rule) when the row carries one. Absent on scopes that keep the one-step % (a
 * liability's cost) and null when no day of the year has a return: no figure either way.
 */
export function perfDetailYtdPct(row: { ytd_pct?: number | null }): string | undefined {
  const p = row.ytd_pct;
  if (p == null || !Number.isFinite(p)) return undefined;
  return formatPct(p * 100);
}

/** The row's scope serves the year so far's % (the field is present, a figure or null). */
export function perfDetailServesYtdPct(row: { ytd_pct?: number | null }): boolean {
  return row.ytd_pct !== undefined;
}
