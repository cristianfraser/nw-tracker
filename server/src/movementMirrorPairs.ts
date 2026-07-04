/**
 * Historical mirror-pair candidates: two single-leg `movements` rows on different accounts,
 * opposite signs, same rounded |amount_clp|, with the inflow 0–5 days after the outflow —
 * two legs of one internal move recorded before the single-row transfer model existed
 * (`from_account_id`/`to_account_id`, see movementTransfer.ts). Candidates are reviewed in
 * the panel (/panel/mirror-pairs) and either converted into one transfer row
 * (movementMirrorConvert.ts) or rejected (movement_mirror_pair_rejections, permanent).
 *
 * Pairing mirrors resolveInternalNetWorthTransfers (flowsDepositsReconciliation.ts): greedy
 * 1:1, closest gap first. Confidence "high" (batch-approvable) requires a unique match in both
 * directions, the legs inside the cartola business-day window (bankDateMatchesTransferDate —
 * so converting cannot duplicate on a cartola re-import), and no month straddle.
 *
 * Scope (2026-07, user-decided): plain CLP pairs, corriente↔vista pairs, and fund↔checking
 * pairs where exactly one leg carries cuotas (`units_delta` moves onto the transfer row —
 * cuota readers already add transferLegUnitsThroughDate on top of the account_id ledger).
 * AFP/AFC *inflows* are excluded (funded from pre-tax payroll, never from checking); deposits
 * already explained by expense_deposit_links stay excluded (the link records the relation and
 * gastos categorization keys off the checking row).
 */
import { accountKindSlugForAccountId } from "./accountBucket.js";
import { bankDateMatchesTransferDate } from "./checkingTransferLegReconcile.js";
import { ahorroDepositNoteIsForensicFamily } from "./cuentaAhorroForensicDeposits.js";
import { db } from "./db.js";
import { movementIsStateContribution } from "./depositFlowKind.js";
import { MONTH_BUCKET_INTERNAL_TRANSFER_CATEGORIES } from "./flowsCheckingGastos.js";
import { listMovementBalanceCashAccountIds } from "./movementBalanceCashAccounts.js";

export type MirrorLegDto = {
  movement_id: number;
  account_id: number;
  account_name: string;
  kind_slug: string | null;
  occurred_on: string;
  amount_clp: number;
  units_delta: number | null;
  note: string | null;
};

export type MirrorPairBlockedReason = "checking_inflow_month_straddle";

export type MirrorPairCandidate = {
  out: MirrorLegDto;
  in: MirrorLegDto;
  gap_days: number;
  /** Legs within `[priorChileBusinessDay(in date), in date]` — the cartola re-import dedupe window. */
  within_business_day_window: boolean;
  /**
   * One leg lives on a month-bucket account (cuenta_ahorro_vivienda): its `occurred_on` is a
   * conventional month-end, so the pairing window is the whole month (± a week across the
   * boundary) instead of the day-gap rule, and the converted transfer keeps the *real-day*
   * (checking) leg's date.
   */
  month_precision: boolean;
  month_straddle: boolean;
  /** Eligible non-rejected inflows this outflow could claim (computed before greedy consumption). */
  out_candidate_count: number;
  in_candidate_count: number;
  confidence: "high" | "ambiguous";
  blocked: boolean;
  blocked_reason: MirrorPairBlockedReason | null;
};

export type RejectedMirrorPair = {
  out: MirrorLegDto;
  in: MirrorLegDto;
  created_at: string;
};

/** Inflow on or after the outflow (causal order), at most this many calendar days later. */
export const MIRROR_PAIR_MAX_DAY_GAP = 5;

/** Payroll-funded kinds: inflows there come from employers/AFP flows, not personal transfers. */
const MIRROR_INFLOW_EXCLUDED_KIND_SLUGS = new Set(["afp", "afc"]);

/** DAP round-trips are netted on the checking side; never pair either leg (see AGENTS.md). */
const MIRROR_EXCLUDED_KIND_SLUGS = new Set(["dap"]);

type EligibleLegRow = {
  id: number;
  account_id: number;
  account_name: string;
  occurred_on: string;
  amount_clp: number;
  units_delta: number | null;
  note: string | null;
};

/**
 * Legs eligible for pairing: single-leg CLP rows, optionally carrying cuotas. Excludes
 * flow_kind / USD legs (brokerage and USD-cash semantics must not be rewritten), anchor/opening
 * calibration rows, rows already explained by a link (expense_deposit_links), a synthetic
 * mirror (checking_gap_deposit_mirrors), or a payroll liquidación (payroll_work_earnings —
 * income by construction, never a transfer leg), and Buda buffer rows (budaWallet.ts).
 */
function loadEligibleLegs(): EligibleLegRow[] {
  return db
    .prepare(
      `SELECT m.id, m.account_id, a.name AS account_name, m.occurred_on, m.amount_clp, m.units_delta, m.note
       FROM movements m
       JOIN accounts a ON a.id = m.account_id
       WHERE m.account_id IS NOT NULL
         AND m.amount_clp != 0
         AND m.flow_kind IS NULL
         AND m.amount_usd IS NULL
         AND (m.note IS NULL OR (
               m.note NOT LIKE 'import:cartola|anchor|%'
           AND m.note NOT LIKE 'import:cartola|opening|%'
           AND m.note NOT LIKE 'mirror-merge|%'
           AND m.note NOT LIKE 'import:buda|%'
           AND m.note NOT LIKE 'buda-abono|%'
           AND m.note NOT LIKE 'ahorro-split|%'
           AND m.note NOT LIKE '%cripto-coin-only-wdw%'))
         AND NOT EXISTS (SELECT 1 FROM expense_deposit_links l WHERE l.deposit_movement_id = m.id)
         AND NOT EXISTS (SELECT 1 FROM checking_gap_deposit_mirrors g WHERE g.deposit_movement_id = m.id)
         AND NOT EXISTS (SELECT 1 FROM payroll_work_earnings p WHERE p.movement_id = m.id)
       ORDER BY m.occurred_on, m.id`
    )
    .all() as EligibleLegRow[];
}

function loadRejectedPairKeys(): Set<string> {
  const rows = db
    .prepare(`SELECT out_movement_id, in_movement_id FROM movement_mirror_pair_rejections`)
    .all() as { out_movement_id: number; in_movement_id: number }[];
  return new Set(rows.map((r) => `${r.out_movement_id}|${r.in_movement_id}`));
}

function daysBetweenYmd(a: string, b: string): number {
  return Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
}

function monthKey(ymd: string): string {
  return ymd.slice(0, 7);
}

/** Days either side of the month boundary a month-precision leg may reach into. */
export const MIRROR_MONTH_PRECISION_BOUNDARY_DAYS = 7;

/** Month-bucket kinds whose movements carry a conventional month-end date, not a real day. */
export function mirrorLegIsMonthPrecision(kindSlug: string | null): boolean {
  return kindSlug != null && MONTH_BUCKET_INTERNAL_TRANSFER_CATEGORIES.has(kindSlug);
}

function prevMonthKey(mk: string): string {
  const [y, m] = mk.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 2, 1));
  return d.toISOString().slice(0, 7);
}

function nextMonthKey(mk: string): string {
  const [y, m] = mk.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m!, 1));
  return d.toISOString().slice(0, 7);
}

function lastDayOfMonth(mk: string): number {
  const [y, m] = mk.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}

/**
 * Pairing window when at least one leg is month-precision (cuenta de ahorro: the sheet records
 * only mm-yyyy; movements are dated the conventional month-end). A deposit recorded in month mm
 * may have been funded during mm or at the very end of mm−1; a retiro recorded in mm may land on
 * checking during mm or the first days of mm+1. Both-legs-month-precision requires the same month.
 */
function monthPrecisionPairAllowed(
  out: { occurred_on: string },
  inn: { occurred_on: string },
  outMonthPrecision: boolean,
  inMonthPrecision: boolean
): boolean {
  const outMk = monthKey(out.occurred_on);
  const inMk = monthKey(inn.occurred_on);
  if (outMonthPrecision && inMonthPrecision) return outMk === inMk;
  if (inMonthPrecision) {
    if (outMk === inMk) return true;
    if (outMk !== prevMonthKey(inMk)) return false;
    const outDay = Number(out.occurred_on.slice(8, 10));
    return outDay > lastDayOfMonth(outMk) - MIRROR_MONTH_PRECISION_BOUNDARY_DAYS;
  }
  // outMonthPrecision
  if (inMk === outMk) return true;
  if (inMk !== nextMonthKey(outMk)) return false;
  return Number(inn.occurred_on.slice(8, 10)) <= MIRROR_MONTH_PRECISION_BOUNDARY_DAYS;
}

function legHasUnits(leg: { units_delta: number | null }): boolean {
  return leg.units_delta != null && Number.isFinite(leg.units_delta) && leg.units_delta !== 0;
}

function toLegDto(row: EligibleLegRow, kindSlug: string | null): MirrorLegDto {
  return {
    movement_id: row.id,
    account_id: row.account_id,
    account_name: row.account_name,
    kind_slug: kindSlug,
    occurred_on: row.occurred_on,
    amount_clp: row.amount_clp,
    units_delta: row.units_delta,
    note: row.note,
  };
}

/** Whether an eligible leg may participate as outflow / inflow (shared with conversion validation). */
export function mirrorLegDirectionAllowed(
  kindSlug: string | null,
  note: string | null,
  direction: "out" | "in"
): boolean {
  if (kindSlug != null && MIRROR_EXCLUDED_KIND_SLUGS.has(kindSlug)) return false;
  if (movementIsStateContribution(note)) return false;
  if (direction === "in") {
    if (kindSlug != null && MIRROR_INFLOW_EXCLUDED_KIND_SLUGS.has(kindSlug)) return false;
    if (ahorroDepositNoteIsForensicFamily(note)) return false;
  }
  return true;
}

/**
 * All current mirror-pair candidates, greedily consumed 1:1 (gap asc, amount desc, ids asc).
 * Rejected combinations are skipped during enumeration, so a rejected pair's legs stay free to
 * match other partners. Candidate counts are computed on the full non-rejected match sets
 * before greedy consumption (ambiguity signal for the UI).
 */
export function listMirrorPairCandidates(): MirrorPairCandidate[] {
  const legs = loadEligibleLegs();
  const rejected = loadRejectedPairKeys();
  const checkingIds = new Set(listMovementBalanceCashAccountIds());
  const kindSlugByAccount = new Map<number, string | null>();
  const kindSlugFor = (accountId: number): string | null => {
    if (!kindSlugByAccount.has(accountId)) {
      kindSlugByAccount.set(accountId, accountKindSlugForAccountId(accountId));
    }
    return kindSlugByAccount.get(accountId) ?? null;
  };

  const outs: EligibleLegRow[] = [];
  const ins: EligibleLegRow[] = [];
  for (const leg of legs) {
    const kind = kindSlugFor(leg.account_id);
    if (leg.amount_clp < 0) {
      if (mirrorLegDirectionAllowed(kind, leg.note, "out")) outs.push(leg);
    } else if (mirrorLegDirectionAllowed(kind, leg.note, "in")) {
      ins.push(leg);
    }
  }

  type RawPair = { out: EligibleLegRow; in: EligibleLegRow; gap: number; monthPrecision: boolean };
  const pairs: RawPair[] = [];
  const outMatchCount = new Map<number, number>();
  const inMatchCount = new Map<number, number>();
  for (const out of outs) {
    const amount = Math.round(Math.abs(out.amount_clp));
    const outMonthPrecision = mirrorLegIsMonthPrecision(kindSlugFor(out.account_id));
    for (const inn of ins) {
      if (inn.account_id === out.account_id) continue;
      if (Math.round(inn.amount_clp) !== amount) continue;
      // One transfer row carries one units_delta — a pair where both legs move cuotas
      // (fund → fund) cannot be represented; leave those as two rows.
      if (legHasUnits(out) && legHasUnits(inn)) continue;
      const inMonthPrecision = mirrorLegIsMonthPrecision(kindSlugFor(inn.account_id));
      const monthPrecision = outMonthPrecision || inMonthPrecision;
      if (monthPrecision) {
        if (!monthPrecisionPairAllowed(out, inn, outMonthPrecision, inMonthPrecision)) continue;
      } else {
        if (inn.occurred_on < out.occurred_on) continue;
        if (daysBetweenYmd(out.occurred_on, inn.occurred_on) > MIRROR_PAIR_MAX_DAY_GAP) continue;
      }
      if (rejected.has(`${out.id}|${inn.id}`)) continue;
      pairs.push({ out, in: inn, gap: daysBetweenYmd(out.occurred_on, inn.occurred_on), monthPrecision });
      outMatchCount.set(out.id, (outMatchCount.get(out.id) ?? 0) + 1);
      inMatchCount.set(inn.id, (inMatchCount.get(inn.id) ?? 0) + 1);
    }
  }

  pairs.sort(
    (a, b) =>
      a.gap - b.gap ||
      Math.abs(b.out.amount_clp) - Math.abs(a.out.amount_clp) ||
      a.out.id - b.out.id ||
      a.in.id - b.in.id
  );

  const usedOut = new Set<number>();
  const usedIn = new Set<number>();
  const result: MirrorPairCandidate[] = [];
  for (const p of pairs) {
    if (usedOut.has(p.out.id) || usedIn.has(p.in.id)) continue;
    usedOut.add(p.out.id);
    usedIn.add(p.in.id);

    const withinWindow = bankDateMatchesTransferDate(p.in.occurred_on, p.out.occurred_on);
    const monthStraddle = monthKey(p.in.occurred_on) !== monthKey(p.out.occurred_on);
    const inIsChecking = checkingIds.has(p.in.account_id);
    const outMonthPrecision = mirrorLegIsMonthPrecision(kindSlugFor(p.out.account_id));
    // Converting moves the inflow to the outflow date; across a month boundary that shifts the
    // inflow account's month attribution. On checking that breaks cartola anchors/month summaries
    // (import:cartola|anchor| saldo calibration) — hard-blocked, not just ambiguous. Exception:
    // when the OUT leg is month-precision the transfer keeps the checking (in) leg's date, so
    // the checking timeline is untouched.
    const blocked = monthStraddle && inIsChecking && !outMonthPrecision;
    const outCount = outMatchCount.get(p.out.id) ?? 1;
    const inCount = inMatchCount.get(p.in.id) ?? 1;
    // Month-precision pairs skip the bank-window requirement: the converted transfer carries the
    // real-day (cartola) leg's date, so cartola re-import dedupe matches same-day regardless.
    const high =
      outCount === 1 && inCount === 1 && !monthStraddle && (p.monthPrecision || withinWindow);

    result.push({
      out: toLegDto(p.out, kindSlugFor(p.out.account_id)),
      in: toLegDto(p.in, kindSlugFor(p.in.account_id)),
      gap_days: p.gap,
      within_business_day_window: withinWindow,
      month_precision: p.monthPrecision,
      month_straddle: monthStraddle,
      out_candidate_count: outCount,
      in_candidate_count: inCount,
      confidence: high ? "high" : "ambiguous",
      blocked,
      blocked_reason: blocked ? "checking_inflow_month_straddle" : null,
    });
  }
  return result;
}

/** Rejected pairs whose both legs still exist (FK cascade removes the rest), for the panel's restore list. */
export function listRejectedMirrorPairs(): RejectedMirrorPair[] {
  const rows = db
    .prepare(
      `SELECT r.out_movement_id, r.in_movement_id, r.created_at,
              mo.account_id AS out_account_id, ao.name AS out_account_name,
              mo.occurred_on AS out_occurred_on, mo.amount_clp AS out_amount_clp,
              mo.units_delta AS out_units_delta, mo.note AS out_note,
              mi.account_id AS in_account_id, ai.name AS in_account_name,
              mi.occurred_on AS in_occurred_on, mi.amount_clp AS in_amount_clp,
              mi.units_delta AS in_units_delta, mi.note AS in_note
       FROM movement_mirror_pair_rejections r
       JOIN movements mo ON mo.id = r.out_movement_id
       JOIN accounts ao ON ao.id = mo.account_id
       JOIN movements mi ON mi.id = r.in_movement_id
       JOIN accounts ai ON ai.id = mi.account_id
       ORDER BY mo.occurred_on DESC, r.out_movement_id DESC`
    )
    .all() as {
    out_movement_id: number;
    in_movement_id: number;
    created_at: string;
    out_account_id: number;
    out_account_name: string;
    out_occurred_on: string;
    out_amount_clp: number;
    out_units_delta: number | null;
    out_note: string | null;
    in_account_id: number;
    in_account_name: string;
    in_occurred_on: string;
    in_amount_clp: number;
    in_units_delta: number | null;
    in_note: string | null;
  }[];
  return rows.map((r) => ({
    out: {
      movement_id: r.out_movement_id,
      account_id: r.out_account_id,
      account_name: r.out_account_name,
      kind_slug: accountKindSlugForAccountId(r.out_account_id),
      occurred_on: r.out_occurred_on,
      amount_clp: r.out_amount_clp,
      units_delta: r.out_units_delta,
      note: r.out_note,
    },
    in: {
      movement_id: r.in_movement_id,
      account_id: r.in_account_id,
      account_name: r.in_account_name,
      kind_slug: accountKindSlugForAccountId(r.in_account_id),
      occurred_on: r.in_occurred_on,
      amount_clp: r.in_amount_clp,
      units_delta: r.in_units_delta,
      note: r.in_note,
    },
    created_at: r.created_at,
  }));
}
