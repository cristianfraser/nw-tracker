/**
 * Realized disposals in a window, from the lot walks (`taxLots.ts` over each account's lot events):
 * shares and ETFs (`equityTaxLotEvents.ts`), coins (`cryptoTaxLotEvents.ts`) and fund cuotas
 * ({@link fundTaxLotEvents}). Each disposal carries what the walk gives — the units, the proceeds,
 * and the slices it consumed with each purchase's date and cost — in the currency the account
 * trades in (dollars for a US-listed share, pesos for a Santiago listing or a peso fund; the coins
 * are the exchange's, bought and sold with its peso wallet). No conversion, no reajuste, no code.
 *
 * The lot method (and, for coins, whether a trade's commission is part of its cost) is the return's
 * choice, so it is a parameter: the walk is the same, the identification differs by law. Accounts are
 * walked by id; within an account, in the walk's order (the ledger's date order).
 *
 * The dollars of a USD cash account are lots too (`usdCashTaxLotEvents.ts`), but priced in pesos at
 * the dólar observado by the Chilean oficios' rules: that walk stays the F22's (`f22/usdFx.ts`).
 */
import { db } from "../db.js";
import { inDateWindow, type DateWindow } from "../dateWindow.js";
import { loadCryptoCoinAccountIdsFundedByBuda } from "../budaWallet.js";
import { loadCryptoTaxLotEvents, type CryptoFeePolicy } from "../cryptoTaxLotEvents.js";
import { equityMarketKind, type EquityMarketKind } from "../equityQuote.js";
import { loadEquityTaxLotEvents } from "../equityTaxLotEvents.js";
import { optionAssignmentAdjustments } from "../optionTaxLotEvents.js";
import { realizeTaxLots, type TaxLotDisposal, type TaxLotEvent, type TaxLotMethod } from "../taxLots.js";

export type DisposalKind = "equity" | "crypto" | "fund";

/** One realized disposal: the lot walk's, with the account and the currency its amounts are in. */
export type DisposalFact = TaxLotDisposal & {
  kind: DisposalKind;
  accountId: number;
  accountName: string;
  /** The equity or coin ticker; null for a fund (its series is on the account). */
  instrument: string | null;
  /** The currency of `proceeds`, `cost`, `gain` and every slice's cost. */
  currency: string;
};

/** An account that holds shares or ETFs (an equity ticker that is not a coin), with its market. */
export type EquityLotAccount = { accountId: number; accountName: string; ticker: string; market: EquityMarketKind };

/** The accounts {@link equityAccountDisposalFacts} walks: an id, a name and the ticker. */
export type EquityLotAccountRef = Pick<EquityLotAccount, "accountId" | "accountName" | "ticker">;

/** One equity account's lots: the currency it trades in (null: no trades) and its disposals in the window. */
export type EquityAccountDisposals = { account: EquityLotAccountRef; currency: string | null; disposals: DisposalFact[] };

/** Every account with an equity ticker whose market is not crypto, by id. */
export function equityLotAccounts(): EquityLotAccount[] {
  const rows = db
    .prepare(`SELECT id, name, equity_ticker FROM accounts WHERE COALESCE(equity_ticker, '') <> '' ORDER BY id`)
    .all() as { id: number; name: string; equity_ticker: string }[];
  return rows
    .map((a) => ({ accountId: a.id, accountName: a.name, ticker: a.equity_ticker, market: equityMarketKind(a.equity_ticker) }))
    .filter((a) => a.market !== "crypto24");
}

/**
 * The disposals of each of `accounts` in the window, in the accounts' order. `currency`: only the
 * accounts trading in it are walked (the others come back with no disposals and their currency).
 * `optionAdjustments`: an option assignment or exercise moves its premium into the share trade it
 * settles (`optionAssignmentAdjustments`: an assigned put lowers the shares' cost, an assigned call
 * raises the sale's proceeds — US law, Pub. 550; the 1040 turns it on). The F22 leaves it off: a
 * Chilean-resident window with options throws (Ley 20.544 not modelled) and a non-resident one
 * excludes the foreign shares, so the Chilean reading never needs it.
 */
export function equityAccountDisposalFacts(
  window: DateWindow,
  opts: { method: TaxLotMethod; accounts: readonly EquityLotAccountRef[]; currency?: string; optionAdjustments?: boolean }
): EquityAccountDisposals[] {
  return opts.accounts.map((account) => {
    const { currency, events } = loadEquityTaxLotEvents(account.accountId, opts.optionAdjustments ? optionAssignmentAdjustments(account.accountId) : undefined);
    if (opts.currency != null && currency !== opts.currency) return { account, currency, disposals: [] };
    const disposals = realizeTaxLots(events, opts.method)
      .disposals.filter((d) => inDateWindow(d.date, window))
      .map(
        (d): DisposalFact => ({
          ...d,
          kind: "equity",
          accountId: account.accountId,
          accountName: account.accountName,
          instrument: account.ticker,
          // A disposal implies trades, so the account has a currency.
          currency: currency!,
        })
      );
    return { account, currency, disposals };
  });
}

/** Every equity disposal of the window (all {@link equityLotAccounts}, or those trading in `currency`). */
export function equityDisposalFacts(window: DateWindow, opts: { method: TaxLotMethod; currency?: string }): DisposalFact[] {
  return equityAccountDisposalFacts(window, { ...opts, accounts: equityLotAccounts() }).flatMap((a) => a.disposals);
}

/** The coin accounts (the exchange's coins, funded from its peso wallet), by id, with their ticker. */
export function cryptoLotAccounts(): { accountId: number; coin: string }[] {
  const stmt = db.prepare(`SELECT equity_ticker FROM accounts WHERE id = ?`);
  return [...loadCryptoCoinAccountIdsFundedByBuda()]
    .sort((a, b) => a - b)
    .map((accountId) => ({ accountId, coin: (stmt.get(accountId) as { equity_ticker: string }).equity_ticker }));
}

/** The coins sold in the window, account by account (pesos: the exchange's wallet). */
export function cryptoDisposalFacts(
  window: DateWindow,
  opts: { method: TaxLotMethod; feePolicy: CryptoFeePolicy }
): DisposalFact[] {
  const names = db.prepare(`SELECT name FROM accounts WHERE id = ?`);
  return cryptoLotAccounts().flatMap(({ accountId, coin }) =>
    realizeTaxLots(loadCryptoTaxLotEvents(accountId, opts.feePolicy), opts.method)
      .disposals.filter((d) => inDateWindow(d.date, window))
      .map(
        (d): DisposalFact => ({
          ...d,
          kind: "crypto",
          accountId,
          accountName: (names.get(accountId) as { name: string }).name,
          instrument: coin,
          currency: "clp",
        })
      )
  );
}

/**
 * A fund account's deposits and redemptions as lot events (units = cuotas, amounts in the currency
 * the movements are in — `currency`, null without movements; two currencies throw).
 */
export function fundTaxLotEvents(accountId: number): { currency: string | null; events: TaxLotEvent[] } {
  const rows = db
    .prepare(
      `SELECT id, occurred_on, account_id, to_account_id, amount, currency, units_delta FROM movements
        WHERE ? IN (account_id, from_account_id, to_account_id)`
    )
    .all(accountId) as {
    id: number;
    occurred_on: string;
    account_id: number | null;
    to_account_id: number | null;
    amount: number;
    currency: string;
    units_delta: number | null;
  }[];
  const currencies = [...new Set(rows.map((r) => r.currency))];
  if (currencies.length > 1) throw new Error(`Fund lots: account ${accountId} moves cuotas in ${currencies.join(" and ")}`);
  const events: TaxLotEvent[] = rows.map((r) => {
    if (r.units_delta == null || r.units_delta === 0) {
      throw new Error(`Fund lots: account ${accountId} movement ${r.id} has no cuotas`);
    }
    const inflow = r.to_account_id === accountId || (r.account_id === accountId && r.units_delta > 0);
    const units = Math.abs(r.units_delta);
    return inflow
      ? { kind: "acquire", date: r.occurred_on, movementId: r.id, units, cost: Math.abs(r.amount) }
      : { kind: "dispose", date: r.occurred_on, movementId: r.id, units, proceeds: Math.abs(r.amount) };
  });
  const rank = (e: TaxLotEvent) => (e.kind === "acquire" ? 0 : 1);
  return {
    currency: currencies[0] ?? null,
    events: events.sort((a, b) => a.date.localeCompare(b.date) || rank(a) - rank(b) || a.movementId - b.movementId),
  };
}

/** An account priced by a fund series (`accounts.fund_series_key`). */
export type FundLotAccount = { accountId: number; accountName: string; seriesKey: string };

/** Every account with a fund series, by id. */
export function fundLotAccounts(): FundLotAccount[] {
  return (
    db.prepare(`SELECT id, name, fund_series_key FROM accounts WHERE fund_series_key IS NOT NULL ORDER BY id`).all() as {
      id: number;
      name: string;
      fund_series_key: string;
    }[]
  ).map((r) => ({ accountId: r.id, accountName: r.name, seriesKey: r.fund_series_key }));
}

/** The cuotas redeemed in the window from each of `accounts`, in their order. */
export function fundDisposalFacts(
  window: DateWindow,
  opts: { method: TaxLotMethod; accounts: readonly FundLotAccount[] }
): DisposalFact[] {
  return opts.accounts.flatMap((a) => {
    const { currency, events } = fundTaxLotEvents(a.accountId);
    return realizeTaxLots(events, opts.method)
      .disposals.filter((d) => inDateWindow(d.date, window))
      .map((d): DisposalFact => ({ ...d, kind: "fund", accountId: a.accountId, accountName: a.accountName, instrument: null, currency: currency! }));
  });
}
