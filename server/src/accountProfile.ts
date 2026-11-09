/**
 * One account profile, resolved once (docs/untangle-plan.md F3, docs/untangle-valuation-core.md
 * step 1). The ONLY place that decides how an account is valued: every value ladder (the past
 * mark, today's value, the position, the chart's per-account lines, the liability totals) is a
 * `switch (profile.quantity.kind)` whose branches read the facts resolved here, never a predicate
 * of their own.
 *
 * `profileFromFacts` is pure (tested on synthetic facts); `accountProfile` gathers the facts from
 * the database and memoizes the profile until the next write (`dbStateMemo`).
 */
import { equityTickerForAccount } from "./accountEquityTicker.js";
import { AFP_UNO_CUOTA_SERIES_KEY } from "./afpUnoSeries.js";
import {
  accountHasRole,
  storedRolesOfAccount,
  CARTOLA_CHECKING_KIND_SLUGS,
  type StoredAccountRole,
} from "./accountRoles.js";
import { deploymentProfile } from "./config.js";
import { db } from "./db.js";
import { dbStateMemo } from "./dbStateMemo.js";
import { equityMarketKind, equityQuoteCurrency } from "./equityQuote.js";
import { isFintualGoalImportKey } from "./fintualGoals.js";
import { MONTH_PRECISION_ACCOUNT_KIND_SLUGS } from "./monthPrecisionAccountKinds.js";
import { BROKERAGE_SHARE_UNITS_FLOW_KINDS } from "./shareUnitsFlowKinds.js";
import type { CurrencyCode } from "./rates.js";

export type Holding =
  | { kind: "currency"; code: CurrencyCode }
  | { kind: "stock"; ticker: string; quote: CurrencyCode }
  | { kind: "coin"; coin: string; priceTicker: string; quote: CurrencyCode }
  | { kind: "fund"; seriesKey: string; quote: CurrencyCode }
  | { kind: "card" };

/** How a day's quantity of the account's holding is found — the branch every ladder takes. */
export type QuantitySource =
  /** Σ cuotas (movements + transfer legs) × the fund's valor cuota (AFP, AFC with a series). */
  | { kind: "cuota_ledger"; seriesKey: string }
  /** A Fintual goal's cuotas × its fund's valor cuota (the Risky Norris proxy in its window). */
  | { kind: "fintual_goal"; seriesKey: string; goalId: string | null }
  /** The cartola checking ledger (cuenta corriente / vista). */
  | { kind: "checking_ledger" }
  /** A dollar ledger: Σ dollar movements. */
  | { kind: "usd_ledger" }
  /** A peso ledger: Σ peso movements (a broker's peso balance, a caja, MACH). */
  | { kind: "clp_ledger" }
  /** Share units × the ticker's close. */
  | { kind: "stock"; ticker: string }
  /** Coin units × the coin's dollar close; no other value source (a missing close throws). */
  | { kind: "coin"; priceTicker: string }
  /** The depto ledger's net equity (pesos, until the loan phase of the holdings plan). */
  | { kind: "depto_property"; propertyAccountId: number }
  /** The depto ledger's balance of the loan of `propertyAccountId` (null: no property on file). */
  | { kind: "depto_loan"; propertyAccountId: number | null }
  /** The card's owed walk (`cardValueInUnit`). */
  | { kind: "card" }
  /** Stored valuations, carried forward with the flows since (book marks). */
  | { kind: "book_mark" };

export type QuantityKind = QuantitySource["kind"];

/** The monthly performance builder (`monthlyPerfRowsForAccount`). */
export type PerfBuilder = "valuation_series" | "ledger_cash" | "book_valuation";

export type AccountRoles = Readonly<{
  /** `broker_cash` params (`fintual|usd`, …). */
  brokerCash: readonly string[];
  budaWallet: boolean;
  fintualGoalId: string | null;
  property: boolean;
  /** The property this account is the loan of (`loan_of`). */
  loanOf: number | null;
  lenderPatterns: readonly string[];
}>;

export type AccountProfile = Readonly<{
  id: number;
  name: string;
  importKey: string | null;
  /** `asset_groups.slug` of the account's leaf. */
  leafSlug: string;
  /** Behaviour kind (`accountBucketKindSlug(leafSlug)`). */
  kind: string;
  holding: Holding;
  /** The ONE liability predicate: a debt's value converts at the debt side and its P/L runs opposite. */
  side: "asset" | "debt";
  quantity: QuantitySource;
  /** True when the quantity is money itself (no instrument price). */
  priceless: boolean;
  /** Book-value carry applies to a stored mark (never a card's or a loan's balance). */
  flowCarry: boolean;
  perf: PerfBuilder;
  monthPrecision: boolean;
  /** False for liabilities: their charts draw no cumulative deposits line. */
  chartDeposits: boolean;
  roles: AccountRoles;
}>;

/** What {@link profileFromFacts} reads, so the rule is testable without a database. */
export type AccountProfileFacts = {
  id: number;
  name: string;
  importKey: string | null;
  leafSlug: string;
  kind: string;
  equityTicker: string | null;
  /** The coin's price ticker when the account is valued from coin units. */
  coinPriceTicker: string | null;
  /** True when the account is valued from share units (an equity position). */
  usesEquityMtm: boolean;
  fundSeriesKey: string | null;
  /** The quote currency of a ticker (read only for a stock). */
  quoteCurrencyOf: (ticker: string) => CurrencyCode;
  roles: readonly { role: StoredAccountRole; param: string }[];
  /** A demo or test database: an AFP account without a series prices with UNO Fondo A. */
  demoOrTest: boolean;
};

const DEBT_KINDS: ReadonlySet<string> = new Set(["credit_card", "mortgage"]);

/** True when the behaviour kind's balance is a debt (the one liability predicate, by kind). */
export function kindIsDebt(kind: string | null | undefined): boolean {
  return kind != null && DEBT_KINDS.has(kind);
}

/** Kinds valued from a cuota ledger (with a series). */
export const CUOTA_LEDGER_KINDS: ReadonlySet<string> = new Set(["afp", "afc"]);

/**
 * Pension kinds funded from payroll (pre-tax cotizaciones): their inflows come from the employer,
 * never through checking — no outflow to pair, shown apart from the post-tax deposits.
 */
export const PAYROLL_FUNDED_KINDS: ReadonlySet<string> = CUOTA_LEDGER_KINDS;

/** The term-deposit kind: its round-trips are netted on the checking side, never paired. */
export const TERM_DEPOSIT_KIND = "dap";

function rolesFromRows(rows: readonly { role: StoredAccountRole; param: string }[]): AccountRoles {
  const params = (role: StoredAccountRole) => rows.filter((r) => r.role === role).map((r) => r.param);
  const loanOf = params("loan_of");
  if (loanOf.length > 1) throw new Error(`account roles: one account is the loan of ${loanOf.length} properties`);
  const goal = params("fintual_goal");
  if (goal.length > 1) throw new Error(`account roles: one account holds ${goal.length} Fintual goals`);
  return {
    brokerCash: params("broker_cash"),
    budaWallet: params("buda_wallet").length > 0,
    fintualGoalId: goal[0] ?? null,
    property: params("property").length > 0,
    loanOf: loanOf.length ? Number(loanOf[0]) : null,
    lenderPatterns: params("lender_pattern"),
  };
}

function quantityFromFacts(f: AccountProfileFacts, roles: AccountRoles): QuantitySource {
  if (f.kind === "credit_card") return { kind: "card" };
  if (f.kind === "mortgage") return { kind: "depto_loan", propertyAccountId: roles.loanOf };
  // A property reads its own depto ledger (one per `property` role holder).
  if (f.kind === "property") return { kind: "depto_property", propertyAccountId: f.id };
  if (f.coinPriceTicker && f.usesEquityMtm) {
    throw new Error(`account profile: account ${f.id} is valued both from coin units and from share units`);
  }
  if (f.coinPriceTicker) return { kind: "coin", priceTicker: f.coinPriceTicker };
  if (f.usesEquityMtm) {
    if (!f.equityTicker) throw new Error(`account profile: account ${f.id} has share units but no equity_ticker`);
    return { kind: "stock", ticker: f.equityTicker };
  }
  if (CUOTA_LEDGER_KINDS.has(f.kind)) {
    if (f.fundSeriesKey) return { kind: "cuota_ledger", seriesKey: f.fundSeriesKey };
    // An AFC without a series is not modeled in cuotas: its stored marks are its value.
    if (f.kind === "afc") return { kind: "book_mark" };
    if (!f.demoOrTest) {
      throw new Error(`account profile: AFP account ${f.id} has no fund_series_key (accounts.fund_series_key)`);
    }
    return { kind: "cuota_ledger", seriesKey: AFP_UNO_CUOTA_SERIES_KEY };
  }
  if (isFintualGoalImportKey(f.importKey)) {
    if (!f.fundSeriesKey) throw new Error(`account profile: Fintual fund account ${f.id} has no fund_series_key`);
    return { kind: "fintual_goal", seriesKey: f.fundSeriesKey, goalId: roles.fintualGoalId };
  }
  if (CARTOLA_CHECKING_KIND_SLUGS.has(f.kind)) return { kind: "checking_ledger" };
  if (f.kind === "usd") return { kind: "usd_ledger" };
  if (f.kind === "clp") return { kind: "clp_ledger" };
  return { kind: "book_mark" };
}

function holdingFromQuantity(f: AccountProfileFacts, q: QuantitySource): Holding {
  switch (q.kind) {
    case "card":
      return { kind: "card" };
    case "coin":
      return { kind: "coin", coin: q.priceTicker.replace(/-USD$/i, "").toUpperCase(), priceTicker: q.priceTicker, quote: "usd" };
    case "stock":
      return { kind: "stock", ticker: q.ticker, quote: f.quoteCurrencyOf(q.ticker) };
    case "cuota_ledger":
    case "fintual_goal":
      return { kind: "fund", seriesKey: q.seriesKey, quote: "clp" };
    case "usd_ledger":
      return { kind: "currency", code: "usd" };
    case "depto_property":
    case "depto_loan":
      // What the bank and the appraisals state; valued in pesos until the loan phase.
      return { kind: "currency", code: "uf" };
    default:
      // Peso ledgers and peso book marks (checking, DAP, savings, manual marks, an AFC without a
      // cuota series, a stock account before its first share).
      return { kind: "currency", code: "clp" };
  }
}

export function profileFromFacts(f: AccountProfileFacts): AccountProfile {
  const roles = rolesFromRows(f.roles);
  const quantity = quantityFromFacts(f, roles);
  const side = kindIsDebt(f.kind) ? "debt" : "asset";
  const priceless = !(
    quantity.kind === "stock" ||
    quantity.kind === "coin" ||
    quantity.kind === "cuota_ledger" ||
    quantity.kind === "fintual_goal"
  );
  const perf: PerfBuilder =
    quantity.kind === "checking_ledger" || quantity.kind === "usd_ledger" || quantity.kind === "clp_ledger"
      ? "ledger_cash"
      : f.kind === "cuenta_ahorro_vivienda"
        ? "book_valuation"
        : "valuation_series";
  return {
    id: f.id,
    name: f.name,
    importKey: f.importKey,
    leafSlug: f.leafSlug,
    kind: f.kind,
    holding: holdingFromQuantity(f, quantity),
    side,
    quantity,
    priceless,
    flowCarry: side === "asset",
    perf,
    monthPrecision: MONTH_PRECISION_ACCOUNT_KIND_SLUGS.has(f.kind),
    chartDeposits: side === "asset" && f.kind !== "other_debt",
    roles,
  };
}

const stmtAccount = db.prepare(
  `SELECT a.name, a.import_key, a.fund_series_key, g.slug AS leaf_slug, pg.kind_slug AS leaf_kind
   FROM accounts a
   JOIN asset_groups g ON g.id = a.asset_group_id
   LEFT JOIN portfolio_groups pg ON pg.slug = g.slug
   WHERE a.id = ?`
);

const shareUnitsFlowPh = BROKERAGE_SHARE_UNITS_FLOW_KINDS.map(() => "?").join(", ");
const stmtHasShareUnits = db.prepare(
  `SELECT 1 FROM movements
   WHERE (account_id = ? OR to_account_id = ?)
     AND flow_kind IN (${shareUnitsFlowPh})
     AND COALESCE(units_delta, 0) != 0
   LIMIT 1`
);
const stmtHasOwnUnits = db.prepare(`SELECT 1 FROM movements WHERE account_id = ? AND units_delta IS NOT NULL LIMIT 1`);

/**
 * The account's behaviour kind from its leaf: the leaf portfolio group's kind, else the legacy
 * `parent__kind` segment (`accountBucketKindSlug`'s rule).
 */
function leafKind(leafSlug: string, portfolioKind: string | null): string {
  if (portfolioKind) return portfolioKind;
  const sep = leafSlug.lastIndexOf("__");
  return sep >= 0 ? leafSlug.slice(sep + 2) : leafSlug;
}

/** Coin kinds whose price series is implied by the leaf when the account names no ticker. */
const COIN_TICKER_BY_KIND: Readonly<Record<string, string>> = { bitcoin: "BTC-USD", eth: "ETH-USD" };

/**
 * The coin's price ticker when the account is valued from coin units: a ticker on a 24h crypto
 * market (`equityMarketKind`, `market_symbols`), else the leaf's coin; null without coin units.
 */
function coinPriceTicker(accountId: number, kind: string, equityTicker: string | null): string | null {
  const ticker =
    equityTicker != null ? (equityMarketKind(equityTicker) === "crypto24" ? equityTicker : null) : COIN_TICKER_BY_KIND[kind] ?? null;
  if (!ticker) return null;
  return stmtHasOwnUnits.get(accountId) != null ? ticker : null;
}

function isDemoOrTest(): boolean {
  return deploymentProfile().demo || Boolean(process.env.VITEST);
}

/** The account's profile; throws for an id with no account (or no asset group) behind it. */
export function accountProfile(accountId: number): AccountProfile {
  const p = accountProfileOptional(accountId);
  if (!p) throw new Error(`account profile: account ${accountId} not found`);
  return p;
}

/** The account's profile, or null for an id with no account row (a synthetic chart line). */
export function accountProfileOptional(accountId: number): AccountProfile | null {
  if (!(accountId > 0)) return null;
  return dbStateMemo("account_profile", accountId, () => {
    const row = stmtAccount.get(accountId) as
      | { name: string; import_key: string | null; fund_series_key: string | null; leaf_slug: string; leaf_kind: string | null }
      | undefined;
    if (!row) return null;
    const kind = leafKind(row.leaf_slug, row.leaf_kind);
    const equityTicker = equityTickerForAccount(accountId);
    // A share flow's cash leg is never the equity side: a buy's from-account and a sell's
    // to-account are the wallet the proceeds move through (`usd` / `clp` ledgers).
    const usesEquityMtm = kind !== "usd" && kind !== "clp" && stmtHasShareUnits.get(accountId, accountId, ...BROKERAGE_SHARE_UNITS_FLOW_KINDS) != null;
    return profileFromFacts({
      id: accountId,
      name: row.name,
      importKey: row.import_key,
      leafSlug: row.leaf_slug,
      kind,
      equityTicker,
      coinPriceTicker: coinPriceTicker(accountId, kind, equityTicker),
      usesEquityMtm,
      fundSeriesKey: row.fund_series_key?.trim() || null,
      quoteCurrencyOf: (t) => equityQuoteCurrency(t),
      roles: storedRolesOfAccount(accountId),
      demoOrTest: isDemoOrTest(),
    });
  });
}

/** True when the account's balance is a debt (an id with no account row is an asset). */
export function accountIsDebt(accountId: number): boolean {
  return accountProfileOptional(accountId)?.side === "debt";
}

/** True when the account holds `role` (re-exported so profile readers need one import). */
export { accountHasRole };
