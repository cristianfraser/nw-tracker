/**
 * Racional movements from notification e-mails — the incremental path that needs no browser.
 *
 * Three mail kinds become ledger rows (all others report only):
 * - «Tu depósito de CLP $X está listo para invertir» → checking → Racional CLP transfer. The
 *   mail is Racional confirming the money ARRIVED, so unlike an inbound wire there is no
 *   promised-but-missing risk; the bank's own listing of the debit is absorbed later by the
 *   checking importers' `superseded_by_transfer` skip (same mechanism as Fintual retiros).
 * - «Agregaste USD $Y a tu Billetera» → Racional CLP → Racional USD `compra_usd_venta_clp`
 *   transfer (CLP from-leg from the body, USD counter leg from the subject). This event exists
 *   NOWHERE else — the app's movements list never shows conversions — so the mail is the only
 *   automatic source.
 * - «Invertiste en <name> (TICKER)» → Racional USD → equity transfer with `units_delta` and
 *   `stock_buy`. A ticker with no account yet is auto-created through the same
 *   `createPanelAccount` path the panel uses (bare-ticker name, sibling bucket), so
 *   `accounts.equity_ticker` resolution, nav seeding and EOD/live-quote sync enrolment all
 *   happen exactly as for a hand-created position.
 *
 * Dedupe is ledger-based (scans are re-read every run, like the Fintual import): a transfer of
 * the same legs/amount on the mail's own day is the same event. Mail dates are authoritative —
 * there is no bank-date skew on this side — so the window is same-day only; genuine same-day
 * equal twins are the known (rare) limitation and would report as duplicates for manual entry.
 */
import { accountsWithEquityTicker } from "./accountEquityTicker.js";
import { chileWallClockAt } from "./chileDate.js";
import { createPanelAccount } from "./createPanelAccount.js";
import { db } from "./db.js";
import { nextChileBusinessDayYmd } from "./marketHolidays.js";
import { racionalCashAccountId } from "./racionalMovementsImport.js";
import {
  collapseBrokerEmailEventsByMessageId,
  type BrokerEmailEvent,
} from "./brokerEmailParse.js";

/** Same sanity band as the CC divisas mirror tier: an implied CLP/USD far outside is a parse bug. */
const FX_SANITY_MIN_CLP_PER_USD = 300;
const FX_SANITY_MAX_CLP_PER_USD = 2000;

const AMOUNT_TOLERANCE = 0.005;

const CHECKING_IMPORT_KEY = "import:excel|key=cuenta_corriente";

export type RacionalEmailPlannedMovement = {
  source: BrokerEmailEvent;
  kind: "deposit" | "conversion" | "buy";
  occurred_on: string;
  amount: number;
  currency: "clp" | "usd";
  counter_amount: number | null;
  counter_currency: "usd" | null;
  from_account_id: number | null;
  to_account_id: number | null;
  units_delta: string | null;
  flow_kind: string | null;
  note: string;
  /** Set when the buy's ticker has no account yet — applied atomically with the movement. */
  create_account: { ticker: string; name: string; bucket_slug: string } | null;
  duplicate_of: number | null;
  requires_manual: string | null;
};

function checkingAccountId(): number | null {
  const row = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(CHECKING_IMPORT_KEY) as
    | { id: number }
    | undefined;
  return row?.id ?? null;
}

function tryRacionalCashAccountId(currency: "clp" | "usd"): number | null {
  try {
    return racionalCashAccountId(currency);
  } catch {
    return null;
  }
}

function mailChileYmd(event: BrokerEmailEvent): string {
  return chileWallClockAt(new Date(event.occurred_at)).ymd;
}

const stmtSameDayTransfers = db.prepare(
  `SELECT id, amount, counter_amount FROM movements
   WHERE occurred_on = ? AND from_account_id = ? AND to_account_id = ? AND currency = ?`
);

const stmtSingleLegChecking = db.prepare(
  `SELECT id FROM movements
   WHERE account_id = ? AND currency = 'clp' AND ABS(amount + ?) <= 0.5
     AND occurred_on BETWEEN ? AND ?`
);

/** Existing transfer with the same legs/amount on the same day (re-read scans, re-runs). */
function sameDayDuplicateId(p: {
  occurred_on: string;
  from_account_id: number;
  to_account_id: number;
  currency: string;
  amount: number;
}): number | null {
  const rows = stmtSameDayTransfers.all(
    p.occurred_on,
    p.from_account_id,
    p.to_account_id,
    p.currency
  ) as { id: number; amount: number }[];
  for (const r of rows) {
    if (Math.abs(Number(r.amount) - p.amount) <= AMOUNT_TOLERANCE) return r.id;
  }
  return null;
}

/**
 * Bucket for an auto-created position: the one bucket every equity account bought through
 * Racional USD lives in. Zero or several distinct buckets → refuse (never guess placement).
 */
function racionalEquityBucketSlug(racionalUsdId: number): string | null {
  const rows = db
    .prepare(
      `SELECT DISTINCT pg.slug AS slug
       FROM movements m
       JOIN accounts a ON a.id = m.to_account_id
       JOIN portfolio_groups pg ON pg.id = a.primary_portfolio_group_id
       WHERE m.from_account_id = ? AND m.units_delta IS NOT NULL`
    )
    .all(racionalUsdId) as { slug: string }[];
  return rows.length === 1 ? rows[0]!.slug : null;
}

function planDeposit(event: BrokerEmailEvent): RacionalEmailPlannedMovement {
  const occurredOn = mailChileYmd(event);
  const base: RacionalEmailPlannedMovement = {
    source: event,
    kind: "deposit",
    occurred_on: occurredOn,
    amount: event.amount ?? 0,
    currency: "clp",
    counter_amount: null,
    counter_currency: null,
    from_account_id: null,
    to_account_id: null,
    units_delta: null,
    flow_kind: null,
    note: `Racional e-mail: depósito desde cuenta corriente (${occurredOn})`,
    create_account: null,
    duplicate_of: null,
    requires_manual: null,
  };
  if (event.amount == null || !(event.amount > 0)) {
    return { ...base, requires_manual: "deposit mail carries no amount" };
  }
  const checking = checkingAccountId();
  const racionalClp = tryRacionalCashAccountId("clp");
  if (checking == null || racionalClp == null) {
    return { ...base, requires_manual: "checking or Racional CLP account not found" };
  }
  base.from_account_id = checking;
  base.to_account_id = racionalClp;

  // Cartola-anchor rule (same caution as Fintual retiros): a deposit whose next business day
  // crosses into the next month could be listed by the bank in the next cartola period.
  const nextBiz = nextChileBusinessDayYmd(occurredOn);
  if (nextBiz != null && nextBiz.slice(0, 7) !== occurredOn.slice(0, 7)) {
    return {
      ...base,
      requires_manual:
        "month boundary: the bank may list the debit in the next cartola period — enter by hand",
    };
  }

  const dup = sameDayDuplicateId({
    occurred_on: occurredOn,
    from_account_id: checking,
    to_account_id: racionalClp,
    currency: "clp",
    amount: event.amount,
  });
  if (dup != null) return { ...base, duplicate_of: dup };

  // The bank feed may already have listed the debit as a plain single-leg row (mail lagging a
  // day). Writing the transfer would then double-count — the existing row must be converted.
  const windowFrom = occurredOn;
  const windowTo = nextChileBusinessDayYmd(nextBiz ?? occurredOn) ?? occurredOn;
  const existingDebit = stmtSingleLegChecking.get(checking, event.amount, windowFrom, windowTo) as
    | { id: number }
    | undefined;
  if (existingDebit) {
    return {
      ...base,
      requires_manual:
        `checking already lists this debit as movement ${existingDebit.id} — convert it to a ` +
        `transfer instead of synthesizing a second row`,
    };
  }
  return base;
}

function planConversion(event: BrokerEmailEvent): RacionalEmailPlannedMovement {
  const occurredOn = mailChileYmd(event);
  const base: RacionalEmailPlannedMovement = {
    source: event,
    kind: "conversion",
    occurred_on: occurredOn,
    amount: event.clp_amount ?? 0,
    currency: "clp",
    counter_amount: event.amount,
    counter_currency: "usd",
    from_account_id: null,
    to_account_id: null,
    units_delta: null,
    flow_kind: "compra_usd_venta_clp",
    note: `Racional e-mail: compra de dólares (${occurredOn})`,
    create_account: null,
    duplicate_of: null,
    requires_manual: null,
  };
  if (event.amount == null || !(event.amount > 0)) {
    return { ...base, requires_manual: "conversion mail carries no USD amount" };
  }
  if (event.clp_amount == null || !(event.clp_amount > 0)) {
    return {
      ...base,
      requires_manual:
        "conversion mail preview carries no CLP leg — enter the compra by hand with the pesos " +
        "shown in the mail",
    };
  }
  const impliedFx = event.clp_amount / event.amount;
  if (impliedFx < FX_SANITY_MIN_CLP_PER_USD || impliedFx > FX_SANITY_MAX_CLP_PER_USD) {
    return {
      ...base,
      requires_manual: `implied fx ${impliedFx.toFixed(2)} CLP/USD is outside the sanity band`,
    };
  }
  const racionalClp = tryRacionalCashAccountId("clp");
  const racionalUsd = tryRacionalCashAccountId("usd");
  if (racionalClp == null || racionalUsd == null) {
    return { ...base, requires_manual: "Racional cash accounts not found" };
  }
  base.from_account_id = racionalClp;
  base.to_account_id = racionalUsd;
  const dup = sameDayDuplicateId({
    occurred_on: occurredOn,
    from_account_id: racionalClp,
    to_account_id: racionalUsd,
    currency: "clp",
    amount: event.clp_amount,
  });
  if (dup != null) return { ...base, duplicate_of: dup };
  return base;
}

function planBuy(event: BrokerEmailEvent): RacionalEmailPlannedMovement {
  const occurredOn = mailChileYmd(event);
  const base: RacionalEmailPlannedMovement = {
    source: event,
    kind: "buy",
    occurred_on: occurredOn,
    amount: event.amount ?? 0,
    currency: "usd",
    counter_amount: null,
    counter_currency: null,
    from_account_id: null,
    to_account_id: null,
    units_delta: event.units,
    flow_kind: "stock_buy",
    note: `Racional e-mail: compra ${event.units ?? "?"} ${event.ticker ?? "?"} (${occurredOn})`,
    create_account: null,
    duplicate_of: null,
    requires_manual: null,
  };
  if (!event.ticker) return { ...base, requires_manual: "buy mail carries no ticker" };
  if (event.amount == null || !(event.amount > 0) || !event.units) {
    return { ...base, requires_manual: "buy mail carries no amount/units (body not parsed)" };
  }
  if (event.price != null && event.price > 0) {
    const implied = Number(event.units) * event.price;
    if (Math.abs(implied - event.amount) > Math.max(1, event.amount * 0.01)) {
      return {
        ...base,
        requires_manual:
          `units × price = ${implied.toFixed(2)} disagrees with amount ${event.amount.toFixed(2)}`,
      };
    }
  }
  const racionalUsd = tryRacionalCashAccountId("usd");
  if (racionalUsd == null) return { ...base, requires_manual: "Racional USD account not found" };
  base.from_account_id = racionalUsd;

  const holders = accountsWithEquityTicker(event.ticker);
  if (holders.length > 1) {
    return {
      ...base,
      requires_manual: `ticker ${event.ticker} matches ${holders.length} accounts — resolve first`,
    };
  }
  if (holders.length === 1) {
    base.to_account_id = holders[0]!;
  } else {
    const bucket = racionalEquityBucketSlug(racionalUsd);
    if (!bucket) {
      return {
        ...base,
        requires_manual:
          `no account for ticker ${event.ticker} and no unambiguous sibling bucket to create it ` +
          `in — create the position in the panel first`,
      };
    }
    base.create_account = { ticker: event.ticker, name: event.ticker, bucket_slug: bucket };
  }

  if (base.to_account_id != null) {
    const dup = sameDayDuplicateId({
      occurred_on: occurredOn,
      from_account_id: racionalUsd,
      to_account_id: base.to_account_id,
      currency: "usd",
      amount: event.amount,
    });
    if (dup != null) return { ...base, duplicate_of: dup };
  }
  return base;
}

/** Plan the writable Racional events of a scan batch (mail order — deposit → conversion → buy). */
export function planRacionalEmailMovements(
  events: readonly BrokerEmailEvent[]
): RacionalEmailPlannedMovement[] {
  const out: RacionalEmailPlannedMovement[] = [];
  // Scan files accumulate and overlap; see collapseBrokerEmailEventsByMessageId. A short-preview
  // copy of a conversion mail would otherwise report `requires_manual` forever next to its
  // fully-parsed twin.
  const racional = collapseBrokerEmailEventsByMessageId(
    events.filter((e) => e.broker === "racional" && e.is_transaction)
  );
  const sorted = racional.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  for (const e of sorted) {
    if (e.kind === "deposit") out.push(planDeposit(e));
    else if (e.kind === "wallet_funded") out.push(planConversion(e));
    else if (e.kind === "buy") out.push(planBuy(e));
    // dividend stays a nudge (browser crawl); portfolio_buy (CLP portafolio) is unmapped here.
  }
  return out;
}

const insTransfer = db.prepare(
  `INSERT INTO movements (from_account_id, to_account_id, amount, currency, counter_amount,
                          counter_currency, occurred_on, note, units_delta, flow_kind)
   VALUES (@from_account_id, @to_account_id, @amount, @currency, @counter_amount,
           @counter_currency, @occurred_on, @note, @units_delta, @flow_kind)`
);

export type RacionalEmailApplyResult = {
  inserted: number;
  duplicates: number;
  accounts_created: { ticker: string; account_id: number }[];
  movement_ids: number[];
};

export function applyRacionalEmailMovements(
  planned: readonly RacionalEmailPlannedMovement[]
): RacionalEmailApplyResult {
  const result: RacionalEmailApplyResult = {
    inserted: 0,
    duplicates: 0,
    accounts_created: [],
    movement_ids: [],
  };
  for (const p of planned) {
    if (p.duplicate_of != null) {
      result.duplicates += 1;
      continue;
    }
    if (p.requires_manual != null) continue;

    let toAccountId = p.to_account_id;
    if (p.create_account) {
      // Re-check inside the apply: an earlier planned buy in this same batch may have created it.
      const holders = accountsWithEquityTicker(p.create_account.ticker);
      if (holders.length === 1) {
        toAccountId = holders[0]!;
      } else if (holders.length === 0) {
        const created = createPanelAccount({
          account: {
            account_type: "equity",
            name: p.create_account.name,
            bucket_slug: p.create_account.bucket_slug,
            ticker: p.create_account.ticker,
            exclude_from_group_totals: false,
          },
        });
        toAccountId = created.account_id;
        result.accounts_created.push({
          ticker: p.create_account.ticker,
          account_id: created.account_id,
        });
      } else {
        throw new Error(`ticker ${p.create_account.ticker} became ambiguous during apply`);
      }
    }
    if (p.from_account_id == null || toAccountId == null) {
      throw new Error(`planned ${p.kind} on ${p.occurred_on} has unresolved legs`);
    }
    const ins = insTransfer.run({
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
    result.inserted += 1;
    result.movement_ids.push(Number(ins.lastInsertRowid));
  }
  return result;
}
