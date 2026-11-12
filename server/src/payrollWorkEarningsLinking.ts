import { monthEndUtcYmd } from "./calendarMonth.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import { db } from "./db.js";
import type { FlowCheckingIncomeLine } from "./flowsCheckingInflows.js";
import { buildFlowsCheckingIncomePayload } from "./flowsCheckingInflows.js";

export const PAYROLL_LINK_REMUNERACION_TOLERANCE_CLP = 50;
export const PAYROLL_LINK_WINDOW_DAYS_AFTER_MONTH_END = 10;

const EMPLOYER_TOKEN_STOPWORDS = new Set(["CHILE", "SPA", "LTDA", "LIMITADA", "CORP"]);

export type PayrollLinkCandidate = FlowCheckingIncomeLine & {
  cartola_note: string | null;
  /** The movement's own amount and currency (a single-leg credit: what the bank credited). */
  native_amount: number;
  native_currency: string;
};

/** A US pay stub pairs with a dollar credit of its net pay landing this many days around the pay date. */
export const US_PAYROLL_LINK_DAYS_BEFORE_PAY_DATE = 2;
export const US_PAYROLL_LINK_DAYS_AFTER_PAY_DATE = 3;

function addCalendarDaysYmd(ymd: string, deltaDays: number): string {
  const [ys, ms, ds] = ymd.split("-");
  const y = Number(ys);
  const m = Number(ms);
  const d = Number(ds);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw new Error(`invalid ymd: ${ymd}`);
  }
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

function signedDaysFromTo(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T12:00:00Z`);
  const b = Date.parse(`${toYmd}T12:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function employerMatchTokens(employerName: string): string[] {
  const words = employerName
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4 && !EMPLOYER_TOKEN_STOPWORDS.has(w));
  return [...new Set(words)];
}

export function noteMatchesPayrollEmployer(
  cartolaNote: string,
  description: string,
  employerName: string
): boolean {
  const haystack = `${cartolaNote} ${description}`.toUpperCase();
  if (/REMUNERACION/i.test(haystack)) return true;
  for (const token of employerMatchTokens(employerName)) {
    if (haystack.includes(token)) return true;
  }
  if (/INTELLEGO/i.test(haystack) && /AXITY/i.test(employerName.toUpperCase())) {
    return true;
  }
  return false;
}

function amountMatchesLiquido(
  movementAmount: number,
  liquidoClp: number,
  cartolaNote: string,
  description: string,
  employerName: string
): boolean {
  const diff = Math.abs(movementAmount - liquidoClp);
  if (diff === 0) return true;
  if (
    diff <= PAYROLL_LINK_REMUNERACION_TOLERANCE_CLP &&
    noteMatchesPayrollEmployer(cartolaNote, description, employerName)
  ) {
    return true;
  }
  return false;
}

function inLinkDateWindow(receivedOn: string, periodMonth: string): boolean {
  const windowStart = `${periodMonth}-01`;
  const windowEnd = addCalendarDaysYmd(
    monthEndUtcYmd(periodMonth),
    PAYROLL_LINK_WINDOW_DAYS_AFTER_MONTH_END
  );
  return receivedOn >= windowStart && receivedOn <= windowEnd;
}

type MovementFacts = { note: string | null; amount: number; currency: string };

function loadMovementFactsById(movementIds: readonly number[]): Map<number, MovementFacts> {
  const out = new Map<number, MovementFacts>();
  if (movementIds.length === 0) return out;
  const placeholders = movementIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT id, note, amount, currency FROM movements WHERE id IN (${placeholders})`)
    .all(...movementIds) as ({ id: number } & MovementFacts)[];
  for (const row of rows) {
    out.set(row.id, { note: row.note, amount: row.amount, currency: row.currency });
  }
  return out;
}

export function listPayrollLinkCandidates(): PayrollLinkCandidate[] {
  const lines = buildFlowsCheckingIncomePayload().lines;
  const facts = loadMovementFactsById(lines.map((l) => l.movement_id));
  return lines.map((line) => {
    const f = facts.get(line.movement_id);
    if (!f) throw new Error(`payroll link: income line movement ${line.movement_id} not found`);
    return { ...line, cartola_note: f.note, native_amount: f.amount, native_currency: f.currency };
  });
}

export type PayrollAutoLinkResult =
  | { kind: "linked"; movement_id: number }
  | { kind: "unmatched" }
  | { kind: "ambiguous"; movement_ids: number[] };

export function findPayrollAutoLinkMovement(
  liquidoClp: number,
  periodMonth: string,
  employerName: string,
  candidates: readonly PayrollLinkCandidate[],
  takenMovementIds: ReadonlySet<number>
): PayrollAutoLinkResult {
  const nextPeriodMonth = addCalendarMonths(periodMonth, 1);

  const eligible = candidates.filter((c) => {
    if (takenMovementIds.has(c.movement_id)) return false;
    if (!inLinkDateWindow(c.received_on, periodMonth)) return false;
    return amountMatchesLiquido(
      c.amount_clp,
      liquidoClp,
      c.cartola_note ?? "",
      c.description,
      employerName
    );
  });

  if (eligible.length === 0) return { kind: "unmatched" };

  const scored = eligible.map((c) => {
    const employerBonus = noteMatchesPayrollEmployer(
      c.cartola_note ?? "",
      c.description,
      employerName
    )
      ? 0
      : 1;
    const receivedYm = c.received_on.slice(0, 7);
    let monthPreference = 2;
    if (receivedYm === nextPeriodMonth) monthPreference = 0;
    else if (receivedYm === periodMonth) monthPreference = 1;
    const dayGap = Math.abs(signedDaysFromTo(monthEndUtcYmd(periodMonth), c.received_on));
    const amountGap = Math.abs(c.amount_clp - liquidoClp);
    return {
      c,
      score: [employerBonus, monthPreference, dayGap, amountGap, c.movement_id] as const,
    };
  });
  scored.sort((a, b) => {
    for (let i = 0; i < a.score.length; i++) {
      if (a.score[i]! < b.score[i]!) return -1;
      if (a.score[i]! > b.score[i]!) return 1;
    }
    return 0;
  });

  const best = scored[0]!;
  const bestScore = best.score;
  const ties = scored.filter((s) => s.score.every((v, i) => v === bestScore[i]));
  if (ties.length > 1) {
    return { kind: "ambiguous", movement_ids: ties.map((t) => t.c.movement_id) };
  }
  return { kind: "linked", movement_id: best.c.movement_id };
}

/**
 * A US pay stub's deposit: the one dollar credit of exactly its net pay (to the cent) received from
 * two days before the pay date (early direct deposit) to three days after; nearest day first, ties
 * of distinct movements reported. Biweekly and semi-monthly pay dates are 13+ days apart, so two
 * stubs of one month never compete for one window.
 */
export function findUsPayrollAutoLinkMovement(
  netPayUsd: number,
  payDate: string,
  candidates: readonly PayrollLinkCandidate[],
  takenMovementIds: ReadonlySet<number>
): PayrollAutoLinkResult {
  const from = addCalendarDaysYmd(payDate, -US_PAYROLL_LINK_DAYS_BEFORE_PAY_DATE);
  const to = addCalendarDaysYmd(payDate, US_PAYROLL_LINK_DAYS_AFTER_PAY_DATE);
  const eligible = candidates.filter(
    (c) =>
      !takenMovementIds.has(c.movement_id) &&
      c.native_currency === "usd" && // convention-ok: a contractor wire lands in dollars
      Math.abs(c.native_amount - netPayUsd) < 0.005 &&
      c.received_on >= from &&
      c.received_on <= to
  );
  if (eligible.length === 0) return { kind: "unmatched" };
  const gap = (c: PayrollLinkCandidate) => Math.abs(signedDaysFromTo(payDate, c.received_on));
  const best = Math.min(...eligible.map(gap));
  const nearest = eligible.filter((c) => gap(c) === best);
  if (nearest.length > 1) return { kind: "ambiguous", movement_ids: nearest.map((c) => c.movement_id) };
  return { kind: "linked", movement_id: nearest[0]!.movement_id };
}

export function assertMovementEligibleForPayrollLink(
  movementId: number,
  candidates: readonly PayrollLinkCandidate[]
): PayrollLinkCandidate {
  const hit = candidates.find((c) => c.movement_id === movementId);
  if (!hit) {
    throw new Error(`movement ${movementId} is not an eligible checking income inflow`);
  }
  return hit;
}
