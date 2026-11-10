/**
 * Option contracts as accounts (`option_contracts`, migration 304; docs/demo-app-features-plan.md
 * §3). A contract series is its own account on a leaf under `brokerage_opciones`, named by its OCC
 * symbol; the row here holds the terms the account is valued by. `accounts.equity_ticker` stays
 * NULL on it: the EOD sync, the watchlist and `accountsWithEquityTicker` never see a contract, and
 * the mark reads the UNDERLYING's close through these terms (`holdingPrices.ts`).
 *
 * This module is the terms and the pure rules on them (the OCC symbol, the intrinsic value); the
 * ledger side — how many contracts an account holds on a day — is `optionPosition.ts`.
 */
import { db } from "./db.js";
import { dbStateMemo } from "./dbStateMemo.js";

export type OptionRight = "C" | "P";

export type OptionContractTerms = Readonly<{
  account_id: number;
  underlying_ticker: string;
  right: OptionRight;
  strike: number;
  expiry: string;
  multiplier: number;
  occ_symbol: string;
}>;

const stmtTerms = db.prepare(
  `SELECT account_id, underlying_ticker, "right", strike, expiry, multiplier, occ_symbol
   FROM option_contracts WHERE account_id = ?`
);

/** The contract an account is, or null for any other account. Memoized until the next write. */
export function optionContractForAccount(accountId: number): OptionContractTerms | null {
  if (!(accountId > 0)) return null;
  return dbStateMemo("option_contract", accountId, () => (stmtTerms.get(accountId) as OptionContractTerms | undefined) ?? null);
}

export function requireOptionContract(accountId: number): OptionContractTerms {
  const terms = optionContractForAccount(accountId);
  if (!terms) throw new Error(`account ${accountId} is not an option contract`);
  return terms;
}

export function isOptionContractAccount(accountId: number): boolean {
  return optionContractForAccount(accountId) != null;
}

const stmtAccountByOcc = db.prepare(`SELECT account_id FROM option_contracts WHERE occ_symbol = ?`);

/** The account of an OCC symbol, or null when no contract carries it. */
export function optionContractAccountIdForOcc(occSymbol: string): number | null {
  const row = stmtAccountByOcc.get(occSymbol) as { account_id: number } | undefined;
  return row?.account_id ?? null;
}

/** Thousandths of a point: the OCC strike field; a strike finer than that is refused. */
const STRIKE_SCALE = 1000;

/**
 * The OCC option symbol of a series: the root padded to six characters, the expiry as yymmdd, the
 * right, the strike × 1000 in eight digits — «SPY   250620C00600000». The one spelling of a
 * contract's identity (`option_contracts.occ_symbol`, the account's leaf slug and import key).
 */
export function occSymbol(t: { underlying_ticker: string; expiry: string; right: OptionRight; strike: number }): string {
  const root = t.underlying_ticker.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,5}$/.test(root)) throw new Error(`occSymbol: underlying ${JSON.stringify(t.underlying_ticker)} is not an OCC root`);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t.expiry);
  if (!m) throw new Error(`occSymbol: expiry ${JSON.stringify(t.expiry)} is not YYYY-MM-DD`);
  if (t.right !== "C" && t.right !== "P") throw new Error(`occSymbol: right ${JSON.stringify(t.right)} is not C or P`);
  const scaled = t.strike * STRIKE_SCALE;
  if (!(t.strike > 0) || !Number.isFinite(scaled) || Math.abs(scaled - Math.round(scaled)) > 1e-6 || scaled >= 1e8) {
    throw new Error(`occSymbol: strike ${t.strike} is not a positive price in whole thousandths below 100000`);
  }
  return `${root.padEnd(6, " ")}${m[1]!.slice(2)}${m[2]}${m[3]}${t.right}${String(Math.round(scaled)).padStart(8, "0")}`;
}

/** The leaf slug / import key spelling of an OCC symbol: lowercase, nothing but [a-z0-9]. */
export function occSymbolSlug(occ: string): string {
  return occ.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** «SPY 2025-06-20 C 600»: the account's default name. */
export function optionContractDisplayName(t: {
  underlying_ticker: string;
  expiry: string;
  right: OptionRight;
  strike: number;
}): string {
  const strike = Number.isInteger(t.strike) ? String(t.strike) : String(Math.round(t.strike * STRIKE_SCALE) / STRIKE_SCALE);
  return `${t.underlying_ticker.toUpperCase()} ${t.expiry} ${t.right} ${strike}`;
}

/**
 * The intrinsic value of ONE share of the contract on `ymd` from the underlying's close that day:
 * max(0, S − K) for a call, max(0, K − S) for a put while unexpired; 0 on and after the expiry
 * (the contract has settled — an assignment or an expiry row records what it did). Time value is
 * not priced: no history source exists for a contract (stated on the account page).
 */
export function optionIntrinsicPerShare(
  t: Pick<OptionContractTerms, "right" | "strike" | "expiry">,
  underlyingClose: number,
  ymd: string
): number {
  if (ymd >= t.expiry) return 0;
  if (!Number.isFinite(underlyingClose)) throw new Error(`optionIntrinsicPerShare: underlying close ${underlyingClose} on ${ymd}`);
  return Math.max(0, t.right === "C" ? underlyingClose - t.strike : t.strike - underlyingClose);
}
