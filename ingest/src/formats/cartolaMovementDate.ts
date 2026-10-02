/**
 * The year of a cartola movement printed as dd/mm, from the statement's own period.
 *
 * One rule, shared with the Python cartola parsers: the candidates are the years Y from
 * year(DESDE) to year(HASTA) for which dd/mm/Y is a real calendar date inside [DESDE, HASTA].
 * Exactly one candidate is the date. None means the row is outside the period (or dd/mm is not a
 * date that year), several mean the period spans more than a year so dd/mm names more than one
 * day, and a missing bound leaves nothing to decide by: all three throw. The case table both
 * languages assert is `server/src/test/cartolaMovementYearCases.json`.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function calendarDateIso(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(day) || !Number.isInteger(month) || month < 1 || month > 12 || day < 1) {
    return null;
  }
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * ISO date of the movement printed as `day`/`month` in a cartola covering DESDE..HASTA (ISO,
 * inclusive). `where` (file and row) prefixes the error.
 */
export function cartolaMovementDateIso(
  day: number,
  month: number,
  period: { desde: string | null; hasta: string | null },
  where?: string
): string {
  const dayMonth = `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}`;
  const label = `${where ? `${where}: ` : ""}cartola movement ${dayMonth}`;
  const { desde, hasta } = period;
  if (!desde) throw new Error(`${label}: the period start (DESDE) is missing`);
  if (!hasta) throw new Error(`${label}: the period end (HASTA) is missing`);
  if (!ISO_DATE.test(desde) || !ISO_DATE.test(hasta) || desde > hasta) {
    throw new Error(`${label}: bad period ${desde}..${hasta}`);
  }
  const candidates: string[] = [];
  for (let year = Number(desde.slice(0, 4)); year <= Number(hasta.slice(0, 4)); year++) {
    const iso = calendarDateIso(year, month, day);
    if (iso && iso >= desde && iso <= hasta) candidates.push(iso);
  }
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    throw new Error(`${label} is not a date inside the period ${desde}..${hasta}`);
  }
  throw new Error(
    `${label} is ambiguous: ${candidates.join(" and ")} are inside the period ${desde}..${hasta}`
  );
}
