/**
 * The basket page's «at a glance» block (`basket_glance` on the nav-context payload of a group
 * declared a basket, `portfolio_groups.basket`): a portfolio group holding a few positions that
 * are one investment (IPSA: the ETF + its fee caja; SOXX: SOXX + SOXQ), shown as one position.
 * Every figure, share and comparison is decided here; the client only picks and formats.
 *
 * Sources, one definition each:
 * - value today and día / mes / año: the group's own page card (`card_metrics_by_slug[slug]`:
 *   `value.parent`, the `parent` variant's `delta_period`, `parent_pct`) — the numbers the strip
 *   shows beside it in the same payload;
 * - members: the group node's `member_account_ids` (the tree's membership), their dashboard rows
 *   (value, units) and, for a member holding units today, its own position glance
 *   (`buildPositionGlanceForAccount`: today's price, the FIFO average cost, the price's side);
 * - composition: Σ over the members on the last day the basket held anything of the account
 *   position's inputs (`accountValueAt`, the personal deposit timeline, the APV state bonus
 *   timeline, `totalDividendsInUnitForAccount`) summed, then `compositionFromParts` (the account
 *   composition's own rule), price being the rest, so value = Σ segments;
 * - sparklines: the group's own daily returns chained (`groupDailyPctPoints` → `chainDailyReturns`,
 *   the level series the «Tus portafolios» benchmark reads), on the position sparkline's axes;
 * - held stretches: the union of the members' — a unit position's from its unit ledger
 *   (`positionHeldSpans`), a cash ledger's from its balance and an option's from its contracts
 *   after each movement day.
 */
import type {
  PositionGlanceDirection,
  PositionGlanceDto,
  PositionGlancePeriodDto,
  PositionGlanceSparkRange,
} from "nw-tracker-contracts/dto/accounts";
import type { AccountPositionSnapshot } from "nw-tracker-contracts/dto/core";
import type { NavCardMetricsDto } from "nw-tracker-contracts/dto/dashboard";
import type {
  BasketGlanceDto,
  BasketGlanceMemberDto,
  BasketGlanceSparkPointDto,
  BasketGlanceSparklineDto,
} from "nw-tracker-contracts/dto/groups";
import { getMergedDisplayDepositInflowEventsForAccount, getStateContributionInflowEventsForAccount } from "./accountDeposits.js";
import { accountProfileOptional } from "./accountProfile.js";
import { accountHoldingQtyAt, accountValueAt } from "./accountValue.js";
import { chainDailyReturns } from "./benchmarkLevels.js";
import { chileCalendarAddDays, chileWallClockAt } from "./chileDate.js";
import type { DailyPctPoint } from "./dailyPctSeries.js";
import { db } from "./db.js";
import { currencySmallestCoin } from "./displayUnits.js";
import { totalDividendsInUnitForAccount } from "./equityReturns.js";
import {
  buildPositionGlanceForAccount,
  compositionFromParts,
  isUnitPositionAccount,
  positionHeldSpans,
  POSITION_GLANCE_SPARK_MAX_POINTS,
  POSITION_GLANCE_SPARK_RANGES,
  sampleIndices,
  type HeldSpan,
} from "./positionGlance.js";
import { flowEventInUnit, type CurrencyCode } from "./rates.js";

const DAY_MS = 86_400_000;
const dayNumber = (ymd: string): number => {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  if (!Number.isFinite(t)) throw new Error(`basketGlance: invalid date ${JSON.stringify(ymd)}`);
  return Math.round(t / DAY_MS);
};
const ymdOfDayNumber = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** What the payload already holds for a member account: its dashboard row (in the payload's unit). */
export type BasketMemberRow = {
  account_id: number;
  name: string;
  current_value: number | null;
  exclude_from_group_totals?: number | null;
  position?: AccountPositionSnapshot | null;
  delta_day?: number | null;
  delta_month?: number | null;
  delta_year?: number | null;
  pct_day?: number | null;
  pct_month?: number | null;
  pct_year?: number | null;
};

export type BasketGlanceInputs = {
  slug: string;
  title: string;
  unit: string;
  /** The group node's members (`member_account_ids`). */
  memberAccountIds: readonly number[];
  /** The payload's dashboard rows (at least every member's). */
  rows: readonly BasketMemberRow[];
  /** The group's own card figures (`card_metrics_by_slug[slug]`). */
  card: NavCardMetricsDto;
  /** The group's full-history daily returns (`groupDailyPctPoints`); null when it has none. */
  dailyPct: readonly DailyPctPoint[] | null;
  now?: Date;
};

function direction(x: number | null): PositionGlanceDirection {
  if (x == null || !Number.isFinite(x) || x === 0) return "flat";
  return x > 0 ? "up" : "down";
}

const stmtMovementDays = db.prepare(
  `SELECT DISTINCT substr(occurred_on, 1, 10) AS day FROM movements
   WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?
   ORDER BY day`
);

/**
 * The stretches a cash or option member held something: its quantity (`accountHoldingQtyAt`) at
 * the end of each day a movement touched it — a cash balance, or the contracts of an option
 * (negative while written) —; a stretch starts the day the quantity turns non-zero (beyond half
 * the currency's smallest coin, or half a contract) and ends the day it returns to zero (null
 * while held today).
 */
function ledgerHeldSpans(accountId: number, today: string): HeldSpan[] {
  const profile = accountProfileOptional(accountId);
  const holding = profile?.holding;
  if (!holding || (holding.kind !== "currency" && holding.kind !== "option")) {
    throw new Error(`Basket member ${accountId} is neither a unit position, a cash ledger nor an option`);
  }
  const eps = holding.kind === "currency" ? currencySmallestCoin(holding.code) / 2 : 0.5;
  const days = (stmtMovementDays.all(accountId, accountId, accountId) as { day: string }[])
    .map((r) => r.day)
    .filter((d) => d <= today);
  const spans: HeldSpan[] = [];
  let held = false;
  for (const day of days) {
    const q = accountHoldingQtyAt(accountId, day);
    const now = q != null && Math.abs(q.qty) > eps;
    if (!held && now) spans.push({ from: day, to: null });
    else if (held && !now) spans[spans.length - 1]!.to = day;
    held = now;
  }
  return spans;
}

/** A member's held stretches: its unit ledger's, else its cash balance's or option contracts'. */
export function memberHeldSpans(accountId: number, today: string): HeldSpan[] {
  return isUnitPositionAccount(accountId) ? positionHeldSpans(accountId) : ledgerHeldSpans(accountId, today);
}

/** The union of stretches (a stretch ending the day another starts joins it). */
export function unionHeldSpans(spans: readonly HeldSpan[]): HeldSpan[] {
  const sorted = [...spans].sort((a, b) => a.from.localeCompare(b.from));
  const out: HeldSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && (last.to == null || s.from <= last.to)) {
      if (last.to != null && (s.to == null || s.to > last.to)) last.to = s.to;
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

/**
 * Σ over the members of the account position's inputs on `asOf`, in `unit` — what
 * `compositionFromParts` reads for a set of accounts (the basket glance and the investment group
 * glance, `groupGlance.ts`). `heldOn(id)` says whether a member held something on `asOf`: a member
 * that did must have a value that day (throws), one that did not may have none.
 */
export function basketPositionOn(
  memberIds: readonly number[],
  heldOn: (accountId: number) => boolean,
  asOf: string,
  unit: CurrencyCode,
  now: Date
): { value: number; deposited: number; stateBonus: number | null; dividends: number } {
  let value = 0;
  let deposited = 0;
  let stateBonus: number | null = null;
  let dividends = 0;
  for (const id of memberIds) {
    const v = accountValueAt(id, asOf, unit, { now });
    if (v == null) {
      if (heldOn(id)) throw new Error(`Basket member ${id}: no value on ${asOf}, a day it held something`);
    } else {
      value += v.value;
    }
    for (const e of getMergedDisplayDepositInflowEventsForAccount(id)) {
      if (e.occurred_on <= asOf) deposited += flowEventInUnit(e, unit);
    }
    const bonus = getStateContributionInflowEventsForAccount(id);
    if (bonus.length > 0) {
      stateBonus ??= 0;
      for (const e of bonus) if (e.occurred_on <= asOf) stateBonus += flowEventInUnit(e, unit);
    }
    dividends += totalDividendsInUnitForAccount(id, unit, asOf);
  }
  return { value, deposited, stateBonus, dividends };
}

/**
 * The members' summed composition on the last day any of them held something (today while one
 * does; the day before the last stretch ended otherwise), by the account composition's own rule
 * (`compositionFromParts` fed {@link basketPositionOn}). Null when none ever held anything, or as
 * the account's is (a deposited figure that cannot be computed). `spansById` / `heldSpans`: each
 * member's held stretches and their union ({@link memberHeldSpans}, {@link unionHeldSpans}).
 */
export function compositionOnLastHeldDay(
  label: string,
  memberIds: readonly number[],
  spansById: ReadonlyMap<number, readonly HeldSpan[]>,
  heldSpans: readonly HeldSpan[],
  unit: string,
  today: string,
  now: Date
): PositionGlanceDto["composition"] {
  const last = heldSpans[heldSpans.length - 1];
  if (last == null) return null;
  const asOf = last.to == null ? today : chileCalendarAddDays(last.to, -1);
  const heldOn = (id: number) => (spansById.get(id) ?? []).some((s) => s.from <= asOf && (s.to == null || s.to > asOf));
  const pos = basketPositionOn(memberIds, heldOn, asOf, unit as CurrencyCode, now);
  return compositionFromParts({ accountLabel: label, asOf, isToday: asOf === today, unit, ...pos });
}

/** The index level on or before `ymd` (null before the first). */
function levelOnOrBefore(dates: readonly string[], levels: readonly number[], ymd: string): number | null {
  let out: number | null = null;
  for (let i = 0; i < dates.length && dates[i]! <= ymd; i++) out = levels[i]!;
  return out;
}

/** One range's index sparkline, on the position sparkline's axis (N days ending today; `total` from the first level). */
export function basketSparklineFor(
  range: PositionGlanceSparkRange,
  days: number,
  series: readonly { date: string; level: number }[],
  costLevel: number | null,
  today: string,
  heldSpans: readonly HeldSpan[]
): BasketGlanceSparklineDto {
  const toN = Math.max(dayNumber(today), dayNumber(series[series.length - 1]!.date));
  const fromN = days > 0 ? toN - (days - 1) : dayNumber(series[0]!.date);
  const from = ymdOfDayNumber(fromN);
  const inRange = series.filter((p) => p.date >= from);
  const sampled = sampleIndices(inRange.length, POSITION_GLANCE_SPARK_MAX_POINTS).map((i) => inRange[i]!);
  const levels = sampled.map((p) => p.level);
  if (costLevel != null) levels.push(costLevel);
  const lo = Math.min(...levels);
  const hi = Math.max(...levels);
  const ySpan = hi - lo;
  const yOf = (level: number) => (ySpan > 0 ? (level - lo) / ySpan : 0.5);
  const xSpan = toN - fromN;
  const points: BasketGlanceSparkPointDto[] = sampled.map((p) => ({
    date: p.date,
    level: p.level,
    x: xSpan > 0 ? (dayNumber(p.date) - fromN) / xSpan : 1,
    y: yOf(p.level),
  }));
  const xOfDay = (n: number) => (xSpan > 0 ? Math.min(1, Math.max(0, (n - fromN) / xSpan)) : 1);
  const held = heldSpans
    .map((h) => ({ start: xOfDay(dayNumber(h.from)), end: xOfDay(h.to == null ? toN : dayNumber(h.to)) }))
    .filter((h) => h.end > h.start || (xSpan === 0 && h.end === 1));
  return {
    range,
    from,
    to: ymdOfDayNumber(toN),
    points,
    low: lo,
    high: hi,
    cost_y: costLevel == null ? null : yOf(costLevel),
    held,
  };
}

/** The block for a basket group as of now. */
export function buildBasketGlance(inp: BasketGlanceInputs): BasketGlanceDto {
  const now = inp.now ?? new Date();
  const today = chileWallClockAt(now).ymd;
  const money = (value: number) => ({ value, currency: inp.unit });
  const rowById = new Map(inp.rows.map((r) => [r.account_id, r]));
  const value = inp.card.value.parent;
  if (value == null || !Number.isFinite(value)) throw new Error(`Basket ${inp.slug}: its card has no value today`);

  // Members: the card's (excluded-from-totals accounts are not in its value).
  const memberIds = [...new Set(inp.memberAccountIds)].filter((id) => {
    const r = rowById.get(id);
    if (!r) throw new Error(`Basket ${inp.slug}: member ${id} has no dashboard row`);
    return !r.exclude_from_group_totals;
  });
  if (memberIds.length === 0) throw new Error(`Basket ${inp.slug}: no member accounts`);

  const spansById = new Map(memberIds.map((id) => [id, memberHeldSpans(id, today)]));
  const heldSpans = unionHeldSpans([...spansById.values()].flat());

  const positive = memberIds.reduce((s, id) => {
    const v = rowById.get(id)!.current_value;
    if (v == null || !Number.isFinite(v)) throw new Error(`Basket ${inp.slug}: member ${id} has no value today`);
    return s + Math.max(0, v);
  }, 0);
  const members: BasketGlanceMemberDto[] = memberIds.map((id) => {
    const r = rowById.get(id)!;
    const v = r.current_value!;
    const spans = spansById.get(id)!;
    const held = spans.length > 0 && spans[spans.length - 1]!.to == null;
    const pos = r.position ?? null;
    const units = pos != null && pos.units != null ? { amount: pos.units, kind: pos.units_kind } : null;
    let quote: BasketGlanceMemberDto["quote"] = null;
    if (held && isUnitPositionAccount(id)) {
      const g = buildPositionGlanceForAccount(id, { unit: inp.unit, position: pos, row: r }, now);
      if (g == null) throw new Error(`Basket ${inp.slug}: member ${id} holds units but has no position glance`);
      quote = {
        price: g.quote.price,
        price_as_of: g.quote.price_as_of,
        average_cost: g.track.cost.price,
        price_vs_cost: g.price_vs_cost,
      };
    }
    return {
      account_id: id,
      name: r.name,
      route_path: `/account/${id}`,
      value: money(v),
      share: positive > 0 && v > 0 ? v / positive : 0,
      held,
      units,
      quote,
    };
  });
  members.sort((a, b) => b.value.value - a.value.value || a.name.localeCompare(b.name));

  // Composition on the basket's last day holding anything.
  const composition = compositionOnLastHeldDay(`Basket ${inp.slug}`, memberIds, spansById, heldSpans, inp.unit, today, now);

  // Sparklines: the group's daily returns chained into an index.
  const { dates, levels } = chainDailyReturns(inp.dailyPct ?? []);
  const series = dates.map((date, i) => ({ date, level: levels[i]! }));
  let sparklines: BasketGlanceSparklineDto[] = [];
  if (series.length > 0) {
    let costLevel: number | null = null;
    if (composition != null && composition.value.value > 0 && composition.deposited.value > 0) {
      const at = levelOnOrBefore(dates, levels, composition.as_of);
      if (at != null) costLevel = (at * composition.deposited.value) / composition.value.value;
    }
    sparklines = POSITION_GLANCE_SPARK_RANGES.map(({ range, days }) =>
      basketSparklineFor(range, days, series, costLevel, today, heldSpans)
    );
  }

  // Periods: the group's own card.
  const pl = (k: "day" | "month" | "year") => inp.card.parent[k].delta_period;
  const largest = Math.max(
    ...(["day", "month", "year"] as const).map((k) => {
      const x = pl(k);
      return x != null && Number.isFinite(x) ? Math.abs(x) : 0;
    })
  );
  const period = (k: "day" | "month" | "year"): PositionGlancePeriodDto => {
    const x = pl(k);
    const known = x != null && Number.isFinite(x);
    const pct = inp.card.parent_pct[k].value;
    return {
      pl: known ? money(x) : null,
      pct: pct != null && Number.isFinite(pct) ? pct : null,
      share: known && largest > 0 ? Math.abs(x) / largest : 0,
      direction: direction(known ? x : null),
    };
  };

  return {
    slug: inp.slug,
    title: inp.title,
    unit: inp.unit,
    value: money(value),
    members,
    composition,
    sparklines,
    periods: { day: period("day"), month: period("month"), year: period("year") },
  };
}
