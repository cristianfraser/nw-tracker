/**
 * Demo arrivals (docs/demo-arrivals-plan.md): when a visitor wakes the hosted demo, one to three
 * new card expenses land in a card's open facturación over the next couple of minutes, so an open
 * tab shows what a bank listing delivering movements looks like. Demo only: nothing here runs
 * unless `demoModeEnabled()`.
 *
 * What arrives is read from the database, not from the simulator, so it follows whatever story is
 * generated: the card is the billing card with the most one-shot purchases lately, the merchant one
 * of its recent one-shot merchants (subscriptions, monthly bills, declared recurring payments and merchants already
 * on the card today left out), the amount one of that merchant's past amounts × 0,8–1,2 in the
 * line's own currency, the day the Chile day. The line goes through the card-line funnel like any
 * listing line (`importCcListingLines`), the database is marked written (so the demo's restore
 * takes it back, `demoWritable.ts`) and the live-quotes stamp publishes a move of everything, which
 * makes open tabs refetch.
 *
 * An arrival is an optional show: one that finds no candidate, is skipped as a duplicate or throws
 * is logged and dropped, never retried.
 */
import { importCcListingLines } from "./accountImports.js";
import { cardStoppedBilling } from "./cards/lifecycle.js";
import { findLines, purchaseDateIsoFromLine, supersededOneShotLineIds } from "./cards/purchases.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { db } from "./db.js";
import { onDemoMarketWake } from "./demoMarketActivity.js";
import { demoModeEnabled } from "./demoModeFlag.js";
import { markDemoWritten } from "./demoWritable.js";
import { stream, type Rng } from "./demoData/rng.js";
import { roundToCurrency } from "./displayUnits.js";
import { whenNoApiRequestsInFlight } from "./apiRequestsInFlight.js";
import { noteLiveQuotesChanged } from "./liveQuotesStamp.js";
import { recurringPatternIndex } from "./recurringPaymentMatch.js";

export const DEMO_ARRIVAL_BATCHES_PER_DAY = 6;
/** A batch is 1 to this many arrivals. */
export const DEMO_ARRIVALS_PER_BATCH_MAX = 3;
/** The first arrival lands this long after the wake, the next ones this far apart (ms). */
export const DEMO_ARRIVAL_FIRST_DELAY_MS: readonly [number, number] = [20_000, 40_000];
export const DEMO_ARRIVAL_GAP_MS: readonly [number, number] = [30_000, 60_000];
/** The card is the one with the most one-shot purchases in this many days. */
export const DEMO_ARRIVAL_CARD_WINDOW_DAYS = 60;
/** Candidates are the card's one-shot purchases of this many days. */
export const DEMO_ARRIVAL_CANDIDATE_WINDOW_DAYS = 120;
/** An arrival's amount is a past amount × a factor in this range. */
export const DEMO_ARRIVAL_AMOUNT_FACTOR: readonly [number, number] = [0.8, 1.2];
/** A merchant billing exactly once a month in this many months is a bill, not a purchase to repeat. */
export const DEMO_ARRIVAL_MONTHLY_BILL_MONTHS = 3;

const RNG_SEED = 0;

// --- (a) The schedule -----------------------------------------------------------------------

export type DemoArrivalScheduleState = {
  /** The Chile day `batchesToday` counts. */
  day: string | null;
  batchesToday: number;
  /** A batch is still delivering. */
  pending: boolean;
};

export type DemoArrivalBatchDecision =
  | { start: true; batchNo: number }
  | { start: false; reason: "pending" | "daily_cap" };

/** Pure: does a wake on `todayYmd` start a batch, and which one of the day is it (1-based)? */
export function demoArrivalBatchDecision(state: DemoArrivalScheduleState, todayYmd: string): DemoArrivalBatchDecision {
  if (state.pending) return { start: false, reason: "pending" };
  const done = state.day === todayYmd ? state.batchesToday : 0;
  if (done >= DEMO_ARRIVAL_BATCHES_PER_DAY) return { start: false, reason: "daily_cap" };
  return { start: true, batchNo: done + 1 };
}

/** Pure: the waits of a batch, each from the previous arrival (the first from the wake), in ms. */
export function demoArrivalBatchDelaysMs(rng: Rng): number[] {
  const count = rng.int(1, DEMO_ARRIVALS_PER_BATCH_MAX);
  const delays = [Math.round(rng.range(DEMO_ARRIVAL_FIRST_DELAY_MS[0], DEMO_ARRIVAL_FIRST_DELAY_MS[1]))];
  while (delays.length < count) delays.push(Math.round(rng.range(DEMO_ARRIVAL_GAP_MS[0], DEMO_ARRIVAL_GAP_MS[1])));
  return delays;
}

/** The seeded stream of one batch's schedule or of one of its arrivals. */
export function demoArrivalRng(day: string, batchNo: number, what: "schedule" | number): Rng {
  return stream(RNG_SEED, `demo-arrivals|${day}|${batchNo}|${what}`);
}

// --- (b) The candidates ---------------------------------------------------------------------

/** A one-shot purchase line of the card (positive, no cuotas), its day ISO. */
export type DemoArrivalHistoryLine = { merchant: string; currency: string; amount: number; date: string };

export type DemoArrivalCandidate = { merchant: string; currency: string; amounts: number[] };

function merchantKey(merchant: string): string {
  return merchant.trim().toUpperCase();
}

/**
 * Pure: the card's purchases grouped by merchant and currency, left out: a merchant that billed
 * one amount in two or more months (a subscription), one that billed exactly once a month in
 * {@link DEMO_ARRIVAL_MONTHLY_BILL_MONTHS} or more months (a bill), one a declared recurring
 * payment's patterns match, one already on the card today. Sorted by merchant, then currency; amounts ascending.
 */
export function demoArrivalCandidates(
  lines: readonly DemoArrivalHistoryLine[],
  opts: { recurringPatterns: readonly (readonly string[])[]; merchantsToday: ReadonlySet<string> }
): DemoArrivalCandidate[] {
  const today = new Set([...opts.merchantsToday].map(merchantKey));
  const byMerchant = new Map<string, DemoArrivalHistoryLine[]>();
  for (const l of lines) {
    const k = merchantKey(l.merchant);
    if (k === "") continue;
    const group = byMerchant.get(k);
    if (group) group.push(l);
    else byMerchant.set(k, [l]);
  }
  const out: DemoArrivalCandidate[] = [];
  for (const [k, group] of byMerchant) {
    if (today.has(k)) continue;
    const merchant = group[0]!.merchant.trim();
    if (opts.recurringPatterns.some((patterns) => recurringPatternIndex({ patterns: [...patterns] }, merchant) >= 0)) continue;
    const monthsByAmount = new Map<string, Set<string>>();
    for (const l of group) {
      const a = `${l.currency}|${l.amount}`;
      const months = monthsByAmount.get(a) ?? new Set<string>();
      months.add(l.date.slice(0, 7));
      monthsByAmount.set(a, months);
    }
    if ([...monthsByAmount.values()].some((months) => months.size >= 2)) continue;
    // A bill whose amount moves (an indexed plan, a dividendo): once a month, month after month.
    const perMonth = new Map<string, number>();
    for (const l of group) perMonth.set(l.date.slice(0, 7), (perMonth.get(l.date.slice(0, 7)) ?? 0) + 1);
    if (perMonth.size >= DEMO_ARRIVAL_MONTHLY_BILL_MONTHS && [...perMonth.values()].every((n) => n === 1)) continue;
    const byCurrency = new Map<string, number[]>();
    for (const l of group) byCurrency.set(l.currency, [...(byCurrency.get(l.currency) ?? []), l.amount]);
    for (const [currency, amounts] of byCurrency) {
      out.push({ merchant, currency, amounts: [...amounts].sort((a, b) => a - b) });
    }
  }
  return out.sort((a, b) => (a.merchant < b.merchant ? -1 : a.merchant > b.merchant ? 1 : a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
}

// --- (c) The draw ---------------------------------------------------------------------------

export type DemoArrivalDraw = { merchant: string; currency: string; amount: number; date: string };

/**
 * Pure but for the coin (read from `currencies`): one candidate, one of its amounts × the factor,
 * rounded to the currency's coin, dated `todayYmd`. Null when there is no candidate (or the amount
 * rounds to nothing).
 */
export function drawDemoArrival(
  candidates: readonly DemoArrivalCandidate[],
  rng: Rng,
  todayYmd: string
): DemoArrivalDraw | null {
  if (candidates.length === 0) return null;
  const c = rng.pick(candidates);
  const base = rng.pick(c.amounts);
  const amount = roundToCurrency(base * rng.range(DEMO_ARRIVAL_AMOUNT_FACTOR[0], DEMO_ARRIVAL_AMOUNT_FACTOR[1]), c.currency);
  if (!(amount > 0)) return null;
  return { merchant: c.merchant, currency: c.currency, amount, date: todayYmd };
}

// --- Loading from the database --------------------------------------------------------------

type CardWindowLines = {
  /** One-shot purchases: stored kind `card_purchase`, positive, no cuotas, no plan counting the purchase. */
  purchases: DemoArrivalHistoryLine[];
  /** Every merchant on the card on `todayYmd`, whatever the line. */
  merchantsToday: Set<string>;
};

/** The card's lines from `fromYmd` through `todayYmd`, read through the purchases module. */
function cardWindowLines(cardId: number, fromYmd: string, todayYmd: string): CardWindowLines {
  const superseded = supersededOneShotLineIds(cardId);
  const purchases: DemoArrivalHistoryLine[] = [];
  const merchantsToday = new Set<string>();
  for (const l of findLines({ accountId: cardId, installmentFlag: 0 })) {
    const date = purchaseDateIsoFromLine(l.transaction_date, l.posting_date);
    if (date == null || date < fromYmd || date > todayYmd || l.merchant == null) continue;
    if (date === todayYmd) merchantsToday.add(l.merchant);
    if (l.kind !== "card_purchase" || l.cuota_purchase_kind != null || l.amount == null || !(l.amount > 0)) continue;
    if (superseded.has(l.line_id)) continue;
    purchases.push({ merchant: l.merchant, currency: l.currency, amount: l.amount, date });
  }
  return { purchases, merchantsToday };
}

/**
 * The card an arrival lands on: among the masters that still bill, the one with the most one-shot
 * purchases in the last {@link DEMO_ARRIVAL_CARD_WINDOW_DAYS} days — the card the story spends on,
 * whether or not its issuer has an unbilled listing (the line is what a hand paste of the bank's
 * page would add); ties go to the lower id. Null when none has any.
 */
export function demoArrivalCardId(todayYmd: string): number | null {
  const from = chileCalendarAddDays(todayYmd, -DEMO_ARRIVAL_CARD_WINDOW_DAYS);
  const billingCards = listCreditCardMasterAccountIds()
    .filter((id) => !cardStoppedBilling(id))
    .sort((a, b) => a - b);
  let best: { id: number; n: number } | null = null;
  for (const id of billingCards) {
    const n = cardWindowLines(id, from, todayYmd).purchases.length;
    if (n > 0 && (best == null || n > best.n)) best = { id, n };
  }
  return best?.id ?? null;
}

/** The chosen card and its candidates for `todayYmd`; null when no card qualifies. */
export function loadDemoArrivalCandidates(todayYmd: string): { cardId: number; candidates: DemoArrivalCandidate[] } | null {
  const cardId = demoArrivalCardId(todayYmd);
  if (cardId == null) return null;
  const { purchases, merchantsToday } = cardWindowLines(
    cardId,
    chileCalendarAddDays(todayYmd, -DEMO_ARRIVAL_CANDIDATE_WINDOW_DAYS),
    todayYmd
  );
  const patternsById = new Map<number, string[]>();
  for (const r of db.prepare(`SELECT recurring_payment_id AS id, pattern FROM recurring_payment_patterns ORDER BY id, pattern`).all() as {
    id: number;
    pattern: string;
  }[]) {
    patternsById.set(r.id, [...(patternsById.get(r.id) ?? []), r.pattern]);
  }
  return { cardId, candidates: demoArrivalCandidates(purchases, { recurringPatterns: [...patternsById.values()], merchantsToday }) };
}

// --- One arrival ----------------------------------------------------------------------------

export type DemoArrivalResult =
  | { status: "inserted"; card_id: number; arrival: DemoArrivalDraw; write_ms: number }
  | { status: "skipped"; reason: "no_card" | "no_candidate" | "duplicate"; card_id: number | null; arrival: DemoArrivalDraw | null };

/**
 * One arrival: waits for the API to go quiet (requests go first), then — synchronously — draws,
 * writes the line into the card's open bucket, marks the database written and publishes the stamp.
 */
export async function runDemoArrival(rng: Rng): Promise<DemoArrivalResult> {
  await whenNoApiRequestsInFlight();
  const todayYmd = chileCalendarTodayYmd();
  const loaded = loadDemoArrivalCandidates(todayYmd);
  if (!loaded) return { status: "skipped", reason: "no_card", card_id: null, arrival: null };
  const arrival = drawDemoArrival(loaded.candidates, rng, todayYmd);
  if (!arrival) return { status: "skipped", reason: "no_candidate", card_id: loaded.cardId, arrival: null };
  const started = performance.now();
  let inserted = 0;
  try {
    inserted = importCcListingLines(
      loaded.cardId,
      {
        lines: [
          {
            transaction_date: arrival.date,
            merchant: arrival.merchant,
            currency: arrival.currency,
            amount: arrival.amount,
            raw_line: `${arrival.date} ${arrival.merchant}`,
          },
        ],
        errors: [],
      },
      "cc_web_paste"
    ).inserted;
  } finally {
    // The import writes its batch row even when it skips the line: the restore takes it back.
    markDemoWritten();
  }
  if (inserted === 0) return { status: "skipped", reason: "duplicate", card_id: loaded.cardId, arrival };
  noteLiveQuotesChanged(new Date().toISOString(), { all: true });
  return { status: "inserted", card_id: loaded.cardId, arrival, write_ms: performance.now() - started };
}

// --- The scheduler --------------------------------------------------------------------------

const schedule: DemoArrivalScheduleState = { day: null, batchesToday: 0, pending: false };
const timers = new Set<NodeJS.Timeout>();

function later(ms: number, fn: () => void): void {
  const t = setTimeout(() => {
    timers.delete(t);
    fn();
  }, ms);
  t.unref();
  timers.add(t);
}

async function runAndLog(rng: Rng): Promise<void> {
  try {
    const r = await runDemoArrival(rng);
    if (r.status === "inserted") {
      console.log(
        `demo arrivals: ${r.arrival.merchant} ${r.arrival.amount} ${r.arrival.currency} on card ${r.card_id} (${r.write_ms.toFixed(0)} ms)`
      );
    } else {
      console.log(`demo arrivals: skipped (${r.reason}${r.arrival ? `: ${r.arrival.merchant} ${r.arrival.amount} ${r.arrival.currency}` : ""})`);
    }
  } catch (e) {
    console.error(`demo arrivals: arrival failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** A wake: start a batch when the schedule allows one. */
export function startDemoArrivalBatch(todayYmd: string = chileCalendarTodayYmd()): DemoArrivalBatchDecision {
  const decision = demoArrivalBatchDecision(schedule, todayYmd);
  if (!decision.start) return decision;
  schedule.day = todayYmd;
  schedule.batchesToday = decision.batchNo;
  schedule.pending = true;
  const delays = demoArrivalBatchDelaysMs(demoArrivalRng(todayYmd, decision.batchNo, "schedule"));
  const step = (i: number) => {
    later(delays[i]!, () => {
      void runAndLog(demoArrivalRng(todayYmd, decision.batchNo, i)).finally(() => {
        if (i + 1 < delays.length) step(i + 1);
        else schedule.pending = false;
      });
    });
  };
  step(0);
  console.log(`demo arrivals: batch ${decision.batchNo} of ${todayYmd}, ${delays.length} arrival(s)`);
  return decision;
}

/** Boot: each demo wake starts a batch. A no-op on a personal instance. */
export function startDemoArrivals(): void {
  if (!demoModeEnabled()) return;
  onDemoMarketWake(() => {
    startDemoArrivalBatch();
  });
}

/** Tests: forget the schedule and stop every pending timer. */
export function resetDemoArrivalsForTest(): void {
  for (const t of timers) clearTimeout(t);
  timers.clear();
  schedule.day = null;
  schedule.batchesToday = 0;
  schedule.pending = false;
}
