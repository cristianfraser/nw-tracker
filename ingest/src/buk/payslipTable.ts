/** One month of the Buk liquidaciones table: its period and the print link to the PDF. */
export type PayslipRow = { period: string; pdfUrl: string };

/** «09-2026» → «2026-09»; anything else throws (a changed table must surface). */
export function periodFromBukMonth(raw: string): string {
  const m = /^(\d{2})-(\d{4})$/.exec(raw.trim());
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) throw new Error(`Buk: month cell «${raw}» is not MM-YYYY`);
  return `${m[2]}-${m[1]}`;
}
