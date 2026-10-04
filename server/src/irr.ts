/**
 * Internal rate of return of dated cash flows (XIRR), investor's view: money put in is negative,
 * money taken out (and the value held at the end) positive.
 *
 * Solved per window, with time measured in units of the window's own length, so the root is the
 * return over the window; {@link windowIrr} then annualizes it only when the window spans a
 * year or more — annualizing a day or a week turns noise into thousands of percent.
 */

export type DatedCashFlow = { ymd: string; amount: number };

function days(a: string, b: string): number {
  return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
}

/**
 * Rate r per `periodDays` such that Σ amount × (1 + r)^(−t ÷ periodDays) = 0, t in days from
 * `baseYmd`. The net present value is scanned on a grid over (−100%, +100.000%) and the root
 * refined by bisection. With withdrawals between deposits the equation can have several roots:
 * then no single rate describes the money and the result is null, as it is with no root (no
 * money in, no money out, or flows that end below zero with no rate that balances them).
 */
export function irrPerPeriod(
  flows: readonly DatedCashFlow[],
  baseYmd: string,
  periodDays: number
): number | null {
  if (!(periodDays > 0)) return null;
  const terms = flows
    .filter((f) => f.amount !== 0 && Number.isFinite(f.amount))
    .map((f) => ({ t: days(baseYmd, f.ymd) / periodDays, a: f.amount }));
  if (!terms.some((x) => x.a > 0) || !terms.some((x) => x.a < 0)) return null;
  // In growth factors g = 1 + r: NPV(g) = Σ a × g^(−t).
  const npv = (g: number): number => {
    let s = 0;
    for (const x of terms) s += x.a * Math.pow(g, -x.t);
    return s;
  };
  const STEPS = 600;
  const logLo = Math.log(1e-6);
  const logHi = Math.log(1001);
  const brackets: [number, number][] = [];
  let prevG = Math.exp(logLo);
  let prevV = npv(prevG);
  for (let i = 1; i <= STEPS; i++) {
    const g = Math.exp(logLo + ((logHi - logLo) * i) / STEPS);
    const v = npv(g);
    if (!Number.isFinite(v) || !Number.isFinite(prevV)) return null;
    if (v === 0) return g - 1;
    if (Math.sign(v) !== Math.sign(prevV)) brackets.push([prevG, g]);
    prevG = g;
    prevV = v;
  }
  if (brackets.length !== 1) return null;
  let [lo, hi] = brackets[0]!;
  let fLo = npv(lo);
  for (let i = 0; i < 200 && hi - lo > 1e-13; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (fMid === 0) return mid - 1;
    if (Math.sign(fMid) === Math.sign(fLo)) {
      lo = mid;
      fLo = fMid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2 - 1;
}

export type WindowIrr = {
  /** The IRR as shown: annualized when `annualized`, else the return over the window. */
  pct: number;
  annualized: boolean;
};

/**
 * IRR of a window that starts holding `vStart` on `startYmd`, receives `flows` (deposits +,
 * withdrawals −, dated in (start, end]) and ends holding `vEnd` on `endYmd`. A window that
 * starts empty runs from its first flow. Annualized when it spans 365 days or more.
 */
export function windowIrr(
  vStart: number,
  startYmd: string,
  endYmd: string,
  flows: readonly DatedCashFlow[],
  vEnd: number
): WindowIrr | null {
  const inWindow = flows.filter((f) => f.ymd > startYmd && f.ymd <= endYmd && f.amount !== 0);
  let baseYmd = startYmd;
  if (vStart === 0 && inWindow.length > 0) {
    baseYmd = inWindow.reduce((min, f) => (f.ymd < min ? f.ymd : min), inWindow[0]!.ymd);
  }
  const span = days(baseYmd, endYmd);
  if (!(span > 0)) return null;
  const cash: DatedCashFlow[] = [
    { ymd: baseYmd, amount: -vStart },
    ...inWindow.map((f) => ({ ymd: f.ymd, amount: -f.amount })),
    { ymd: endYmd, amount: vEnd },
  ];
  const perWindow = irrPerPeriod(cash, baseYmd, span);
  if (perWindow == null) return null;
  if (span < 365) return { pct: perWindow, annualized: false };
  return { pct: Math.pow(1 + perWindow, 365 / span) - 1, annualized: true };
}
