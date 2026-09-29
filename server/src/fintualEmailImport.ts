/**
 * Fintual notification e-mails → ledger movements.
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
import { accountIdForEquityTicker } from "./accountEquityTicker.js";
import { db } from "./db.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { bankDateMatchesTransferDate } from "./checkingTransferLegReconcile.js";
import { nextChileBusinessDayYmd } from "./marketHolidays.js";
import { chileWallClockAt } from "./chileDate.js";
import { recordSyntheticRetiroTransfer } from "./fintualSyntheticRetiros.js";
import {
  findUnpairedCheckingCredit,
  fintualGoalAccountId,
  fintualGoalFromWithdrawalSubject,
  promoteCheckingCreditToTransfer,
} from "./fintualWithdrawalPairing.js";
import {
  collapseBrokerEmailEventsByMessageId,
  normalizeSubject,
  type BrokerEmailEvent,
} from "./brokerEmailParse.js";
import { syntheticRetiroMovementIdForMessageId } from "./fintualSyntheticRetiros.js";

/** Same tolerance as `fintualCertImport.CERT_MATCH_WINDOW_DAYS`, for the same reason. */
export const EMAIL_MATCH_WINDOW_DAYS = 5;

const FINTUAL_USD_IMPORT_KEY = "import:panel|kind=usd|key=fintual_usd";
/** «Fintual CLP (Reserva)», the Efectivo account holding pesos a retiro left in Fintual. */
const FINTUAL_CLP_BALANCE_IMPORT_KEY = "import:panel|kind=clp|key=fintual";

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
 * a dividend subject names the ticker. Reinvestments are resolved by pairing with their
 * dividend (below), which needs no table at all; this map only covers ordinary purchases, and
 * an unknown fund is reported rather than guessed — booking shares against the wrong holding
 * is not a recoverable mistake.
 */
const FUND_NAME_TICKERS: [RegExp, string][] = [
  [/State Street SPDR S&P 500 ETF Trust/i, "SPY"],
  [/Linde/i, "LIN"],
  [/Cameco/i, "CCJ"],
  [/ProShares.*Crude|OILK/i, "OILK"],
];

export function tickerFromFundName(subject: string): string | null {
  // Normalise here too, not just in the classifier: the real subject carries "S&amp;P 500", so
  // a caller passing the raw header would silently get no match.
  const text = normalizeSubject(subject);
  for (const [re, ticker] of FUND_NAME_TICKERS) {
    if (re.test(text)) return ticker;
  }
  return null;
}

/**
 * The Chile calendar day a mail landed on — the day Fintual booked the event. Mail timestamps
 * are UTC, and a 23:06 Chile mail (the 2026-09-17 LIN dividend) is already the next day in UTC.
 * Same rule as the Racional importer.
 */
function eventChileYmd(event: BrokerEmailEvent): string {
  return chileWallClockAt(new Date(event.occurred_at)).ymd;
}

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
  source: BrokerEmailEvent;
  occurred_on: string;
  from_account_id: number | null;
  to_account_id: number | null;
  account_id: number | null;
  amount: number;
  currency: "clp" | "usd";
  units_delta: string | null;
  flow_kind: string | null;
  note: string;
  duplicate_of: number | null;
  requires_manual: string | null;
};

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
  event: BrokerEmailEvent,
  batch: readonly BrokerEmailEvent[]
): string | null {
  if (event.kind !== "buy") return null;
  const day = eventChileYmd(event);
  const match = batch.find(
    (e) =>
      e.kind === "dividend" &&
      e.broker === "fintual" &&
      e.ticker != null &&
      e.amount != null &&
      event.amount != null &&
      Math.abs(e.amount - event.amount) < 0.005 &&
      eventChileYmd(e) === day
  );
  return match?.ticker ?? null;
}

export function planFintualEmailMovement(
  event: BrokerEmailEvent,
  batch: readonly BrokerEmailEvent[]
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
      const named = tickerFromFundName(event.subject);
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
          requires_manual: `cannot tell which holding "${event.subject}" is — add its fund name to FUND_NAME_TICKERS`,
        };
      }
      return {
        ...base,
        from_account_id: fintualUsdAccountId(),
        to_account_id: accountIdForEquityTicker(ticker),
        units_delta: event.units,
        flow_kind: "stock_buy",
      };
    }
    case "withdrawal_paid":
    case "cash_returned": {
      // Money leaving Fintual for a bank account: exactly ONE ledger row, whichever side lands
      // first. Credit already imported → it is PROMOTED into the transfer (never a second row).
      // Credit not imported yet → the transfer is SYNTHESIZED from the mail below, and the
      // checking importers skip the bank's later listing as `superseded_by_transfer`.
      const goal = fintualGoalFromWithdrawalSubject(event.subject);
      const goalAccountId = goal ? fintualGoalAccountId(goal) : null;
      if (!goalAccountId) {
        return {
          ...base,
          requires_manual: goal
            ? `no Fintual goal account named "${goal}" — cannot tell which goal paid`
            : "cannot read the goal from the subject — link it in /panel/mirror-pairs",
        };
      }
      // A retiro to the Fintual balance («quedaron disponibles para invertir en Fintual»,
      // 2026-09-29): no bank leg exists yet, so the transfer lands in the Fintual CLP balance
      // account, in Efectivo like the goal. If Fintual wires it back after 7 days, that
      // «Devolvimos tu saldo» mail and its bank credit are a separate movement.
      if (event.kind === "withdrawal_paid" && event.paid_to === "fintual") {
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
      if (event.message_id) {
        const synthesized = syntheticRetiroMovementIdForMessageId(event.message_id);
        if (synthesized != null) return { ...base, duplicate_of: synthesized };
      }
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
        // and that skip stamps the confirmation row this synthesis records.
        //
        // Exception: when the bank could post the credit NEXT month (the payment date's next
        // business day crosses the boundary), a transfer dated this month would sit in a
        // cartola period whose saldo_final excludes the money, corrupting the checking-anchor
        // derivation — the same reason mirror-pairs hard-block month-straddle checking
        // inflows. Those rare retiros wait for the credit and pair on a later run, as before.
        const nextBusinessDay = nextChileBusinessDayYmd(base.occurred_on);
        if (
          nextBusinessDay == null ||
          nextBusinessDay.slice(0, 7) !== base.occurred_on.slice(0, 7)
        ) {
          return {
            ...base,
            requires_manual:
              "the bank may post this credit next month — waiting for it instead of synthesizing (checking-anchor rule)",
          };
        }
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
      // cutoff. Prefer the payment date — but only when the cartola/xlsx re-import dedupe
      // window still reaches it (`bankDateMatchesTransferDate`) and the two dates share a
      // month: a month-straddling early date would put the credit in a cartola period whose
      // saldo_final excludes it, corrupting the checking anchor derivation (the same reason
      // mirror-pairs hard-block month-straddle checking inflows).
      const paymentYmd = base.occurred_on;
      const useDate =
        paymentYmd < match.occurred_on &&
        paymentYmd.slice(0, 7) === match.occurred_on.slice(0, 7) &&
        bankDateMatchesTransferDate(match.occurred_on, paymentYmd)
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
 * rolling back the whole batch. The message-id collapse removes the duplicated-mail cause;
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

export function planFintualEmailBatch(
  events: readonly BrokerEmailEvent[]
): FintualPlannedMovement[] {
  const fintual = collapseBrokerEmailEventsByMessageId(
    events.filter((e) => e.broker === "fintual" && e.is_transaction && e.is_complete)
  );
  // Oldest first so the ledger reads chronologically when applied.
  const ordered = [...fintual].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  return refusePromoteCollisions(
    markFintualDuplicates(ordered.map((e) => planFintualEmailMovement(e, fintual)))
  );
}

const insTransfer = db.prepare(
  `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note, units_delta, flow_kind)
   VALUES (@from_account_id, @to_account_id, @amount, @currency, @occurred_on, @note, @units_delta, @flow_kind)`
);

export function applyFintualEmailMovements(planned: readonly FintualPlannedMovement[]): number {
  const writable = planned.filter((p) => p.duplicate_of == null && p.requires_manual == null);
  db.transaction(() => {
    for (const p of writable) {
      if (p.from_account_id == null || p.to_account_id == null) continue;
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
        continue;
      }
      const info = insTransfer.run({
        from_account_id: p.from_account_id,
        to_account_id: p.to_account_id,
        amount: p.amount,
        currency: p.currency,
        occurred_on: p.occurred_on,
        note: p.note,
        units_delta: p.units_delta,
        flow_kind: p.flow_kind,
      });
      if (p.synthesized) {
        // Provenance + confirmation state. `message_id` is UNIQUE, so even a duplicate-guard
        // miss cannot synthesize the same mail twice — this insert would abort the transaction.
        recordSyntheticRetiroTransfer(
          Number(info.lastInsertRowid),
          p.source.message_id ?? `no-message-id|${p.occurred_on}|${p.amount}`,
          p.amount,
          p.occurred_on
        );
      }
    }
  })();
  return writable.length;
}
