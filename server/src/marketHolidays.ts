/**
 * Exchange holiday calendars (static lists). NYSE for SPY/VEA; Chile for SBIF context; the
 * London Stock Exchange for the `.L` lines. Extend `NYSE_CLOSED_YMD` / `CHILE_CLOSED_YMD` /
 * `LSE_CLOSED_YMD` when scheduling future years.
 */

const NYSE_CLOSED_YMD = new Set([
  // 2024
  "2024-01-01",
  "2024-01-15",
  "2024-02-19",
  "2024-03-29",
  "2024-05-27",
  "2024-06-19",
  "2024-07-04",
  "2024-09-02",
  "2024-11-28",
  "2024-12-25",
  // 2025
  "2025-01-01",
  "2025-01-20",
  "2025-02-17",
  "2025-04-18",
  "2025-05-26",
  "2025-06-19",
  "2025-07-04",
  "2025-09-01",
  "2025-11-27",
  "2025-12-25",
  // 2026
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
  // 2027
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-03-26",
  "2027-05-31",
  "2027-06-18",
  "2027-07-05",
  "2027-09-06",
  "2027-11-25",
  "2027-12-24",
]);

/** Chile public holidays (banks / SBIF often closed; UF may still publish). */
const CHILE_CLOSED_YMD = new Set([
  "2025-01-01",
  "2025-04-18",
  "2025-04-19",
  "2025-05-01",
  "2025-05-21",
  "2025-06-20",
  "2025-06-29",
  "2025-07-16",
  "2025-08-15",
  "2025-09-18",
  "2025-09-19",
  "2025-10-12",
  "2025-10-31",
  "2025-11-01",
  "2025-11-16",
  "2025-12-08",
  "2025-12-25",
  "2026-01-01",
  "2026-04-03",
  "2026-04-04",
  "2026-05-01",
  "2026-05-21",
  "2026-06-29",
  "2026-07-16",
  "2026-08-15",
  "2026-09-18",
  "2026-09-19",
  "2026-10-12",
  "2026-10-31",
  "2026-11-01",
  "2026-12-08",
  "2026-12-25",
]);

/**
 * London Stock Exchange closures 2023–2027: the England and Wales bank holidays as gov.uk lists
 * them (https://www.gov.uk/bank-holidays, read 2026-11-10), substitute days included (New Year's
 * Day 2023 on Monday the 2nd; Boxing Day 2026 on Monday the 28th; Christmas and Boxing Day 2027
 * on the 27th and 28th) and the 2023-05-08 coronation holiday. The LSE closes at 12:30 on 24 and
 * 31 December when they fall on a weekday: those half days are modelled as FULL sessions here —
 * the bar exists (Yahoo prints it at the 08:00 open like every other), the day is a trading
 * day, and the live window simply sees no new prints after 12:30.
 */
const LSE_CLOSED_YMD = new Set([
  // 2023
  "2023-01-02",
  "2023-04-07",
  "2023-04-10",
  "2023-05-01",
  "2023-05-08",
  "2023-05-29",
  "2023-08-28",
  "2023-12-25",
  "2023-12-26",
  // 2024
  "2024-01-01",
  "2024-03-29",
  "2024-04-01",
  "2024-05-06",
  "2024-05-27",
  "2024-08-26",
  "2024-12-25",
  "2024-12-26",
  // 2025
  "2025-01-01",
  "2025-04-18",
  "2025-04-21",
  "2025-05-05",
  "2025-05-26",
  "2025-08-25",
  "2025-12-25",
  "2025-12-26",
  // 2026
  "2026-01-01",
  "2026-04-03",
  "2026-04-06",
  "2026-05-04",
  "2026-05-25",
  "2026-08-31",
  "2026-12-25",
  "2026-12-28",
  // 2027
  "2027-01-01",
  "2027-03-26",
  "2027-03-29",
  "2027-05-03",
  "2027-05-31",
  "2027-08-30",
  "2027-12-27",
  "2027-12-28",
]);

function utcWeekday(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

export function isWeekendYmd(ymd: string): boolean {
  const w = utcWeekday(ymd);
  return w === 0 || w === 6;
}

export function isNyseHoliday(ymd: string): boolean {
  return NYSE_CLOSED_YMD.has(ymd);
}

export function isChileHoliday(ymd: string): boolean {
  return CHILE_CLOSED_YMD.has(ymd);
}

export function isLseHoliday(ymd: string): boolean {
  return LSE_CLOSED_YMD.has(ymd);
}

/** London Stock Exchange regular session scheduled on this calendar day (Europe/London date). */
export function isLondonTradingDay(ymd: string): boolean {
  return !isWeekendYmd(ymd) && !isLseHoliday(ymd);
}

/** NYSE regular session scheduled on this calendar day (America/New_York date). */
export function isNyseTradingDay(ymd: string): boolean {
  return !isWeekendYmd(ymd) && !isNyseHoliday(ymd);
}

export function isChileBusinessDay(ymd: string): boolean {
  return !isWeekendYmd(ymd) && !isChileHoliday(ymd);
}

/** Previous Chile business day strictly before `ymd` (for observado / AFP / Fintual expectations). */
export function priorChileBusinessDayYmd(ymd: string, maxSteps = 14): string | null {
  let cur = ymd;
  for (let i = 0; i < maxSteps; i++) {
    const [y, m, d] = cur.split("-").map(Number);
    const dt = new Date(Date.UTC(y!, m! - 1, d! - 1));
    cur = dt.toISOString().slice(0, 10);
    if (isChileBusinessDay(cur)) return cur;
  }
  return null;
}

/** Next Chile business day strictly after `ymd` (posting date of a post-cutoff wire). */
export function nextChileBusinessDayYmd(ymd: string, maxSteps = 14): string | null {
  let cur = ymd;
  for (let i = 0; i < maxSteps; i++) {
    const [y, m, d] = cur.split("-").map(Number);
    const dt = new Date(Date.UTC(y!, m! - 1, d! + 1));
    cur = dt.toISOString().slice(0, 10);
    if (isChileBusinessDay(cur)) return cur;
  }
  return null;
}

/** Previous NYSE session date strictly before `ymd`. */
export function priorNyseSessionYmd(ymd: string, maxSteps = 14): string | null {
  let cur = ymd;
  for (let i = 0; i < maxSteps; i++) {
    const [y, m, d] = cur.split("-").map(Number);
    const dt = new Date(Date.UTC(y!, m! - 1, d! - 1));
    cur = dt.toISOString().slice(0, 10);
    if (isNyseTradingDay(cur)) return cur;
  }
  return null;
}

/** NYSE session `sessions` trading days strictly before `fromYmd` (e.g. 5 ≈ one week). */
export function nyseSessionsBack(fromYmd: string, sessions: number): string | null {
  let cur = fromYmd;
  for (let i = 0; i < sessions; i++) {
    const prior = priorNyseSessionYmd(cur);
    if (prior == null) return null;
    cur = prior;
  }
  return cur;
}

/** Previous London Stock Exchange session date strictly before `ymd`. */
export function priorLondonSessionYmd(ymd: string, maxSteps = 14): string | null {
  let cur = ymd;
  for (let i = 0; i < maxSteps; i++) {
    const [y, m, d] = cur.split("-").map(Number);
    const dt = new Date(Date.UTC(y!, m! - 1, d! - 1));
    cur = dt.toISOString().slice(0, 10);
    if (isLondonTradingDay(cur)) return cur;
  }
  return null;
}

/** London session `sessions` trading days strictly before `fromYmd` (e.g. 5 ≈ one week). */
export function londonSessionsBack(fromYmd: string, sessions: number): string | null {
  let cur = fromYmd;
  for (let i = 0; i < sessions; i++) {
    const prior = priorLondonSessionYmd(cur);
    if (prior == null) return null;
    cur = prior;
  }
  return cur;
}
