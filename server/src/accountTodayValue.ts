import {
  getAccountPositionMeta,
  liveCuotaLedgerDisplayValueClp,
  liveFintualCertDisplayValueClp,
  positionMarkFromMeta,
  type AccountPositionMeta,
} from "./accountPosition.js";
import { equityTickerForAccount } from "./accountEquityTicker.js";
import {
  accountUsesEquityMtm,
  computeEquityMtmClpDisplaySync,
  equityChartZeroClpAtYmd,
} from "./brokerageEquityMtm.js";
import { checkingMovementBalanceLive } from "./checkingCartolaBalances.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { accountBucketKindSlug, accountKindSlugForAccountId } from "./accountBucket.js";
import { storedMarkValueWithFlowCarry } from "./storedMarkFlowCarry.js";
import { deptoAccountMarkClpAtYmd } from "./deptoLedgerFromMovements.js";
import {
  accountUsesCryptoMtm,
  computeCryptoMtmClpDisplaySync,
} from "./cryptoValuation.js";
import { isCuotaLedgerKindSlug } from "./cuotaLedgerAccounts.js";
import { isFintualCertV2ValuationNotes } from "./fintualFundUnitDaily.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";
import { isUsdCashKindSlug } from "./movementTransfer.js";
import { usdCashBalanceLive } from "./usdCashAccounts.js";
import { isClpCashKindSlug, clpCashBalanceLive } from "./clpCashAccounts.js";
import { latestCreditCardBillingBalanceTotalClpAndAsOfDate } from "./ccCreditCardValuations.js";
import { db } from "./db.js";
import { liveTierCached } from "./aggregationCache.js";
import {
  latestCreditCardDisplayedBalance,
  latestDisplayedBalanceForAccount,
  latestMortgageDisplayedBalance,
  latestValuationRowOnOrBeforeChileToday,
} from "./valuationLatest.js";

/**
 * An account's value today.
 * - `as_of_date`: the day the figure is dated (the bar / valor cuota day of a market mark, the
 *   stored row's day of a book mark, Chile today for a ledger balance).
 * - `priced_on`: the day its pesos were priced — the `as_of_date` of a mark priced from a
 *   market observation (cuota ledgers, Fintual cert funds, equity MTM, crypto: units × price),
 *   Chile today for everything else (ledger balances, depto UF marks, the card's owed walk,
 *   book marks carried by later flows: pesos carried to today are today's pesos). A reader that
 *   frames the pesos in another unit frames them on this day.
 */
export type AccountTodayValue = { value_clp: number; as_of_date: string; priced_on: string };

type RawTodayValue = { value_clp: number; as_of_date: string; market: boolean };

const stmtAccountMeta = db.prepare(
  `SELECT a.name, a.import_key, g.slug AS bucket_slug
   FROM accounts a
   INNER JOIN asset_groups g ON g.id = a.asset_group_id
   WHERE a.id = ?`
);

/**
 * The raw today stack (formerly `syncLatestDisplayValueClp`), in order: depto UF marks
 * (property / mortgage) → Fintual cert live → checking → USD cash → CLP cash → equity MTM →
 * crypto (throws) → AFC ledger-first → the card's owed walk → stored (with flow carry) → AFP
 * ledger → CC billing formula → valuation row.
 */
function rawTodayValue(
  accountId: number,
  categorySlug: string,
  importKey: string | null,
  name: string | null,
  today: string,
  now: Date | undefined
): RawTodayValue | null {
  const bucketKind = categorySlug ? accountBucketKindSlug(categorySlug) : "";
  // Depto UF marks first: a stale property valuation must not shadow the live ledger mark.
  if (bucketKind === "property" || bucketKind === "mortgage") {
    const depto = deptoAccountMarkClpAtYmd(bucketKind, today);
    if (depto) return { ...depto, market: false };
    if (bucketKind === "mortgage") {
      const v = latestMortgageDisplayedBalance(accountId);
      if (v?.value_clp != null && v.as_of_date) {
        return { value_clp: v.value_clp, as_of_date: v.as_of_date, market: false };
      }
    }
  }
  if (importKey && isFintualCertV2ValuationNotes(importKey)) {
    const live = liveFintualCertDisplayValueClp(accountId, importKey, name, today, now);
    if (live) return { ...live, market: true };
  }
  if (categorySlug && isMovementBalanceCashCategory(categorySlug)) {
    return { ...checkingMovementBalanceLive(accountId), market: false };
  }
  if (bucketKind && isUsdCashKindSlug(bucketKind)) {
    const live = usdCashBalanceLive(accountId);
    return { value_clp: live.value_clp, as_of_date: live.as_of_date, market: false };
  }
  if (bucketKind && isClpCashKindSlug(bucketKind)) {
    return { ...clpCashBalanceLive(accountId), market: false };
  }
  if (accountUsesEquityMtm(accountId)) {
    const eq = computeEquityMtmClpDisplaySync(accountId, now);
    if (eq != null) return { ...eq, market: true };
    // Sold out after holding shares: 0, as every historical mark of the account reads.
    if (equityChartZeroClpAtYmd(accountId, today)) {
      return { value_clp: 0, as_of_date: today, market: true };
    }
  }
  if (accountUsesCryptoMtm(accountId)) {
    // Units × close × fx is crypto's only value source — no stored-row fallback below.
    const crypto = computeCryptoMtmClpDisplaySync(accountId, now);
    if (crypto == null) {
      throw new Error(
        `crypto account ${accountId}: no coin close to mark today; crypto is valued from units × close × fx only — backfill equity_daily`
      );
    }
    return { ...crypto, market: true };
  }
  // AFC values from its cuota ledger first — the stored monthly rows are the pre-ledger
  // benchmark, not a mark (AFP keeps its stored-first order below: its sync stamps a today
  // row from the same cuotas × px, so the two agree).
  if (bucketKind === "afc") {
    const live = liveCuotaLedgerDisplayValueClp(accountId, bucketKind, today);
    if (live) return { ...live, market: true };
  }
  if (bucketKind === "credit_card") {
    // Owed on the day: the evidence walk (`ccOwedWalkClpAtYmd`), signed — negative when the
    // card is in credit — the same frame as every past day. The billing formula is a different
    // framing of the same debt and stays the fallback for a card with no walk.
    const owed = latestCreditCardDisplayedBalance(accountId, today);
    if (owed && Number.isFinite(owed.value_clp)) {
      return { value_clp: owed.value_clp, as_of_date: owed.as_of_date, market: false };
    }
    const billing = latestCreditCardBillingBalanceTotalClpAndAsOfDate(accountId);
    if (billing?.value_clp != null && billing.as_of_date) {
      return { value_clp: billing.value_clp, as_of_date: billing.as_of_date, market: false };
    }
  }
  const stored = latestDisplayedBalanceForAccount(accountId);
  if (stored?.value_clp != null && stored.value_clp > 0 && stored.as_of_date) {
    // Book-value carry for manual-marked accounts: stale mark + net personal flows since its
    // date, so a deposit entered today moves today's value (daily/monthly pl 0, not −flow).
    // Mortgage displayed balances are their own derivation — never carried.
    const kind = accountKindSlugForAccountId(accountId) ?? "";
    const value_clp =
      kind === "credit_card" || kind === "mortgage"
        ? stored.value_clp
        : storedMarkValueWithFlowCarry(accountId, stored.value_clp, stored.as_of_date, today);
    return { value_clp, as_of_date: stored.as_of_date, market: false };
  }
  if (bucketKind === "afp") {
    const live = liveCuotaLedgerDisplayValueClp(accountId, bucketKind, today);
    if (live) return { ...live, market: true };
  }
  const vrow = latestValuationRowOnOrBeforeChileToday(accountId);
  if (vrow?.value_clp != null && vrow.as_of_date) {
    const kind = accountKindSlugForAccountId(accountId) ?? "";
    const value_clp =
      kind === "credit_card" || kind === "mortgage"
        ? vrow.value_clp
        : storedMarkValueWithFlowCarry(accountId, vrow.value_clp, vrow.as_of_date, today);
    return { value_clp, as_of_date: vrow.as_of_date, market: false };
  }
  return null;
}

/**
 * The value an account shows today — THE figure behind the dashboard row, the account page
 * header, the today mark (`accountMarkClpAtYmd` at Chile today, so the daily series and the
 * prior-day deltas), the current month's performance row and every chart's live last point.
 *
 * Units-priced accounts — cuota ledgers (AFP / AFC), Fintual cert funds, crypto — that are not
 * equity MTM are valued by their position (units through today × price): `positionMeta` when
 * the caller already asked for it, at Chile today, else asked here. Everything else takes the
 * raw today stack. `categorySlug` / `import_key` / `name` left out are read from the account.
 * `now` reaches the quote-driven pieces (equity, crypto, the position); the calendar day is
 * Chile today.
 */
export function accountTodayValue(
  accountId: number,
  categorySlug?: string | null,
  opts?: {
    import_key?: string | null;
    name?: string | null;
    positionMeta?: AccountPositionMeta | null;
  },
  now?: Date
): AccountTodayValue | null {
  const needsLookup =
    !categorySlug || opts?.import_key === undefined || opts?.name === undefined;
  const row = needsLookup
    ? (stmtAccountMeta.get(accountId) as
        | { name: string; import_key: string | null; bucket_slug: string }
        | undefined)
    : undefined;
  const slug = categorySlug || row?.bucket_slug || "";
  const importKey = opts?.import_key !== undefined ? opts.import_key : row?.import_key ?? null;
  const name = opts?.name !== undefined ? opts.name : row?.name ?? null;
  // Asked by every reader of today (rows, perf rows, daily points, bucket totals): computed once
  // per live tier (`aggregationCache.ts`) on the real clock, unless the caller hands its own
  // position (then the figure is built from it).
  if (now === undefined && opts?.positionMeta === undefined) {
    const key = `${accountId}|${slug}|${importKey ?? ""}|${name ?? ""}`;
    const value = liveTierCached("account_today_values", key, () =>
      accountTodayValueFor(accountId, slug, importKey, name, opts?.positionMeta, now)
    );
    return value ? { ...value } : null;
  }
  return accountTodayValueFor(accountId, slug, importKey, name, opts?.positionMeta, now);
}

function accountTodayValueFor(
  accountId: number,
  slug: string,
  importKey: string | null,
  name: string | null,
  positionMeta: AccountPositionMeta | null | undefined,
  now: Date | undefined
): AccountTodayValue | null {
  const kindSlug = slug ? accountBucketKindSlug(slug) : "";
  const today = chileCalendarTodayYmd();

  const unitsPriced =
    isCuotaLedgerKindSlug(kindSlug) ||
    isFintualCertV2ValuationNotes(importKey) ||
    accountUsesCryptoMtm(accountId);
  const equityMtm = equityTickerForAccount(accountId) != null && accountUsesEquityMtm(accountId);
  if (unitsPriced && !equityMtm) {
    // The position as of TODAY, never as of the mark's date: an AFC whose valor cuota lags
    // counted its cuotas through the price day, and a fund account right after a switch read
    // the position before the cuotas arrived.
    const meta =
      positionMeta !== undefined
        ? positionMeta
        : getAccountPositionMeta(accountId, kindSlug, {
            afpCuotasAsOfYmd: today,
            accountImportKey: importKey,
            accountName: name,
            now,
          });
    const mark = positionMarkFromMeta(kindSlug, meta);
    if (mark) {
      const asOf = mark.as_of_date ?? today;
      return { value_clp: mark.value_clp, as_of_date: asOf, priced_on: asOf };
    }
  }

  const raw = rawTodayValue(accountId, slug, importKey, name, today, now);
  if (raw == null) return null;
  return {
    value_clp: raw.value_clp,
    as_of_date: raw.as_of_date,
    priced_on: raw.market ? raw.as_of_date : today,
  };
}
