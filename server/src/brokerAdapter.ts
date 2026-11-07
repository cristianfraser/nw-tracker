/**
 * What every broker importer needs to know about a broker, in one place: where its cash and its
 * holdings live, how a deposit announced by its mail is planned against checking, and how far a
 * printed dividend may sit from the ledger row it describes. The Fintual and Racional importers
 * (`fintualEmailImport`, `racionalEmailImport`, `racionalMovementsImport`,
 * `brokerDividendStatementApply`, `brokerNotificationsApply`, `brokerSplitNotifications`) read the
 * broker through it and share the two rules written once below: {@link planDepositFromMail} and
 * {@link pairDividendPayout}. A new broker is a new adapter.
 */
import type { BrokerNotificationPlanRow } from "nw-tracker-contracts";
import { accountsWithEquityTicker } from "./accountEquityTicker.js";
import { chileCalendarAddDays } from "./chileDate.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { accountWithRole } from "./accountRoles.js";
import { db } from "./db.js";
import { nextChileBusinessDayYmd } from "./marketHolidays.js";

/**
 * The settlement skew between a broker's document and the ledger, in days: mails carry the
 * payment date, the certificado the accrual or settlement date, a reinvested dividend its DRIP
 * day, a retiro's wire the bank's posting day — up to five days apart. The one window every
 * Fintual match uses (mail vs certificado, dividend details, retiro pairing, cert reconcile).
 */
export const BROKER_SETTLEMENT_WINDOW_DAYS = 5;

/** Money amounts compared to the cent (pesos and dollars alike). */
const AMOUNT_TOLERANCE = 0.005;

export type BrokerSlug = "fintual" | "racional";
export type BrokerCurrency = "clp" | "usd";

/** A broker's cash account in a currency: the account holding `broker_cash` `<broker>|<currency>`. */
function brokerCashAccountId(broker: BrokerSlug, currency: BrokerCurrency): number {
  return accountWithRole("broker_cash", `${broker}|${currency}`);
}

/* ------------------------------------- Fintual ------------------------------------- */

export function fintualUsdAccountId(): number {
  return brokerCashAccountId("fintual", "usd");
}

/** «Fintual CLP», the Efectivo account holding Fintual's peso balance (a retiro left in Fintual). */
export function fintualClpBalanceAccountId(): number {
  return brokerCashAccountId("fintual", "clp");
}

/* ------------------------------------- Racional ------------------------------------ */

export function racionalCashAccountId(currency: BrokerCurrency): number {
  return brokerCashAccountId("racional", currency);
}

/**
 * The account holding a ticker as Racional prints it. Racional lists a Chilean instrument by its
 * bare Bolsa symbol («CFIETFIPSA»), while the app keys the account on the Yahoo symbol with the
 * exchange suffix (`CFIETFIPSA.SN`, see «Quote currency / Santiago (`.SN`) tickers»): the exact
 * symbol first, else the `.SN` account, never both.
 */
export function racionalEquityAccountId(ticker: string): number {
  const symbol = String(ticker ?? "").trim().toUpperCase();
  const exact = accountsWithEquityTicker(symbol);
  const santiago = symbol.includes(".") ? [] : accountsWithEquityTicker(`${symbol}.SN`);
  if (exact.length + santiago.length !== 1) {
    throw new Error(
      `Expected exactly one account with equity_ticker "${symbol}" or "${symbol}.SN", found ${exact.length + santiago.length}. ` +
        `Create the position in the panel first (it sets accounts.equity_ticker).`
    );
  }
  return (exact[0] ?? santiago[0])!;
}

/* -------------------------------------- adapter ------------------------------------ */

export type BrokerAdapter = {
  broker: BrokerSlug;
  /** The name the reports print («Fintual USD»). */
  label: string;
  /** The broker's cash account in a currency; throws when it does not exist. */
  cashAccountId(currency: BrokerCurrency): number;
  /** The one account holding the ticker as the broker prints it; throws otherwise. */
  equityAccountId(ticker: string): number;
  /** How far a printed dividend may sit from its `dividend_payout` row, in days either way. */
  dividendPairingWindowDays: number;
  /** A deposit mail: where the ledger may already hold it (see {@link planDepositFromMail}). */
  depositFromMail: {
    /**
     * Days before the mail a checking → broker transfer of the same pesos is this deposit (written
     * from the bank's own receipt first); null when the importer dedupes it on its own.
     */
    duplicateLeadDays: number | null;
    /** The last day a plain checking debit of the same pesos may be this deposit, listed by the bank. */
    debitWindowEnd(occurredOn: string): string;
  };
};

const ADAPTERS: Record<BrokerSlug, BrokerAdapter> = {
  fintual: {
    broker: "fintual",
    label: "Fintual",
    cashAccountId: (currency) => (currency === "usd" ? fintualUsdAccountId() : fintualClpBalanceAccountId()),
    equityAccountId: (ticker) => {
      const holders = accountsWithEquityTicker(ticker);
      if (holders.length !== 1) throw new Error(`Expected exactly one account with equity_ticker "${ticker}", found ${holders.length}`);
      return holders[0]!;
    },
    dividendPairingWindowDays: BROKER_SETTLEMENT_WINDOW_DAYS,
    depositFromMail: {
      duplicateLeadDays: null,
      debitWindowEnd: (occurredOn) => chileCalendarAddDays(occurredOn, BROKER_SETTLEMENT_WINDOW_DAYS),
    },
  },
  racional: {
    broker: "racional",
    label: "Racional",
    cashAccountId: racionalCashAccountId,
    equityAccountId: racionalEquityAccountId,
    // The crawl and the mail path both date rows on the Chile day: the window only absorbs a UTC
    // evening credit.
    dividendPairingWindowDays: 2,
    depositFromMail: {
      // Santander mails its receipt the moment the wire leaves, Racional its mail once the money
      // is credited, which can be the next business day.
      duplicateLeadDays: 5,
      // The bank feed may list the debit before the mail lands (mail lagging a day).
      debitWindowEnd: (occurredOn) => {
        const nextBiz = nextChileBusinessDayYmd(occurredOn);
        return nextChileBusinessDayYmd(nextBiz ?? occurredOn) ?? occurredOn;
      },
    },
  },
};

export function brokerAdapter(broker: BrokerSlug): BrokerAdapter {
  return ADAPTERS[broker];
}

/* ---------------------------------- deposit from mail ------------------------------- */

export type DepositFromMailPlan = {
  from_account_id: number | null;
  to_account_id: number | null;
  duplicate_of: number | null;
  requires_manual: string | null;
};

const stmtRecentCheckingTransfers = db.prepare(
  `SELECT id, amount FROM movements
   WHERE occurred_on BETWEEN ? AND ? AND from_account_id = ? AND to_account_id = ? AND currency = ?`
);

const stmtSingleLegCheckingDebit = db.prepare(
  `SELECT id FROM movements
   WHERE account_id = ? AND from_account_id IS NULL AND to_account_id IS NULL
     AND currency = 'clp' AND ABS(amount + ?) <= 0.5
     AND occurred_on BETWEEN ? AND ?`
);

function accountOrNull(resolve: () => number): number | null {
  try {
    return resolve();
  } catch {
    return null;
  }
}

/**
 * A broker's «your deposit arrived» mail: a checking → broker-pesos transfer written from the
 * mail. Already in the ledger when a transfer of the same pesos sits within the adapter's lead
 * days (a re-sent mail, or the wire written from the bank's receipt); for a human when checking
 * already lists the debit as a plain row (a second row would count the money twice — the
 * existing one must be converted). The bank's own listing of the debit later dedupes against
 * the transfer's checking leg (`superseded_by_transfer`) and brings its posting day.
 */
export function planDepositFromMail(adapter: BrokerAdapter, occurredOn: string, amount: number): DepositFromMailPlan {
  const plan: DepositFromMailPlan = { from_account_id: null, to_account_id: null, duplicate_of: null, requires_manual: null };
  const checking = accountOrNull(() => checkingAccountId());
  const brokerClp = accountOrNull(() => adapter.cashAccountId("clp"));
  if (checking == null || brokerClp == null) {
    return { ...plan, requires_manual: `checking or ${adapter.label} CLP account not found` };
  }
  plan.from_account_id = checking;
  plan.to_account_id = brokerClp;
  const lead = adapter.depositFromMail.duplicateLeadDays;
  if (lead != null) {
    const dup = (
      stmtRecentCheckingTransfers.all(chileCalendarAddDays(occurredOn, -lead), occurredOn, checking, brokerClp, "clp") as {
        id: number;
        amount: number;
      }[]
    ).find((r) => Math.abs(Number(r.amount) - amount) <= AMOUNT_TOLERANCE);
    if (dup) return { ...plan, duplicate_of: dup.id };
  }
  const existingDebit = stmtSingleLegCheckingDebit.get(checking, amount, occurredOn, adapter.depositFromMail.debitWindowEnd(occurredOn)) as
    | { id: number }
    | undefined;
  if (existingDebit) {
    return {
      ...plan,
      requires_manual:
        `checking already lists this debit as movement ${existingDebit.id} — convert it to a ` +
        "transfer instead of writing a second row",
    };
  }
  return plan;
}

/* ----------------------------------- dividend pairing ------------------------------- */

const stmtDividendPayouts = db.prepare(
  `SELECT id, amount, occurred_on FROM movements
   WHERE from_account_id = ? AND to_account_id = ? AND currency = 'usd'
     AND flow_kind = 'dividend_payout'
     AND occurred_on BETWEEN ? AND ?
   ORDER BY occurred_on, id`
);

/**
 * Pair a dividend a broker printed (its net credit, on its day) with the ledger's
 * `dividend_payout` row: holder → broker dollars, the net to the cent, on the printed day or
 * within the adapter's window of it (the same day first). Exactly one match is the movement;
 * none or several is a conflict — a dividend the broker paid that the ledger lacks, or two rows
 * claiming it, must fail the step.
 */
export function pairDividendPayout(
  adapter: BrokerAdapter,
  p: {
    symbol: string;
    ymd: string;
    net: number;
    holderId: number;
    brokerUsdId: number;
    /** A document's amounts each rounded to the cent may land one cent off the ledger's net. */
    amountTolerance?: number;
    /** How the conflict names the printed figure («the document prints net», «Racional credited»). */
    printedAs: string;
  }
): { movement_id: number; conflict: null } | { movement_id: null; conflict: string } {
  const window = adapter.dividendPairingWindowDays;
  const rows = stmtDividendPayouts.all(
    p.holderId,
    p.brokerUsdId,
    chileCalendarAddDays(p.ymd, -window),
    chileCalendarAddDays(p.ymd, window)
  ) as { id: number; amount: number; occurred_on: string }[];
  const tolerance = p.amountTolerance ?? AMOUNT_TOLERANCE;
  const byAmount = rows.filter((r) => Math.abs(Number(r.amount) - p.net) <= tolerance);
  const sameDay = byAmount.filter((r) => r.occurred_on === p.ymd);
  const candidates = sameDay.length > 0 ? sameDay : byAmount;
  if (candidates.length === 0) {
    return {
      movement_id: null,
      conflict:
        rows.length === 0
          ? `no dividend_payout of ${p.symbol} → ${adapter.label} USD in the ledger within ±${window} days of ${p.ymd}`
          : `ledger dividend(s) of ${p.symbol} near ${p.ymd} read ${rows
              .map((r) => `${r.amount} (movement ${r.id}, ${r.occurred_on})`)
              .join(", ")} but ${p.printedAs} ${p.net} — reconcile before importing`,
    };
  }
  if (candidates.length > 1) {
    return {
      movement_id: null,
      conflict: `several ledger dividends of ${p.symbol} match ${p.net} near ${p.ymd} (movements ${candidates.map((r) => r.id).join(", ")})`,
    };
  }
  return { movement_id: candidates[0]!.id, conflict: null };
}

/* ------------------------------------ plan rows ------------------------------------- */

/** The fields of a planned broker movement a report row reads (both brokers' planners share them). */
export type BrokerPlannedMovementView = {
  source: { kind: string };
  occurred_on: string;
  amount: number;
  currency: string;
  from_account_id: number | null;
  to_account_id: number | null;
  units_delta: string | null;
  counter_amount: number | null;
  duplicate_of: number | null;
  requires_manual: string | null;
  create_account: { ticker: string; bucket_slug: string } | null;
  synthesized?: boolean;
  promote_movement_id?: number;
};

function legs(from: number | null, to: number | null): string | null {
  return from != null || to != null ? `${from ?? "?"} → ${to ?? "?"}` : null;
}

/** One planned movement as the `broker.notifications` report shows it. */
export function brokerPlanRow(p: BrokerPlannedMovementView): BrokerNotificationPlanRow {
  const state =
    p.duplicate_of != null
      ? "duplicate"
      : p.requires_manual != null
        ? "manual"
        : p.create_account
          ? "creates_account"
          : p.synthesized
            ? "synthesized"
            : p.promote_movement_id != null
              ? "promoted"
              : "new";
  const detail =
    p.duplicate_of != null
      ? `already in the ledger as movement ${p.duplicate_of}`
      : p.requires_manual ??
        (p.synthesized
          ? "synthesized from the mail; the bank's listing of the credit will dedupe as superseded_by_transfer"
          : p.promote_movement_id != null
            ? `checking credit ${p.promote_movement_id} becomes the transfer`
            : p.create_account
              ? `creates the ${p.create_account.ticker} position in ${p.create_account.bucket_slug}`
              : p.counter_amount != null
                ? `US$${p.counter_amount} counter leg`
                : null);
  return {
    occurred_on: p.occurred_on,
    kind: p.source.kind as BrokerNotificationPlanRow["kind"],
    amount: p.amount,
    currency: p.currency as BrokerNotificationPlanRow["currency"],
    legs: legs(p.from_account_id, p.to_account_id),
    units: p.units_delta,
    state,
    detail,
  };
}
