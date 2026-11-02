/**
 * What an account holds (`docs/holdings-currency-plan.md`): its value at a date is a quantity of
 * that holding, converted once into a display unit.
 *
 * - `currency`: pesos, dollars, UF, euros (cash ledgers, checking, stored-mark accounts, the
 *   property and the mortgage).
 * - `stock`: shares of a ticker, priced in the ticker's quote currency.
 * - `coin`: a crypto coin (BTC, ETH), priced by its price series (`BTC-USD`) in dollars — the
 *   account holds the coin, the series is only where its price lives.
 * - `fund`: cuotas of a fund series (AFP, AFC, Fintual funds), priced in pesos.
 * - `card`: a credit card holds no currency of its own — it holds sub-balances, one per
 *   facturación and currency.
 *
 * Derived from the account's kind and its identity columns (the rules the valuation stack
 * already keys on), in one place; an account that fits none throws.
 */
import { equityTickerForAccount } from "./accountEquityTicker.js";
import { accountKindSlugForAccountId } from "./accountBucket.js";
import { fundSeriesKeyForAccount } from "./accountFundSeriesKey.js";
import { AFP_UNO_CUOTA_SERIES_KEY } from "./afpUnoSeries.js";
import { accountUsesCryptoMtm, cryptoEquityTickerForAccount } from "./cryptoValuation.js";
import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import { equityQuoteCurrency } from "./equityQuote.js";
import { isFintualCertV2AccountNotes } from "./fintualCertV2.js";
import { db } from "./db.js";
import { dbStateMemo } from "./dbStateMemo.js";
import type { CurrencyCode } from "./rates.js";

export type Holding =
  | { kind: "currency"; code: CurrencyCode }
  | { kind: "stock"; ticker: string; quote: CurrencyCode }
  | { kind: "coin"; coin: string; priceTicker: string; quote: CurrencyCode }
  | { kind: "fund"; seriesKey: string; quote: CurrencyCode }
  | { kind: "card" };

/** The facts {@link holdingFromFacts} reads, so the rule is testable without a database. */
export type HoldingFacts = {
  kindSlug: string;
  importKey: string | null;
  equityTicker: string | null;
  /** The account's coin price series when it is valued from coin units. */
  coinPriceTicker: string | null;
  /** True when the account is valued from share units (an equity position). */
  usesEquityMtm: boolean;
  fundSeriesKey: string | null;
  /** The quote currency of `equityTicker`, read only when it is a stock. */
  quoteCurrencyOf: (ticker: string) => CurrencyCode;
};

const CURRENCY_BY_KIND: Readonly<Record<string, CurrencyCode>> = {
  usd: "usd",
  clp: "clp",
  property: "uf",
  mortgage: "uf",
};

export function holdingFromFacts(f: HoldingFacts): Holding {
  if (f.kindSlug === "credit_card") return { kind: "card" };
  if (f.coinPriceTicker) {
    const coin = f.coinPriceTicker.replace(/-USD$/i, "").toUpperCase();
    return { kind: "coin", coin, priceTicker: f.coinPriceTicker, quote: "usd" };
  }
  if (f.equityTicker && f.usesEquityMtm) {
    return { kind: "stock", ticker: f.equityTicker, quote: f.quoteCurrencyOf(f.equityTicker) };
  }
  if (f.kindSlug === "afp") {
    return { kind: "fund", seriesKey: f.fundSeriesKey ?? AFP_UNO_CUOTA_SERIES_KEY, quote: "clp" };
  }
  if (f.kindSlug === "afc" && f.fundSeriesKey) {
    return { kind: "fund", seriesKey: f.fundSeriesKey, quote: "clp" };
  }
  if (isFintualCertV2AccountNotes(f.importKey)) {
    if (!f.fundSeriesKey) {
      throw new Error(`holding: Fintual fund account (${f.importKey}) has no fund_series_key`);
    }
    return { kind: "fund", seriesKey: f.fundSeriesKey, quote: "clp" };
  }
  const code = CURRENCY_BY_KIND[f.kindSlug];
  if (code) return { kind: "currency", code };
  // Every other kind keeps a peso ledger or a peso book mark (checking, DAP, savings, manual
  // marks, an AFC without a cuota series, a stock account before its first share).
  return { kind: "currency", code: "clp" };
}

const stmtAccountFacts = db.prepare(`SELECT import_key FROM accounts WHERE id = ?`);

/** What `accountId` holds. Memoized until the next database write. */
export function accountHolding(accountId: number): Holding {
  return dbStateMemo("account_holding", accountId, () => {
    const kindSlug = accountKindSlugForAccountId(accountId);
    if (kindSlug == null) throw new Error(`holding: account ${accountId} has no asset group`);
    const row = stmtAccountFacts.get(accountId) as { import_key: string | null } | undefined;
    if (!row) throw new Error(`holding: account ${accountId} not found`);
    const equityTicker = equityTickerForAccount(accountId);
    return holdingFromFacts({
      kindSlug,
      importKey: row.import_key,
      equityTicker,
      coinPriceTicker: accountUsesCryptoMtm(accountId) ? cryptoEquityTickerForAccount(accountId) : null,
      usesEquityMtm: equityTicker != null && accountUsesEquityMtm(accountId),
      fundSeriesKey: fundSeriesKeyForAccount(accountId),
      quoteCurrencyOf: (t) => equityQuoteCurrency(t),
    });
  });
}

/** True when the account is a liability (its balance converts at the debt side). */
export function holdingIsDebt(kindSlug: string): boolean {
  return kindSlug === "mortgage" || kindSlug === "credit_card";
}
