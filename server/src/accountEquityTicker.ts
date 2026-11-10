import { dbStateMemo } from "./dbStateMemo.js";
import { equityMarketKind } from "./equityQuote.js";
import { db } from "./db.js";
import { BROKERAGE_SHARE_UNITS_FLOW_KINDS } from "./shareUnitsFlowKinds.js";

const stmtEquityTicker = db.prepare(
  `SELECT equity_ticker FROM accounts WHERE id = ?`
);

const stmtDistinctTickers = db.prepare(
  `SELECT DISTINCT equity_ticker AS t
   FROM accounts
   WHERE equity_ticker IS NOT NULL AND trim(equity_ticker) != ''
   ORDER BY t`
);

/** Yahoo symbol stored on the account (SPY, OILK, BTC-USD, …). */
export function equityTickerForAccount(accountId: number): string | null {
  return dbStateMemo("account_equity_ticker", accountId, () => {
    const row = stmtEquityTicker.get(accountId) as { equity_ticker: string | null } | undefined;
    const t = row?.equity_ticker?.trim();
    return t ? t.toUpperCase() : null;
  });
}

const stmtAccountsByTicker = db.prepare(
  `SELECT id FROM accounts WHERE UPPER(TRIM(equity_ticker)) = ?`
);

/** Every account holding a symbol — for callers that handle 0/many themselves (auto-create). */
export function accountsWithEquityTicker(ticker: string): number[] {
  const symbol = String(ticker ?? "").trim().toUpperCase();
  if (!symbol) return [];
  const rows = stmtAccountsByTicker.all(symbol) as { id: number }[];
  return rows.map((r) => r.id);
}

/** The share trades (a split is a single-leg row and names no cash account). */
const SHARE_TRADE_FLOW_KINDS = BROKERAGE_SHARE_UNITS_FLOW_KINDS.filter((k) => k !== "stock_split");

const stmtTradesAgainstCash = db.prepare(
  `SELECT 1 FROM movements
   WHERE flow_kind IN (${SHARE_TRADE_FLOW_KINDS.map(() => "?").join(", ")})
     AND ((from_account_id = @stock AND to_account_id = @cash) OR (from_account_id = @cash AND to_account_id = @stock))
   LIMIT 1`
);

/**
 * The holders of a symbol whose shares were traded against `cashAccountId` — the broker's cash
 * account on the other side of a buy or a sale, the evidence `equityBrokerHoldings.ts` groups a
 * position by. Two accounts may hold one ticker (the demo's Roth IRA holds SPY beside the
 * brokerage SPY account); the cash leg tells them apart.
 */
export function accountsWithEquityTickerAtBroker(ticker: string, cashAccountId: number): number[] {
  return accountsWithEquityTicker(ticker).filter(
    (stock) => stmtTradesAgainstCash.get(...SHARE_TRADE_FLOW_KINDS, { stock, cash: cashAccountId }) != null
  );
}

/**
 * The account holding a symbol — the reverse of {@link equityTickerForAccount}, and the only
 * sanctioned way for an importer to turn a broker's ticker into an account.
 *
 * Zero holders throws: the position does not exist yet (a first-ever purchase of something new,
 * which should be created deliberately in the panel, not invented by an importer). One holder is
 * the account, whatever `brokerCashAccountId` says. Several holders resolve only through the
 * broker's cash account ({@link accountsWithEquityTickerAtBroker}): exactly one of them must have
 * traded against it, else the ticker is ambiguous and this throws.
 */
export function accountIdForEquityTicker(ticker: string, opts: { brokerCashAccountId?: number } = {}): number {
  const symbol = String(ticker ?? "").trim().toUpperCase();
  if (!symbol) throw new Error("accountIdForEquityTicker: empty ticker");
  const rows = stmtAccountsByTicker.all(symbol) as { id: number }[];
  if (rows.length === 1) return rows[0]!.id;
  if (rows.length === 0) {
    throw new Error(
      `Expected exactly one account with equity_ticker "${symbol}", found 0. ` +
        `Create the position in the panel first (it sets accounts.equity_ticker).`
    );
  }
  if (opts.brokerCashAccountId == null) {
    throw new Error(
      `Expected exactly one account with equity_ticker "${symbol}", found ${rows.length}. ` +
        `Resolve it through the broker's cash account (accountIdForEquityTicker(ticker, { brokerCashAccountId })).`
    );
  }
  const atBroker = accountsWithEquityTickerAtBroker(symbol, opts.brokerCashAccountId);
  if (atBroker.length !== 1) {
    throw new Error(
      `${rows.length} accounts hold equity_ticker "${symbol}" and ${atBroker.length} of them traded against ` +
        `cash account ${opts.brokerCashAccountId}; expected exactly one.`
    );
  }
  return atBroker[0]!;
}

/** Fail fast when an equity-MTM account has no `equity_ticker` in DB. */
export function requireEquityTicker(accountId: number): string {
  const ticker = equityTickerForAccount(accountId);
  if (!ticker) {
    throw new Error(
      `account ${accountId}: equity_ticker is required (set at import or panel create; re-run migration 089 backfill if legacy account)`
    );
  }
  return ticker;
}

/** All distinct symbols for marquee live quotes and NYSE/crypto EOD sync. */
export function listDistinctEquityTickersForSync(): string[] {
  const rows = stmtDistinctTickers.all() as { t: string }[];
  return rows.map((r) => r.t.trim().toUpperCase()).filter(Boolean);
}

/** NYSE-listed symbols from `accounts.equity_ticker` (excludes BTC-USD / ETH-USD). */
export function listNyseEquityTickersForEodSync(): string[] {
  return listDistinctEquityTickersForSync().filter((t) => equityMarketKind(t) === "nyse");
}
