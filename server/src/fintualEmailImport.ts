/**
 * Fintual notifications (`broker.notifications`, read from Fintual's e-mails by ingest) →
 * ledger movements.
 *
 * Fintual is e-mail-only here: there is no scraper, and its notifications describe a movement
 * completely (the subject carries the amount AND the share count), so this replaces the manual
 * certificado download for keeping up to date. The certificado stays useful as the periodic
 * full reconcile — this is the incremental path.
 *
 * Shapes are copied from the DRIP rows already in the ledger, not invented: a dividend is a
 * transfer `<equity account> → Fintual USD` with no units, and its reinvestment is the reverse
 * carrying `units_delta`.
 *
 * **Dates**: e-mails carry the PAYMENT date — when cash and shares actually moved — while the
 * certificado dates a dividend at its accrual date, up to five days earlier. Duplicate
 * detection therefore matches within the same ±5-day window `fintualCertImport` uses, so an
 * e-mail-dated row and a certificado-dated one for the same event recognise each other.
 */
import { accountIdForEquityTicker, accountsWithEquityTicker } from "./accountEquityTicker.js";
import { createPanelAccount } from "./createPanelAccount.js";
import { db } from "./db.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { bankDateMatchesTransferDate } from "./checkingTransferLegReconcile.js";
import { recordSyntheticRetiroTransfer } from "./fintualSyntheticRetiros.js";
import {
  findUnpairedCheckingCredit,
  fintualGoalAccountId,
  promoteCheckingCreditToTransfer,
} from "./fintualWithdrawalPairing.js";
import type { BrokerNotification } from "nw-tracker-contracts";
import { brokerNotificationIsBookable, notificationChileYmd } from "./brokerNotifications.js";
import { syntheticRetiroMovementIdForMessageId } from "./fintualSyntheticRetiros.js";

/** Same tolerance as `fintualCertImport.CERT_MATCH_WINDOW_DAYS`, for the same reason. */
export const EMAIL_MATCH_WINDOW_DAYS = 5;

const FINTUAL_USD_IMPORT_KEY = "import:panel|kind=usd|key=fintual_usd";
/** «Fintual CLP», the Efectivo account holding Fintual's peso balance (a retiro left in Fintual). */
const FINTUAL_CLP_BALANCE_IMPORT_KEY = "import:panel|kind=clp|key=fintual_clp";

export function fintualClpBalanceAccountId(): number {
  const row = db
    .prepare(`SELECT id FROM accounts WHERE import_key = ?`)
    .get(FINTUAL_CLP_BALANCE_IMPORT_KEY) as { id: number } | undefined;
  if (!row) throw new Error(`No account with import_key "${FINTUAL_CLP_BALANCE_IMPORT_KEY}"`);
  return row.id;
}

export function fintualUsdAccountId(): number {
  const row = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(FINTUAL_USD_IMPORT_KEY) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`No account with import_key "${FINTUAL_USD_IMPORT_KEY}"`);
  return row.id;
}

/**
 * Fund name → ticker, for the buy e-mails.
 *
 * A purchase subject names the fund ("… acciones de State Street SPDR S&P 500 ETF Trust") while
 * a dividend subject names the ticker (the feeder sends the name as `fund_name`). Reinvestments
 * are resolved by pairing with their
 * dividend (below), which needs no table at all; this map only covers ordinary purchases, and
 * an unknown fund is reported rather than guessed — booking shares against the wrong holding
 * is not a recoverable mistake.
 */
const FUND_NAME_TICKERS: [RegExp, string][] = [
  [/State Street SPDR S&P 500 ETF Trust/i, "SPY"],
  [/Linde/i, "LIN"],
  [/Cameco/i, "CCJ"],
  [/ProShares.*Crude|OILK/i, "OILK"],
  [/Invesco PHLX Semiconductor ETF/i, "SOXQ"],
];

export function tickerFromFundName(fundName: string): string | null {
  for (const [re, ticker] of FUND_NAME_TICKERS) {
    if (re.test(fundName)) return ticker;
  }
  return null;
}

/**
 * The Chile calendar day a mail landed on — the day Fintual booked the event. Mail timestamps
 * are UTC, and a 23:06 Chile mail (the 2026-09-17 LIN dividend) is already the next day in UTC.
 * Same rule as the Racional importer.
 */
const eventChileYmd = notificationChileYmd;

function isoAddDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type FintualPlannedMovement = {
  /**
   * Existing checking credit to turn into this transfer, instead of inserting a new row.
   * Set only for withdrawal e-mails that found their bank leg.
   */
  promote_movement_id?: number;
  /**
   * Transfer written from the mail alone — the checking credit is not in the ledger yet (the
   * daily xlsx only arrives with the nightly bank session). Recorded in
   * `fintual_synthetic_retiro_transfers`; the checking importers skip the bank's later listing
   * as `superseded_by_transfer` and stamp it confirmed.
   */
  synthesized?: boolean;
  source: BrokerNotification;
  occurred_on: string;
  from_account_id: number | null;
  to_account_id: number | null;
  account_id: number | null;
  amount: number;
  currency: "clp" | "usd";
  /** The dollars of a peso → dollar conversion (`compra_usd_venta_clp`); null otherwise. */
  counter_amount: number | null;
  counter_currency: "usd" | null;
  /**
   * A buy of a ticker no account holds yet: the apply creates the stock account first, in the
   * bucket the other Fintual stocks sit in (one account per ticker, whatever the broker).
   */
  create_account: { ticker: string; bucket_slug: string } | null;
  units_delta: string | null;
  flow_kind: string | null;
  note: string;
  duplicate_of: number | null;
  requires_manual: string | null;
};

/** Same band as the Racional conversion: a rate outside it is a misread mail, not a trade. */
const FX_SANITY_MIN_CLP_PER_USD = 300;
const FX_SANITY_MAX_CLP_PER_USD = 2000;

const findSingleLegCheckingDebit = db.prepare(
  `SELECT id FROM movements
   WHERE account_id = ? AND from_account_id IS NULL AND to_account_id IS NULL
     AND currency = 'clp' AND ABS(amount + ?) <= 0.5
     AND occurred_on BETWEEN ? AND ?`
);

/** The bucket every stock Fintual USD has bought sits in, when there is exactly one. */
function fintualEquityBucketSlug(): string | null {
  const rows = db
    .prepare(
      `SELECT DISTINCT pg.slug AS slug
       FROM movements m
       JOIN accounts a ON a.id = m.to_account_id
       JOIN portfolio_groups pg ON pg.id = a.primary_portfolio_group_id
       WHERE m.from_account_id = ? AND m.units_delta IS NOT NULL AND a.equity_ticker IS NOT NULL`
    )
    .all(fintualUsdAccountId()) as { slug: string }[];
  return rows.length === 1 ? rows[0]!.slug : null;
}

const findNearbyTransfers = db.prepare(
  `SELECT id, occurred_on, amount FROM movements
   WHERE from_account_id = ? AND to_account_id = ? AND currency = ?
     AND occurred_on BETWEEN ? AND ?`
);

/**
 * Resolve the instrument for a reinvestment by pairing it with its dividend.
 *
 * A DRIP is one dividend and one purchase of the SAME amount on the same day — that pairing is
 * what the existing ledger rows encode (`buy=10791` in their notes), and it identifies the
 * holding without needing to recognise the fund's marketing name.
 */
export function pairedDividendTicker(
  event: BrokerNotification,
  batch: readonly BrokerNotification[]
): string | null {
  if (event.kind !== "buy") return null;
  const day = eventChileYmd(event);
  const match = batch.find(
    (e) =>
      e.kind === "dividend" &&
      e.ticker != null &&
      e.amount != null &&
      event.amount != null &&
      Math.abs(e.amount - event.amount) < 0.005 &&
      eventChileYmd(e) === day
  );
  return match?.ticker ?? null;
}

export function planFintualEmailMovement(
  event: BrokerNotification,
  batch: readonly BrokerNotification[]
): FintualPlannedMovement {
  const occurred_on = eventChileYmd(event);
  const base = {
    source: event,
    occurred_on,
    from_account_id: null as number | null,
    to_account_id: null as number | null,
    account_id: null as number | null,
    amount: event.amount ?? 0,
    currency: (event.currency ?? "usd") as "clp" | "usd",
    counter_amount: null as number | null,
    counter_currency: null as "usd" | null,
    create_account: null as { ticker: string; bucket_slug: string } | null,
    units_delta: null as string | null,
    flow_kind: null as string | null,
    note: `Fintual · ${event.subject}`.slice(0, 300),
    duplicate_of: null as number | null,
    requires_manual: null as string | null,
  };

  switch (event.kind) {
    case "dividend": {
      if (!event.ticker) throw new Error(`Fintual dividend without a ticker: ${event.subject}`);
      return {
        ...base,
        from_account_id: accountIdForEquityTicker(event.ticker),
        to_account_id: fintualUsdAccountId(),
        flow_kind: "dividend_payout",
      };
    }
    case "buy": {
      // Order matters. The fund NAME is direct evidence of what was bought; the dividend
      // pairing is only an inference from "same amount, same day". They agree for an automatic
      // reinvestment — but if dividend reinvestment is switched off and that cash is spent on a
      // DIFFERENT instrument that happens to cost the same, the inference points at the wrong
      // holding. So name first, pairing only when the fund is unrecognised, and a disagreement
      // between the two is refused rather than resolved by precedence.
      const named = event.fund_name ? tickerFromFundName(event.fund_name) : null;
      const paired = pairedDividendTicker(event, batch);
      if (named && paired && named !== paired) {
        return {
          ...base,
          requires_manual:
            `"${event.subject}" names ${named} but pairs by amount with a ${paired} dividend — ` +
            `resolve which holding this bought before importing`,
        };
      }
      const ticker = event.ticker ?? named ?? paired;
      if (!ticker) {
        return {
          ...base,
          requires_manual: `cannot tell which holding "${event.subject}" is — add its fund name (${event.fund_name ?? "none stated"}) to FUND_NAME_TICKERS`,
        };
      }
      const buyBase = { ...base, from_account_id: fintualUsdAccountId(), units_delta: event.units, flow_kind: "stock_buy" };
      const holders = accountsWithEquityTicker(ticker);
      if (holders.length > 1) {
        return { ...buyBase, requires_manual: `ticker ${ticker} matches ${holders.length} accounts — resolve first` };
      }
      if (holders.length === 1) return { ...buyBase, to_account_id: holders[0]! };
      const bucket = fintualEquityBucketSlug();
      if (!bucket) {
        return {
          ...buyBase,
          requires_manual:
            `no account for ticker ${ticker} and no single bucket the Fintual stocks sit in — ` +
            "create the position in the panel first",
        };
      }
      return { ...buyBase, create_account: { ticker, bucket_slug: bucket } };
    }
    case "deposit": {
      // «Recibimos tu depósito»: a wire from checking landed in the Fintual balance, to be
      // invested from there (or returned after 7 days). Written from the mail, like Racional's
      // deposit; the bank's listing of the debit dedupes against this transfer's checking leg
      // (`superseded_by_transfer`) and brings its posting day.
      const checking = checkingAccountId();
      const balance = fintualClpBalanceAccountId();
      const depositBase = { ...base, currency: "clp" as const, from_account_id: checking, to_account_id: balance };
      if (event.currency !== "clp") {
        return { ...depositBase, requires_manual: `deposit in ${event.currency ?? "no currency"} — only peso deposits are mapped` };
      }
      // The bank feed may already list the debit as a plain row (mail read after the nightly
      // import): a second row would count the money twice, so that one is for a human to convert.
      const existingDebit = findSingleLegCheckingDebit.get(
        checking,
        base.amount,
        occurred_on,
        isoAddDays(occurred_on, EMAIL_MATCH_WINDOW_DAYS)
      ) as { id: number } | undefined;
      if (existingDebit) {
        return {
          ...depositBase,
          requires_manual:
            `checking already lists this debit as movement ${existingDebit.id} — convert it to a ` +
            "transfer instead of writing a second row",
        };
      }
      return depositBase;
    }
    case "wallet_funded": {
      // «Compraste dólares»: pesos of the Fintual balance → dollars, the shape of the hand-entered
      // compras (CLP from-leg, USD counter leg).
      const fxBase = {
        ...base,
        amount: event.clp_amount ?? 0,
        currency: "clp" as const,
        counter_amount: event.amount,
        counter_currency: "usd" as const,
        from_account_id: fintualClpBalanceAccountId(),
        to_account_id: fintualUsdAccountId(),
        flow_kind: "compra_usd_venta_clp",
      };
      if (event.amount == null || event.clp_amount == null) {
        return { ...fxBase, requires_manual: "the mail does not state both the dollars and the pesos — enter the compra by hand" };
      }
      const impliedFx = event.clp_amount / event.amount;
      if (impliedFx < FX_SANITY_MIN_CLP_PER_USD || impliedFx > FX_SANITY_MAX_CLP_PER_USD) {
        return { ...fxBase, requires_manual: `implied fx ${impliedFx.toFixed(2)} CLP/USD is outside the sanity band` };
      }
      return fxBase;
    }
    case "withdrawal_paid":
    case "cash_returned": {
      // Money leaving Fintual for a bank account: exactly ONE ledger row, whichever side lands
      // first. Credit already imported → it is PROMOTED into the transfer (never a second row).
      // Credit not imported yet → the transfer is SYNTHESIZED from the mail below, and the
      // checking importers skip the bank's later listing as `superseded_by_transfer`.
      const goal = event.goal_name;
      const goalAccountId = goal ? fintualGoalAccountId(goal) : null;
      if (!goalAccountId) {
        return {
          ...base,
          requires_manual: goal
            ? `no Fintual goal account named "${goal}" — cannot tell which goal paid`
            : "the notification names no goal — link it in /panel/mirror-pairs",
        };
      }
      // A retiro to the Fintual balance («quedaron disponibles para invertir en Fintual»,
      // 2026-09-29): no bank leg exists yet, so the transfer lands in the Fintual CLP balance
      // account, in Efectivo like the goal. If Fintual wires it back after 7 days, that
      // «Devolvimos tu saldo» mail and its bank credit are a separate movement.
      if (event.kind === "withdrawal_paid" && event.paid_to === "broker_balance") {
        if (!event.units) {
          return {
            ...base,
            requires_manual:
              "the e-mail body does not name a single cuota count — enter the retiro by hand with its cuotas",
          };
        }
        return {
          ...base,
          from_account_id: goalAccountId,
          to_account_id: fintualClpBalanceAccountId(),
          units_delta: event.units,
        };
      }
      // This exact mail already produced a synthesized transfer: the strongest possible
      // duplicate evidence, and checked first because `fintual_synthetic_retiro_transfers`
      // is UNIQUE on message_id — reaching the insert again would abort the whole batch.
      const synthesized = syntheticRetiroMovementIdForMessageId(event.message_id);
      if (synthesized != null) return { ...base, duplicate_of: synthesized };
      // Already reconciled on an earlier run (or by hand): the transfer this e-mail describes is
      // in the ledger, so it is a duplicate rather than something still waiting for its bank leg.
      const existing = findNearbyTransfers.all(
        goalAccountId,
        checkingAccountId(),
        base.currency,
        isoAddDays(base.occurred_on, -EMAIL_MATCH_WINDOW_DAYS),
        isoAddDays(base.occurred_on, EMAIL_MATCH_WINDOW_DAYS)
      ) as { id: number; amount: number }[];
      const already = existing.find((r) => Math.round(r.amount) === Math.round(base.amount));
      if (already) return { ...base, duplicate_of: already.id };

      // A retiro sells cuotas, and the goal's value is cuotas × px — promoting the transfer
      // without the cuota count would keep the goal's cuota ledger (and value) unchanged
      // forever. The e-mail body prints it («… Serie A (900,3208 cuotas)»); the classifier
      // leaves units null when the body names zero or several funds, and either way the
      // pairing needs a human. cash_returned is money that never bought cuotas, so it is
      // exempt.
      if (event.kind === "withdrawal_paid" && !event.units) {
        return {
          ...base,
          requires_manual:
            "the e-mail body does not name a single cuota count — promote it by hand with the retiro's cuotas",
        };
      }
      const match = findUnpairedCheckingCredit(base.amount, base.occurred_on);
      if (match === "ambiguous") {
        return {
          ...base,
          requires_manual: "several unpaired checking credits match — link it in /panel/mirror-pairs",
        };
      }
      if (!match) {
        // No bank leg yet — the daily «últimos movimientos» xlsx only arrives with the nightly
        // 22:00 bank session, so a retiro paid in the morning has no credit to promote for
        // hours and its NAV drop would strand in the day's P/L. The mail alone is stronger
        // evidence than the generic matchers ever get (exact amount, payment date, goal AND
        // cuota count), so the transfer is SYNTHESIZED from it, dated the payment day. No
        // second row can appear later: both checking importers skip a bank credit represented
        // by a transfer leg (`findMatchingInternalTransferLegId`, signed amount + posting
        // window) — the same rule that absorbs the nightly re-listing of a PROMOTED credit —
        // and that skip stamps the confirmation row this synthesis records, plus the bank's
        // posting day (`movement_bank_postings`) when it lands in the next month.
        return {
          ...base,
          from_account_id: goalAccountId,
          to_account_id: checkingAccountId(),
          units_delta: event.units,
          synthesized: true,
        };
      }
      // The e-mail's payment date is when the money ACTUALLY moved (cuotas sold, cash paid);
      // the credit's date is the bank's next-workday POSTING date when the wire beat the 14:00
      // cutoff. Prefer the payment date when the bank date is its posting
      // (`bankDateMatchesTransferDate`), across a month boundary too: the promotion keeps the
      // bank date as the transfer's posting day on checking, which the cartola checks read.
      const paymentYmd = base.occurred_on;
      const useDate =
        paymentYmd < match.occurred_on && bankDateMatchesTransferDate(match.occurred_on, paymentYmd)
          ? paymentYmd
          : match.occurred_on;
      return {
        ...base,
        occurred_on: useDate,
        from_account_id: goalAccountId,
        to_account_id: checkingAccountId(),
        units_delta: event.units,
        promote_movement_id: match.id,
      };
    }
    default:
      return { ...base, requires_manual: `no ledger mapping for kind "${event.kind}"` };
  }
}

/** Flag anything already in the ledger, tolerating the accrual-vs-payment date gap. */
export function markFintualDuplicates(
  planned: readonly FintualPlannedMovement[]
): FintualPlannedMovement[] {
  return planned.map((p) => {
    if (p.from_account_id == null || p.to_account_id == null) return p;
    const rows = findNearbyTransfers.all(
      p.from_account_id,
      p.to_account_id,
      p.currency,
      isoAddDays(p.occurred_on, -EMAIL_MATCH_WINDOW_DAYS),
      isoAddDays(p.occurred_on, EMAIL_MATCH_WINDOW_DAYS)
    ) as { id: number; occurred_on: string; amount: number }[];
    const hit = rows.find((r) => Math.abs(Number(r.amount) - p.amount) < 0.005);
    return hit ? { ...p, duplicate_of: hit.id } : p;
  });
}

/**
 * Two rows in one batch that would promote the SAME checking credit cannot both be right: the
 * first rewrites the row into a transfer and the second's UPDATE matches nothing and throws,
 * rolling back the whole batch. Unique message ids per payload remove the duplicated-mail cause;
 * this guards the remaining one — two distinct retiro mails whose only candidate credit is
 * one and the same row — by keeping the first and sending the rest to a human.
 */
function refusePromoteCollisions(
  planned: readonly FintualPlannedMovement[]
): FintualPlannedMovement[] {
  const claimed = new Set<number>();
  return planned.map((p) => {
    if (p.promote_movement_id == null || p.duplicate_of != null || p.requires_manual != null) {
      return p;
    }
    if (claimed.has(p.promote_movement_id)) {
      return {
        ...p,
        requires_manual:
          `checking credit ${p.promote_movement_id} is already claimed by another retiro in this ` +
          "batch — link it in /panel/mirror-pairs",
      };
    }
    claimed.add(p.promote_movement_id);
    return p;
  });
}

/** Plans every bookable notification; the rest are nudges the caller reports. */
export function planFintualEmailBatch(
  events: readonly BrokerNotification[]
): FintualPlannedMovement[] {
  const fintual = events.filter(brokerNotificationIsBookable);
  // Oldest first so the ledger reads chronologically when applied.
  const ordered = [...fintual].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  return refusePromoteCollisions(
    markFintualDuplicates(ordered.map((e) => planFintualEmailMovement(e, fintual)))
  );
}

const insTransfer = db.prepare(
  `INSERT INTO movements (from_account_id, to_account_id, amount, currency, counter_amount, counter_currency, occurred_on, note, units_delta, flow_kind)
   VALUES (@from_account_id, @to_account_id, @amount, @currency, @counter_amount, @counter_currency, @occurred_on, @note, @units_delta, @flow_kind)`
);

export function applyFintualEmailMovements(planned: readonly FintualPlannedMovement[]): number {
  return applyFintualEmailMovementsWithIds(planned).written;
}

/**
 * {@link applyFintualEmailMovements}, also returning the movement each planned row stands for
 * after the apply, index-aligned with `planned`: the inserted row, the promoted credit, the
 * matched duplicate; null for a row left for a human.
 */
export function applyFintualEmailMovementsWithIds(planned: readonly FintualPlannedMovement[]): {
  written: number;
  movement_ids: (number | null)[];
} {
  const movement_ids: (number | null)[] = planned.map((p) =>
    p.requires_manual != null ? null : (p.duplicate_of ?? null)
  );
  const writable = planned.filter((p) => p.duplicate_of == null && p.requires_manual == null);
  db.transaction(() => {
    for (const [index, p] of planned.entries()) {
      if (p.duplicate_of != null || p.requires_manual != null) continue;
      let toAccountId = p.to_account_id;
      if (p.create_account) {
        // Re-checked here: an earlier buy in this batch may already have created it.
        const holders = accountsWithEquityTicker(p.create_account.ticker);
        if (holders.length > 1) throw new Error(`ticker ${p.create_account.ticker} became ambiguous during apply`);
        toAccountId =
          holders[0] ??
          createPanelAccount({
            account: {
              account_type: "equity",
              name: p.create_account.ticker,
              bucket_slug: p.create_account.bucket_slug,
              ticker: p.create_account.ticker,
              exclude_from_group_totals: false,
            },
          }).account_id;
      }
      if (p.from_account_id == null || toAccountId == null) {
        throw new Error(`planned ${p.source.kind} on ${p.occurred_on} has unresolved legs`);
      }
      // A withdrawal that found its bank leg rewrites that row instead of inserting: the money is
      // already in the ledger once, and a second row would be the double count this avoids.
      if (p.promote_movement_id != null) {
        promoteCheckingCreditToTransfer(
          p.promote_movement_id,
          p.from_account_id,
          p.note,
          p.units_delta,
          p.occurred_on
        );
        movement_ids[index] = p.promote_movement_id;
        continue;
      }
      const info = insTransfer.run({
        from_account_id: p.from_account_id,
        to_account_id: toAccountId,
        amount: p.amount,
        currency: p.currency,
        counter_amount: p.counter_amount,
        counter_currency: p.counter_currency,
        occurred_on: p.occurred_on,
        note: p.note,
        units_delta: p.units_delta,
        flow_kind: p.flow_kind,
      });
      movement_ids[index] = Number(info.lastInsertRowid);
      if (p.synthesized) {
        // Provenance + confirmation state. `message_id` is UNIQUE, so even a duplicate-guard
        // miss cannot synthesize the same mail twice — this insert would abort the transaction.
        recordSyntheticRetiroTransfer(
          Number(info.lastInsertRowid),
          p.source.message_id,
          p.amount,
          p.occurred_on
        );
      }
    }
  })();
  return { written: writable.length, movement_ids };
}
