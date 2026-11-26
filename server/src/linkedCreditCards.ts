import { assertValuationCurrency } from "./valuationValue.js";
import { db } from "./db.js";
import { groupAccountIds, nettedGroup } from "./navTreeModel.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { historyTierMemo, historyTrimByDay } from "./cacheRegistry.js";
import { postCloseLiveBalanceAdjustmentClp } from "./ccBillingBalances.js";
import { creditCardBillingBalanceTotalClpAsOf } from "./ccCreditCardValuations.js";
import { planCount } from "./cards/purchases.js";
import { ccHasNativeOwedAnchors, ccOwedClpAtYmd } from "./ccOwedWalk.js";
import { latestLiabilityValuationRowForSnapshot } from "./valuationLatest.js";

/**
 * The cards a cash bucket nets and what they owe on a date. Reads the netting roles and the
 * cards' own balances only (no nav tree), so the cash netting and the group consolidation sit
 * below the tree builders.
 */
export type CreditCardCashLinkRow = {
  liability_account_id: number;
  operational_account_id: number;
  name: string;
  clp: number;
};

type LinkedCreditCardMasterRow = {
  account_id: number;
  name: string;
};

/**
 * The cards the cash bucket nets: the members of the group the tree's netting roles point at
 * (`nets_linked_group_id`, one group — the linked total below is one sum), those counted in totals.
 */
function linkedCreditCardMasters(): LinkedCreditCardMasterRow[] {
  const ids = groupAccountIds(nettedGroup().id);
  if (!ids.length) return [];
  return db
    .prepare(
      `SELECT id AS account_id, name FROM accounts
       WHERE id IN (${ids.map(() => "?").join(",")}) AND exclude_from_group_totals = 0
       ORDER BY name, id`
    )
    .all(...ids) as LinkedCreditCardMasterRow[];
}

/**
 * Linked CC balance for one card. Today+: billing **balance total** (Detalle por mes) when
 * the ledger exists, else the liability snapshot. Historical dates: stored month-end anchor
 * **plus per-day post-anchor line activity** (charges +, PAGOs −) — the same daily
 * owed-on-date convention as `accountMarkClpAtYmd`'s CC branch, so the cash_eqs netting in
 * daily series moves the day a purchase/PAGO lands (month-end values are unchanged: the
 * carry window is empty there, and stored month-ends equal the billing balance total).
 */
function linkedCreditCardBalanceTotalClpAsOf(
  master: LinkedCreditCardMasterRow,
  valuationRowsAsc: { as_of_date: string; value_clp: number }[],
  asOfYmd: string,
  todayYmd: string
): number | null {
  const masterId = master.account_id;
  if (asOfYmd >= todayYmd) {
    // Same funnel as the CC card itself (`latestCreditCardDisplayedBalance`): today is the
    // evidence walk, with the live billing formula only as its no-anchor fallback. Netting
    // the live number here while the card walked put the frame gap on the Efectivo card as a
    // phantom day move (−2x.xxx on 2026-07-23, a day with no cash or card activity).
    return (
      latestLiabilityValuationRowForSnapshot(masterId, "credit_card", asOfYmd)?.value_clp ?? null
    );
  }
  // The per-currency walk valued at the day's rate (`ccOwedWalk.ts`), the card's own value.
  if (ccHasNativeOwedAnchors(masterId)) {
    const walked = ccOwedClpAtYmd(masterId, asOfYmd);
    if (walked) return walked.value_clp;
  }
  const anchor = latestValuationRowFromAscRows(valuationRowsAsc, asOfYmd);
  if (anchor != null) {
    return anchor.as_of_date < asOfYmd
      ? Math.round(
          anchor.value_clp +
            postCloseLiveBalanceAdjustmentClp(masterId, anchor.as_of_date, asOfYmd, {
              includeInstallmentPurchases: true,
            })
        )
      : anchor.value_clp;
  }
  if (planCount(masterId) > 0) {
    const billing = creditCardBillingBalanceTotalClpAsOf(masterId, asOfYmd);
    if (billing != null && Number.isFinite(billing.value_clp)) return billing.value_clp;
  }
  return null;
}

/** Sum linked tarjeta balances (billing balance total; same number on Ahorros card footer). */
export function linkedCreditCardClpForCashCardAsOf(asOfYmd: string): number {
  return linkedCreditCardClpForCashCardByDates([asOfYmd]).get(asOfYmd) ?? 0;
}

const stmtValuationsOnOrBefore = db.prepare(
  `SELECT as_of_date, value AS value_clp, currency FROM valuations
   WHERE account_id = ? AND as_of_date <= ?
   ORDER BY as_of_date ASC`
);

function latestValuationRowFromAscRows(
  rows: { as_of_date: string; value_clp: number }[],
  asOfYmd: string
): { as_of_date: string; value_clp: number } | null {
  let last: { as_of_date: string; value_clp: number } | null = null;
  for (const r of rows) {
    if (r.as_of_date > asOfYmd) break;
    if (Number.isFinite(r.value_clp)) last = r;
  }
  return last;
}

/**
 * A past day's linked-card total reads the cards' owed on that day; a card with no anchor yet
 * values its foreign lines at a later pay-by rate, hence the 75 days (`accountMarkClpAtYmd.ts`).
 * The set of linked cards is a setting: its tables log undated writes, which drop the tier whole.
 */
const LINKED_CC_BY_DAY = historyTrimByDay<string, number>((ymd) => ymd, 75);

/**
 * Sum linked CC balances for many chart dates (one view list + one valuation read per card).
 * A day before Chile today reads no quote, so its sum is kept in the history tier
 * (`cacheRegistry.ts`) across live-quote ticks.
 */
export function linkedCreditCardClpForCashCardByDates(datesAsc: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of datesAsc) out.set(d, 0);
  if (!datesAsc.length) return out;
  const today = chileCalendarTodayYmd();
  const memo = historyTierMemo<string, number>("linked_cc_clp_by_day", LINKED_CC_BY_DAY);
  const toBuild = datesAsc.filter((d) => d >= today || !memo.has(d));
  const built = linkedCreditCardClpForCashCardByDatesUncached(toBuild, today);
  for (const d of datesAsc) {
    const past = d < today;
    const v = past && memo.has(d) ? memo.get(d)! : built.get(d)!;
    if (past) memo.set(d, v);
    out.set(d, v);
  }
  return out;
}

function linkedCreditCardClpForCashCardByDatesUncached(
  datesAsc: string[],
  today: string
): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of datesAsc) out.set(d, 0);
  if (!datesAsc.length) return out;

  const masters = linkedCreditCardMasters();
  if (!masters.length) return out;

  const maxDate = [...datesAsc].sort().at(-1)!;
  const perMasterRows = masters.map((master) => {
    const rows = stmtValuationsOnOrBefore.all(master.account_id, maxDate) as {
      as_of_date: string;
      value_clp: number;
      currency: string;
    }[];
    for (const r of rows) assertValuationCurrency(r.currency, "clp", "liabilityTree cc byDates");
    return { master, rows };
  });

  for (const d of datesAsc) {
    let sum = 0;
    for (const { master, rows } of perMasterRows) {
      const clp = linkedCreditCardBalanceTotalClpAsOf(master, rows, d, today);
      if (clp != null && Number.isFinite(clp)) sum += clp;
    }
    out.set(d, sum);
  }
  return out;
}

/** Pasivos > tarjeta de crédito → cards linked under liabilities_credit_card. */
export function creditCardLiabilityLinkRowsForCashCard(asOfYmd: string): CreditCardCashLinkRow[] {
  const out: CreditCardCashLinkRow[] = [];
  const today = chileCalendarTodayYmd();
  for (const master of linkedCreditCardMasters()) {
    const rows = stmtValuationsOnOrBefore.all(master.account_id, asOfYmd) as {
      as_of_date: string;
      value_clp: number;
      currency: string;
    }[];
    for (const r of rows) assertValuationCurrency(r.currency, "clp", "liabilityTree cc links");
    const clp = linkedCreditCardBalanceTotalClpAsOf(master, rows, asOfYmd, today);
    if (clp == null || !Number.isFinite(clp)) continue;
    out.push({
      liability_account_id: master.account_id,
      operational_account_id: master.account_id,
      name: master.name,
      clp,
    });
  }
  return out;
}
