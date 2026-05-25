/** Format `YYYY-MM` as a short Spanish month + year (UTC calendar month, not local TZ). */
export function formatMonthLabelFromYm(ym: string): string {
  const [y, m] = ym.split("-");
  const mo = Number(m);
  if (!Number.isFinite(mo) || mo < 1 || mo > 12) return ym;
  const d = new Date(Date.UTC(Number(y), mo - 1, 1));
  return d.toLocaleDateString("es-CL", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
