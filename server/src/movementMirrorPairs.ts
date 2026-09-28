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
 * so converting cannot duplicate on a cartola re-import), and no month straddle. An ambiguous
 * candidate lists the competing legs (`out_alternatives` / `in_alternatives`) and any of them
 * converts in its place (`resolveMirrorPairRef`): amount and date cannot tell same-day siblings
 * apart, so the greedy pick between them is an id order, never evidence.
 *
 * Scope (2026-07, user-decided): plain CLP pairs, corriente↔vista pairs, and fund↔checking
 * pairs where exactly one leg carries cuotas (`units_delta` moves onto the transfer row —
 * cuota readers already add transferLegUnitsThroughDate on top of the account_id ledger).
 * AFP/AFC *inflows* are excluded (funded from pre-tax payroll, never from checking); deposits
 * already explained by expense_deposit_links stay excluded (the link records the relation and
 * gastos categorization keys off the checking row); so are credits the user classified as income
 * and checking debits the user categorized as spending (structured evidence the row is not one
 * leg of a move between own accounts).
 */
import { accountKindSlugForAccountId } from "./accountBucket.js";
import { movementForCheckingPurchaseKey } from "./backfillCheckingAutoMatchCategories.js";
import { checkingCartolaStablePurchaseKey } from "./checkingCartolaParse.js";
import { legacyCheckingGastosPurchaseKey } from "./checkingGastosCategoryPersist.js";
import { bankDateMatchesTransferDate } from "./checkingTransferLegReconcile.js";
import { db } from "./db.js";
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

/**
 * Another leg that could take one side of an ambiguous pair (same amount, inside the pairing
 * window). The reviewer sees it beside the greedy pick and may convert it instead.
 */
export type MirrorPairAlternative = {
  leg: MirrorLegDto;
  gap_days: number;
  within_business_day_window: boolean;
  month_straddle: boolean;
  blocked: boolean;
  blocked_reason: MirrorPairBlockedReason | null;
};

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
  /**
   * Pair comes from an existing expense_deposit_links row (auto/manual gastos match) rather
   * than the date/amount heuristic — the link *is* the evidence, so no window applies. The
   * link row cascades away when the deposit leg is deleted at conversion. An auto link with a
   * competing same-amount outflow in the window is ambiguous: the matcher picked one of them.
   */
  linked: boolean;
  /** Eligible non-rejected inflows this outflow could claim (computed before greedy consumption). */
  out_candidate_count: number;
  in_candidate_count: number;
  /** Other outflows that could pair with this inflow, and other inflows for this outflow. */
  out_alternatives: MirrorPairAlternative[];
  in_alternatives: MirrorPairAlternative[];
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

/** A credit the user classified as income (salary, parent gift, force-include) is not a transfer leg. */
const USER_CLASSIFIED_INCOME_SQL = `SELECT 1 FROM checking_income_movement_overrides o
  WHERE o.movement_id = m.id AND o.is_excluded = 0 AND (o.income_kind IS NOT NULL OR o.force_include = 1)`;

/**
 * Expense categories that do not say an outflow was spent: no category, «unclassified»,
 * «deposits» (paid into an investment account), the internal-transfer category and «no_cuenta».
 * A checking debit filed under any other category (a per-purchase category or a category split)
 * was spent, so it cannot be one leg of a transfer between own accounts.
 */
const NON_SPENDING_CATEGORY_SLUGS = ["unclassified", "deposits", "checking_internal_transfer", "no_cuenta"];

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
 * income by construction, never a transfer leg), a credit the user classified as income, and
 * Buda buffer rows (budaWallet.ts).
 */
function loadEligibleLegs(): EligibleLegRow[] {
  return db
    .prepare(
      `SELECT m.id, m.account_id, a.name AS account_name, m.occurred_on, m.amount AS amount_clp, m.units_delta, m.note
       FROM movements m
       JOIN accounts a ON a.id = m.account_id
       WHERE m.account_id IS NOT NULL
         AND m.currency = 'clp'
         AND m.amount != 0
         AND m.flow_kind IS NULL
         AND (m.note IS NULL OR (
               m.note NOT LIKE 'import:cartola|anchor|%'
           AND m.note NOT LIKE 'import:cartola|opening|%'
           AND m.note NOT LIKE 'import:buda|%'
           AND m.note NOT LIKE 'buda-abono|%'
           AND m.note NOT LIKE 'ahorro-split|%'))
         AND NOT EXISTS (SELECT 1 FROM expense_deposit_links l WHERE l.deposit_movement_id = m.id)
         AND NOT EXISTS (SELECT 1 FROM checking_gap_deposit_mirrors g WHERE g.deposit_movement_id = m.id)
         AND NOT EXISTS (SELECT 1 FROM payroll_work_earnings p WHERE p.movement_id = m.id)
         AND NOT EXISTS (${USER_CLASSIFIED_INCOME_SQL})
       ORDER BY m.occurred_on, m.id`
    )
    .all() as EligibleLegRow[];
}

/**
 * Checking debits the user categorized as spending: the per-purchase category is keyed by the
 * debit's purchase key (the key the gastos view writes it under), a category split by the movement.
 */
function loadSpendingCategorizedOutflowIds(
  outs: readonly EligibleLegRow[],
  checkingIds: ReadonlySet<number>
): Set<number> {
  const ph = NON_SPENDING_CATEGORY_SLUGS.map(() => "?").join(",");
  const spendingKeys = new Set(
    (
      db
        .prepare(
          `SELECT u.purchase_key FROM cc_expense_unique_purchases u
           JOIN cc_expense_categories c ON c.id = u.category_id
           WHERE u.purchase_key LIKE 'checking-%' AND c.slug NOT IN (${ph})`
        )
        .all(...NON_SPENDING_CATEGORY_SLUGS) as { purchase_key: string }[]
    ).map((r) => r.purchase_key)
  );
  const splitIds = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT s.line_id FROM cc_expense_line_splits s
           JOIN cc_expense_categories c ON c.id = s.category_id
           WHERE s.source = 'checking' AND c.slug NOT IN (${ph})`
        )
        .all(...NON_SPENDING_CATEGORY_SLUGS) as { line_id: number }[]
    ).map((r) => r.line_id)
  );
  const ids = new Set<number>();
  for (const out of outs) {
    if (!checkingIds.has(out.account_id)) continue;
    const key =
      checkingCartolaStablePurchaseKey(out.account_id, out.note) ?? legacyCheckingGastosPurchaseKey(out.id);
    if (spendingKeys.has(key) || splitIds.has(out.id)) ids.add(out.id);
  }
  return ids;
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
  _note: string | null,
  direction: "out" | "in"
): boolean {
  if (kindSlug != null && MIRROR_EXCLUDED_KIND_SLUGS.has(kindSlug)) return false;
  // State-bonus rows carry a non-null flow_kind and so are already excluded by loadEligibleLegs
  // (`flow_kind IS NULL`); no note check is needed here.
  if (direction === "in") {
    if (kindSlug != null && MIRROR_INFLOW_EXCLUDED_KIND_SLUGS.has(kindSlug)) return false;
  }
  return true;
}

type LinkedLegPair = { out: EligibleLegRow; in: EligibleLegRow; link_source: "auto" | "manual" };

/**
 * Pairs already established by the gastos matcher: 1:1 `expense_deposit_links` rows (auto or
 * manual) whose `checking-cartola:` purchase key resolves to a real checking outflow of the
 * same rounded amount as the deposit. These deposits are excluded from the heuristic pool
 * (the link already explains them), but the known pairing converts directly. Synthetic links
 * (gap mirrors) have no real outflow row and partial/multi allocations cannot become one 1:1
 * transfer; both are skipped.
 */
function collectLinkedLegPairs(): LinkedLegPair[] {
  const rows = db
    .prepare(
      `SELECT purchase_key, deposit_movement_id, link_source
       FROM expense_deposit_links
       WHERE link_source IN ('auto', 'manual')
         AND purchase_key LIKE 'checking-cartola:%'`
    )
    .all() as { purchase_key: string; deposit_movement_id: number; link_source: "auto" | "manual" }[];
  const byKey = new Map<string, number>();
  const byDeposit = new Map<number, number>();
  for (const r of rows) {
    byKey.set(r.purchase_key, (byKey.get(r.purchase_key) ?? 0) + 1);
    byDeposit.set(r.deposit_movement_id, (byDeposit.get(r.deposit_movement_id) ?? 0) + 1);
  }
  const depositStmt = db.prepare(
    `SELECT m.id, m.account_id, a.name AS account_name, m.occurred_on, m.amount AS amount_clp, m.units_delta, m.note
     FROM movements m JOIN accounts a ON a.id = m.account_id
     WHERE m.id = ? AND m.account_id IS NOT NULL
       AND m.flow_kind IS NULL AND m.currency = 'clp' AND m.amount > 0
       AND (m.note IS NULL OR (
             m.note NOT LIKE 'import:buda|%'
         AND m.note NOT LIKE 'buda-abono|%'
         AND m.note NOT LIKE 'ahorro-split|%'))
       AND NOT EXISTS (SELECT 1 FROM payroll_work_earnings p WHERE p.movement_id = m.id)
       AND NOT EXISTS (${USER_CLASSIFIED_INCOME_SQL})`
  );
  const outMetaStmt = db.prepare(
    `SELECT m.id, m.account_id, a.name AS account_name, m.occurred_on, m.amount AS amount_clp, m.units_delta, m.note
     FROM movements m JOIN accounts a ON a.id = m.account_id
     WHERE m.id = ? AND m.flow_kind IS NULL AND m.currency = 'clp' AND m.amount < 0`
  );
  const pairs: LinkedLegPair[] = [];
  for (const r of rows) {
    // Only clean 1:1 links: one deposit per outflow key and one key per deposit.
    if ((byKey.get(r.purchase_key) ?? 0) !== 1) continue;
    if ((byDeposit.get(r.deposit_movement_id) ?? 0) !== 1) continue;
    const keyAccountId = Number(r.purchase_key.split(":")[1]);
    if (!Number.isInteger(keyAccountId) || keyAccountId <= 0) continue;
    const resolved = movementForCheckingPurchaseKey(keyAccountId, r.purchase_key, db);
    if (!resolved) continue;
    const out = outMetaStmt.get(resolved.id) as EligibleLegRow | undefined;
    const inn = depositStmt.get(r.deposit_movement_id) as EligibleLegRow | undefined;
    if (!out || !inn) continue;
    if (Math.round(Math.abs(out.amount_clp)) !== Math.round(inn.amount_clp)) continue;
    pairs.push({ out, in: inn, link_source: r.link_source });
  }
  return pairs;
}

type PairingContext = {
  outs: EligibleLegRow[];
  ins: EligibleLegRow[];
  rejected: Set<string>;
  checkingIds: Set<number>;
  kindSlugFor: (accountId: number) => string | null;
};

function loadPairingContext(): PairingContext {
  const legs = loadEligibleLegs();
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
  const spent = loadSpendingCategorizedOutflowIds(outs, checkingIds);
  return {
    outs: outs.filter((o) => !spent.has(o.id)),
    ins,
    rejected: loadRejectedPairKeys(),
    checkingIds,
    kindSlugFor,
  };
}

/** The pairing rule for one (outflow, inflow): amount, accounts, units, window, rejection. */
function pairingWindow(
  ctx: PairingContext,
  out: EligibleLegRow,
  inn: EligibleLegRow
): { gap: number; monthPrecision: boolean } | null {
  if (inn.account_id === out.account_id) return null;
  if (Math.round(inn.amount_clp) !== Math.round(Math.abs(out.amount_clp))) return null;
  // One transfer row carries one units_delta — a pair where both legs move cuotas
  // (fund → fund) cannot be represented; leave those as two rows.
  if (legHasUnits(out) && legHasUnits(inn)) return null;
  const outMonthPrecision = mirrorLegIsMonthPrecision(ctx.kindSlugFor(out.account_id));
  const inMonthPrecision = mirrorLegIsMonthPrecision(ctx.kindSlugFor(inn.account_id));
  const monthPrecision = outMonthPrecision || inMonthPrecision;
  if (monthPrecision) {
    if (!monthPrecisionPairAllowed(out, inn, outMonthPrecision, inMonthPrecision)) return null;
  } else {
    if (inn.occurred_on < out.occurred_on) return null;
    if (daysBetweenYmd(out.occurred_on, inn.occurred_on) > MIRROR_PAIR_MAX_DAY_GAP) return null;
  }
  if (ctx.rejected.has(`${out.id}|${inn.id}`)) return null;
  return { gap: daysBetweenYmd(out.occurred_on, inn.occurred_on), monthPrecision };
}

/**
 * Window flags of a pair. Converting moves the inflow to the outflow date; across a month boundary
 * that shifts the inflow account's month attribution. On checking that breaks cartola anchors/month
 * summaries (import:cartola|anchor| saldo calibration) — hard-blocked, not just ambiguous.
 * Exception: when the OUT leg is month-precision the transfer keeps the checking (in) leg's date,
 * so the checking timeline is untouched.
 */
function pairFlags(
  ctx: PairingContext,
  out: EligibleLegRow,
  inn: EligibleLegRow
): { withinWindow: boolean; monthStraddle: boolean; blocked: boolean } {
  const monthStraddle = monthKey(inn.occurred_on) !== monthKey(out.occurred_on);
  const outMonthPrecision = mirrorLegIsMonthPrecision(ctx.kindSlugFor(out.account_id));
  return {
    withinWindow: bankDateMatchesTransferDate(inn.occurred_on, out.occurred_on),
    monthStraddle,
    blocked: monthStraddle && ctx.checkingIds.has(inn.account_id) && !outMonthPrecision,
  };
}

function alternative(
  ctx: PairingContext,
  out: EligibleLegRow,
  inn: EligibleLegRow,
  side: "out" | "in",
  opts: { blockable: boolean }
): MirrorPairAlternative {
  const flags = pairFlags(ctx, out, inn);
  const blocked = opts.blockable && flags.blocked;
  const leg = side === "out" ? out : inn;
  return {
    leg: toLegDto(leg, ctx.kindSlugFor(leg.account_id)),
    gap_days: daysBetweenYmd(out.occurred_on, inn.occurred_on),
    within_business_day_window: flags.withinWindow,
    month_straddle: flags.monthStraddle,
    blocked,
    blocked_reason: blocked ? "checking_inflow_month_straddle" : null,
  };
}

/**
 * All current mirror-pair candidates, greedily consumed 1:1 (gap asc, amount desc, ids asc).
 * Rejected combinations are skipped during enumeration, so a rejected pair's legs stay free to
 * match other partners. Candidate counts and alternatives are computed on the full non-rejected
 * match sets before greedy consumption. Link-established pairs come first and consume their legs
 * before the heuristic runs.
 */
export function listMirrorPairCandidates(): MirrorPairCandidate[] {
  const ctx = loadPairingContext();

  type RawPair = { out: EligibleLegRow; in: EligibleLegRow; gap: number; monthPrecision: boolean };
  const pairs: RawPair[] = [];
  const insByOut = new Map<number, EligibleLegRow[]>();
  const outsByIn = new Map<number, EligibleLegRow[]>();
  for (const out of ctx.outs) {
    for (const inn of ctx.ins) {
      const w = pairingWindow(ctx, out, inn);
      if (!w) continue;
      pairs.push({ out, in: inn, gap: w.gap, monthPrecision: w.monthPrecision });
      insByOut.set(out.id, [...(insByOut.get(out.id) ?? []), inn]);
      outsByIn.set(inn.id, [...(outsByIn.get(inn.id) ?? []), out]);
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

  // Link-established pairs first: the expense_deposit_links row is the pairing evidence.
  for (const lp of collectLinkedLegPairs()) {
    if (ctx.rejected.has(`${lp.out.id}|${lp.in.id}`)) continue;
    const outKind = ctx.kindSlugFor(lp.out.account_id);
    const inKind = ctx.kindSlugFor(lp.in.account_id);
    if (!mirrorLegDirectionAllowed(outKind, lp.out.note, "out")) continue;
    if (!mirrorLegDirectionAllowed(inKind, lp.in.note, "in")) continue;
    usedOut.add(lp.out.id);
    usedIn.add(lp.in.id);
    const monthStraddle = monthKey(lp.in.occurred_on) !== monthKey(lp.out.occurred_on);
    // An auto link is the deposit matcher's pick; a same-amount outflow inside the window is an
    // equally good match by amount and date, so the reviewer chooses. A manual link is the user's.
    const outAlternatives =
      lp.link_source === "auto"
        ? ctx.outs
            .filter((o) => o.id !== lp.out.id && pairingWindow(ctx, o, lp.in) != null)
            .map((o) => alternative(ctx, o, lp.in, "out", { blockable: false }))
        : [];
    result.push({
      out: toLegDto(lp.out, outKind),
      in: toLegDto(lp.in, inKind),
      gap_days: daysBetweenYmd(lp.out.occurred_on, lp.in.occurred_on),
      within_business_day_window: bankDateMatchesTransferDate(lp.in.occurred_on, lp.out.occurred_on),
      month_precision: mirrorLegIsMonthPrecision(outKind) || mirrorLegIsMonthPrecision(inKind),
      // Straddling linked pairs stay per-pair review: the transfer takes the checking (out)
      // date, shifting the deposit's month attribution (e.g. cuotas count one month earlier).
      month_straddle: monthStraddle,
      out_candidate_count: 1,
      in_candidate_count: 1 + outAlternatives.length,
      out_alternatives: outAlternatives,
      in_alternatives: [],
      confidence: monthStraddle || outAlternatives.length > 0 ? "ambiguous" : "high",
      blocked: false,
      blocked_reason: null,
      linked: true,
    });
  }

  for (const p of pairs) {
    if (usedOut.has(p.out.id) || usedIn.has(p.in.id)) continue;
    usedOut.add(p.out.id);
    usedIn.add(p.in.id);

    const flags = pairFlags(ctx, p.out, p.in);
    const inAlternatives = (insByOut.get(p.out.id) ?? [])
      .filter((i) => i.id !== p.in.id)
      .map((i) => alternative(ctx, p.out, i, "in", { blockable: true }));
    const outAlternatives = (outsByIn.get(p.in.id) ?? [])
      .filter((o) => o.id !== p.out.id)
      .map((o) => alternative(ctx, o, p.in, "out", { blockable: true }));
    // Month-precision pairs skip the bank-window requirement: the converted transfer carries the
    // real-day (cartola) leg's date, so cartola re-import dedupe matches same-day regardless.
    const high =
      inAlternatives.length === 0 &&
      outAlternatives.length === 0 &&
      !flags.monthStraddle &&
      (p.monthPrecision || flags.withinWindow);

    result.push({
      out: toLegDto(p.out, ctx.kindSlugFor(p.out.account_id)),
      in: toLegDto(p.in, ctx.kindSlugFor(p.in.account_id)),
      gap_days: p.gap,
      within_business_day_window: flags.withinWindow,
      month_precision: p.monthPrecision,
      month_straddle: flags.monthStraddle,
      out_candidate_count: 1 + inAlternatives.length,
      in_candidate_count: 1 + outAlternatives.length,
      out_alternatives: outAlternatives,
      in_alternatives: inAlternatives,
      confidence: high ? "high" : "ambiguous",
      blocked: flags.blocked,
      blocked_reason: flags.blocked ? "checking_inflow_month_straddle" : null,
      linked: false,
    });
  }
  return result;
}

export type ResolvedMirrorPair = {
  out_movement_id: number;
  in_movement_id: number;
  blocked: boolean;
  blocked_reason: MirrorPairBlockedReason | null;
};

/**
 * The convertible pair a request names: a current candidate, or one of an ambiguous candidate's
 * alternatives in place of its greedy pick on that side. Null when the pair is not offered.
 */
export function resolveMirrorPairRef(
  candidates: readonly MirrorPairCandidate[],
  ref: { out_movement_id: number; in_movement_id: number }
): ResolvedMirrorPair | null {
  for (const c of candidates) {
    if (c.out.movement_id === ref.out_movement_id && c.in.movement_id === ref.in_movement_id) {
      return { ...ref, blocked: c.blocked, blocked_reason: c.blocked_reason };
    }
  }
  for (const c of candidates) {
    if (c.confidence !== "ambiguous") continue;
    const alt =
      c.in.movement_id === ref.in_movement_id
        ? c.out_alternatives.find((a) => a.leg.movement_id === ref.out_movement_id)
        : c.out.movement_id === ref.out_movement_id
          ? c.in_alternatives.find((a) => a.leg.movement_id === ref.in_movement_id)
          : undefined;
    if (alt) return { ...ref, blocked: alt.blocked, blocked_reason: alt.blocked_reason };
  }
  return null;
}

/** Rejected pairs whose both legs still exist (FK cascade removes the rest), for the panel's restore list. */
export function listRejectedMirrorPairs(): RejectedMirrorPair[] {
  const rows = db
    .prepare(
      `SELECT r.out_movement_id, r.in_movement_id, r.created_at,
              mo.account_id AS out_account_id, ao.name AS out_account_name,
              mo.occurred_on AS out_occurred_on, mo.amount AS out_amount_clp,
              mo.units_delta AS out_units_delta, mo.note AS out_note,
              mi.account_id AS in_account_id, ai.name AS in_account_name,
              mi.occurred_on AS in_occurred_on, mi.amount AS in_amount_clp,
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
