/** Parse YYYY-MM; returns null if invalid. */
export function parseYearMonth(s: string): string | null {
  const t = String(s ?? "").trim();
  if (!/^\d{4}-\d{2}$/.test(t)) return null;
  const [y, m] = t.split("-").map(Number);
  if (m < 1 || m > 12 || y < 1990 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** Add whole calendar months to a YYYY-MM anchor (UTC month arithmetic). */
export function addCalendarMonths(ym: string, delta: number): string {
  const p = parseYearMonth(ym);
  if (!p) return ym;
  const [ys, ms] = p.split("-");
  const y = Number(ys);
  const m0 = Number(ms) - 1 + delta;
  const d = new Date(Date.UTC(y, m0, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
