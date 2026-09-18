/**
 * Fintual goal valuation for the evening poll: each goal's dated valuation, Fintual's OWN share
 * count per fund and the cash in transit, from the site's `/gql/` "latest accrued balance"
 * queries — the cookie-authed Apollo endpoint the web app itself reads (same `FINTUAL_COOKIE`
 * as `GET /api/goals`).
 *
 * Valor cuota for the publish day = fund valuation ÷ Fintual's shares — never ÷ the ledger's
 * cuota count. The ledger lags Fintual whenever a retiro or a deposit is in transit: on
 * 2026-09-17 a 100.000 retiro had sold 68,93 cuotas (paid 09-21, so the ledger still held them)
 * and dividing the post-sale valuation by the pre-sale count wrote four Reserva bars 1,6% low,
 * which then failed the goals-NAV reconcile and kept the source stale. The goals-API `nav`
 * still counts the payout (`pendingPaymentWithdrawalsAmount`), so ledger cuotas × true price
 * equals it by identity until the payout lands — the app keeps showing the money until then,
 * and the retiro transfer the «Pagamos tu retiro» mail synthesizes drops the cuotas on payday.
 *
 * History: publish date + cuota came from `GET /api/real_assets/:id(/days)` until those
 * endpoints moved behind a Bearer-JWT gateway (401 since 2026-09-14), then for one day from
 * the balance graph ÷ ledger cuotas (b1d2f8b). The official daily serie price is verified the
 * next day against the public endpoint (`src/fintualPublicSeriePrice.ts`), which lags a day
 * and so cannot serve the evening write itself.
 */
import type { ChileWallClock } from "../src/chileDate.js";
import { resolveFintualPublishYmd } from "../src/fintualPublishDate.js";
import { fintualGoalUnitsFromMovements } from "../src/fintualGoalUnits.js";
import { matchFintualCertGoalV2 } from "../src/fintualCertV2.js";
import { db } from "../src/db.js";
import { fetchFintualGqlDocument } from "./fintualApiLib.js";
import type { FintualGoalRow } from "./fintualApiLib.js";

export type FintualGoalRowWithMatch = FintualGoalRow & { matchedNotes: string | null };

/** goals-API nav vs shares valuation + cash in transit: beyond this the identity broke. */
const MISMATCH_CLP = 1;
/** Ledger cuotas vs Fintual's shares: beyond this the ledger is out of step with Fintual. */
const SHARES_MISMATCH_UNITS = 0.001;

/** Which `/gql/` goal family a goal dispatches to, by `goal_type` + `regime`. */
export type FintualGoalKind = "apv_a" | "apv_b" | "reserve" | "goal";

export type FintualGoalPendingBalance = {
  /** Deposits received, not yet converted into shares (the goals-API nav counts them). */
  fulfillmentDepositsClp: number;
  /** Withdrawals requested, shares not yet sold (still inside the shares valuation). */
  fulfillmentWithdrawalsClp: number;
  /** Withdrawals sold, cash not yet paid out (the goals-API nav still counts them). */
  paymentWithdrawalsClp: number;
};

export type FintualGoalFundShares = { ticker: string; shares: number; valuationClp: number };

export type FintualGoalAccruedBalance = {
  /** `investmentClosureDate` — the fund publish day the valuation is for. */
  closureYmd: string;
  accruedValuationClp: number;
  /** Σ portfolio shares valuation (user + state owned for APV-A). */
  sharesValuationClp: number;
  /** Per fund ticker, summed across the goal's portfolios. */
  funds: FintualGoalFundShares[];
  pending: FintualGoalPendingBalance;
};

export type FintualGoalFundPrice = {
  ticker: string;
  shares: number;
  valuationClp: number;
  fundPriceClp: number;
};

export type FintualGoalNavResolution = {
  row: FintualGoalRowWithMatch;
  goalsApiNavClp: number;
  /** Fintual's shares valuation for the publish day (null before 18:00, unmatched, or closure lag). */
  sharesValuationClp: number | null;
  appliedNavClp: number;
  /** Ledger cuotas (Σ movements on the v2 account) — the position the app shows. */
  units: number | null;
  /** Fintual's own share count for the fund on the publish day. */
  fintualShares: number | null;
  /** Valor cuota = fund valuation ÷ Fintual's shares (null: no shares, or closure lag). */
  fundPriceClp: number | null;
  pending: FintualGoalPendingBalance | null;
  /** goals-API nav ≠ shares valuation + cash in transit — the identity broke, inspect. */
  mismatch: boolean;
  /** Fintual's closure day is behind the publish day: no price written this poll (re-polled). */
  closureLagsPublish: boolean;
};

export type ResolveFintualGoalNavsResult = {
  resolutions: FintualGoalNavResolution[];
  /** Fund cuota publish date used for NAV and valuations (may be before or after the poll day). */
  publishYmd: string;
};

/** Per-goal accrued balances for one poll (cleared by clearFintualRealAssetNavCaches). */
const accruedBalanceCache = new Map<string, FintualGoalAccruedBalance>();

function accountIdForNotes(notes: string): number | null {
  const row = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(notes) as { id: number } | undefined;
  return row?.id ?? null;
}

export function fintualGoalKind(row: FintualGoalRowWithMatch): FintualGoalKind {
  const type = (row.goalType ?? "").toLowerCase();
  const regime = (row.regime ?? "").toLowerCase();
  if (type === "apv" && regime === "a") return "apv_a";
  if (type === "apv" && regime === "b") return "apv_b";
  if (type === "inbox") return "reserve"; // Reserva goals
  return "goal";
}

const ACCRUED_BALANCE_FIELDS: Record<
  FintualGoalKind,
  { root: string; idArg: string; invested: string; pending: string; portfolios: string[] }
> = {
  apv_a: {
    root: "clApvAGoalLatestAccruedBalance",
    idArg: "apvAGoalId",
    invested: "apvAGoalInvestedBalance",
    pending: "apvAGoalPendingBalance",
    // APV-A splits the goal into the user's own shares and the state bonus shares.
    portfolios: ["userOwnedPortfolioInvestedBalance", "stateOwnedPortfolioInvestedBalance"],
  },
  apv_b: {
    root: "clApvBGoalLatestAccruedBalance",
    idArg: "apvBGoalId",
    invested: "apvBGoalInvestedBalance",
    pending: "apvBGoalPendingBalance",
    portfolios: ["portfolioInvestedBalance"],
  },
  reserve: {
    root: "clReserveLatestAccruedBalance",
    idArg: "reserveId",
    invested: "reserveInvestedBalance",
    pending: "reservePendingBalance",
    portfolios: ["portfolioInvestedBalance"],
  },
  goal: {
    root: "clGoalLatestAccruedBalance",
    idArg: "goalId",
    invested: "goalInvestedBalance",
    pending: "goalPendingBalance",
    portfolios: ["portfolioInvestedBalance"],
  },
};

const PORTFOLIO_SELECTION =
  "{ closureDate portfolioSharesBalance { sharesValuationAmount" +
  " sharesBreakdown { sharesQuantity ticker } tickerValuationAmountsBreakdown { amount ticker } } }";

/**
 * The site's per-goal-family "latest accrued balance" query (what `GoalShowData` /
 * `ReserveShowData` / `ApvAGoalShowData` read), aliased so one parser serves every kind:
 * `balance.closureDate` is the fund publish day, `balance.invested.pN` the goal's portfolios
 * with Fintual's own `sharesQuantity` per ticker, `balance.pending` the cash in transit.
 */
export function goalAccruedBalanceQuery(kind: FintualGoalKind): { operationName: string; query: string } {
  const f = ACCRUED_BALANCE_FIELDS[kind];
  const operationName = "NwTrackerGoalAccruedBalance";
  const portfolios = f.portfolios.map((name, i) => ` p${i}: ${name} ${PORTFOLIO_SELECTION}`).join("");
  const query =
    `query ${operationName}($id: ID!) {` +
    ` balance: ${f.root}(${f.idArg}: $id) {` +
    ` calculatedAt closureDate: investmentClosureDate accruedValuationAmount` +
    ` invested: ${f.invested} { closureDate sharesValuationAmount${portfolios} }` +
    ` pending: ${f.pending} { pendingFulfillmentDepositsAmount` +
    ` pendingFulfillmentWithdrawalsAmount pendingPaymentWithdrawalsAmount }` +
    ` } }`;
  return { operationName, query };
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function num(v: unknown, what: string, ctx: string): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) {
    throw new Error(`Fintual accrued balance (${ctx}): ${what} is not a number (${String(v)})`);
  }
  return n;
}

function obj(v: unknown, what: string, ctx: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`Fintual accrued balance (${ctx}): ${what} missing from the response`);
  }
  return v as Record<string, unknown>;
}

/**
 * Parse one `goalAccruedBalanceQuery` response. Throws on any shape violation — a schema move
 * on Fintual's side must fail the poll, never write a guessed price.
 */
export function parseFintualGoalAccruedBalance(data: unknown, ctx: string): FintualGoalAccruedBalance {
  const balance = obj(obj(data, "data", ctx).balance, "balance", ctx);
  const closureYmd = typeof balance.closureDate === "string" ? balance.closureDate : "";
  if (!YMD_RE.test(closureYmd)) {
    throw new Error(`Fintual accrued balance (${ctx}): investmentClosureDate is not YYYY-MM-DD (${String(balance.closureDate)})`);
  }
  const invested = obj(balance.invested, "invested balance", ctx);
  if (typeof invested.closureDate === "string" && invested.closureDate !== closureYmd) {
    throw new Error(
      `Fintual accrued balance (${ctx}): invested closureDate ${invested.closureDate} ≠ investmentClosureDate ${closureYmd}`
    );
  }
  const sharesValuationClp = num(invested.sharesValuationAmount, "invested.sharesValuationAmount", ctx);

  const byTicker = new Map<string, { shares: number; valuationClp: number }>();
  let portfolios = 0;
  for (const key of Object.keys(invested).sort()) {
    if (!/^p\d+$/.test(key)) continue;
    const portfolio = invested[key];
    if (portfolio == null) continue; // a family without that portfolio (e.g. no state bonus)
    const po = obj(portfolio, `portfolio ${key}`, ctx);
    portfolios += 1;
    if (typeof po.closureDate === "string" && po.closureDate !== closureYmd) {
      throw new Error(
        `Fintual accrued balance (${ctx}): portfolio ${key} closureDate ${po.closureDate} ≠ ${closureYmd}`
      );
    }
    const psb = obj(po.portfolioSharesBalance, `portfolio ${key} sharesBalance`, ctx);
    const sharesBreakdown = psb.sharesBreakdown;
    const valuationBreakdown = psb.tickerValuationAmountsBreakdown;
    if (!Array.isArray(sharesBreakdown) || !Array.isArray(valuationBreakdown)) {
      throw new Error(`Fintual accrued balance (${ctx}): portfolio ${key} breakdowns are not arrays`);
    }
    const valuationByTicker = new Map<string, number>();
    for (const entry of valuationBreakdown) {
      const e = obj(entry, `portfolio ${key} valuation entry`, ctx);
      const ticker = typeof e.ticker === "string" ? e.ticker.trim() : "";
      if (!ticker) throw new Error(`Fintual accrued balance (${ctx}): valuation entry without ticker`);
      if (valuationByTicker.has(ticker)) {
        throw new Error(`Fintual accrued balance (${ctx}): duplicate valuation ticker ${ticker}`);
      }
      valuationByTicker.set(ticker, num(e.amount, `valuation amount of ${ticker}`, ctx));
    }
    for (const entry of sharesBreakdown) {
      const e = obj(entry, `portfolio ${key} shares entry`, ctx);
      const ticker = typeof e.ticker === "string" ? e.ticker.trim() : "";
      if (!ticker) throw new Error(`Fintual accrued balance (${ctx}): shares entry without ticker`);
      const shares = num(e.sharesQuantity, `sharesQuantity of ${ticker}`, ctx);
      if (shares < 0) throw new Error(`Fintual accrued balance (${ctx}): negative shares for ${ticker}`);
      const valuationClp = valuationByTicker.get(ticker);
      if (valuationClp == null) {
        throw new Error(`Fintual accrued balance (${ctx}): shares of ${ticker} carry no valuation entry`);
      }
      valuationByTicker.delete(ticker);
      const acc = byTicker.get(ticker) ?? { shares: 0, valuationClp: 0 };
      acc.shares += shares;
      acc.valuationClp += valuationClp;
      byTicker.set(ticker, acc);
    }
    if (valuationByTicker.size > 0) {
      throw new Error(
        `Fintual accrued balance (${ctx}): valuation without shares for ${[...valuationByTicker.keys()].join(", ")}`
      );
    }
  }
  if (portfolios === 0) throw new Error(`Fintual accrued balance (${ctx}): no portfolio balance in the response`);

  const pending = obj(balance.pending, "pending balance", ctx);
  return {
    closureYmd,
    accruedValuationClp: num(balance.accruedValuationAmount, "accruedValuationAmount", ctx),
    sharesValuationClp,
    funds: [...byTicker]
      .map(([ticker, v]) => ({ ticker, shares: v.shares, valuationClp: v.valuationClp }))
      .sort((a, b) => a.ticker.localeCompare(b.ticker)),
    pending: {
      fulfillmentDepositsClp: num(pending.pendingFulfillmentDepositsAmount, "pendingFulfillmentDepositsAmount", ctx),
      fulfillmentWithdrawalsClp: num(pending.pendingFulfillmentWithdrawalsAmount, "pendingFulfillmentWithdrawalsAmount", ctx),
      paymentWithdrawalsClp: num(pending.pendingPaymentWithdrawalsAmount, "pendingPaymentWithdrawalsAmount", ctx),
    },
  };
}

/**
 * The goal's single fund and its valor cuota = valuation ÷ Fintual's shares. Null for an empty
 * goal (no cuota to write); throws when the goal holds several funds — the app maps one fund
 * series per account, so a mixed goal cannot be priced without a model change.
 */
export function fintualGoalFundPrice(balance: FintualGoalAccruedBalance, ctx: string): FintualGoalFundPrice | null {
  const held = balance.funds.filter((f) => f.shares > 1e-9);
  if (held.length === 0) return null;
  if (held.length > 1) {
    throw new Error(
      `Fintual accrued balance (${ctx}): goal holds ${held.length} funds (${held.map((f) => f.ticker).join(", ")}) — one fund series per account`
    );
  }
  const f = held[0]!;
  if (!(f.valuationClp > 0)) {
    throw new Error(`Fintual accrued balance (${ctx}): ${f.ticker} has shares but no positive valuation`);
  }
  return { ...f, fundPriceClp: f.valuationClp / f.shares };
}

/** What `GET /api/goals` nav should read: the shares plus the cash in transit either way. */
export function expectedGoalsApiNavClp(balance: FintualGoalAccruedBalance): number {
  return (
    balance.sharesValuationClp +
    balance.pending.fulfillmentDepositsClp +
    balance.pending.paymentWithdrawalsClp
  );
}

/** Fetch + parse one goal's accrued balance; throws on transport, GraphQL or shape failure. */
async function fetchGoalAccruedBalance(row: FintualGoalRowWithMatch): Promise<FintualGoalAccruedBalance> {
  const cached = accruedBalanceCache.get(row.id);
  if (cached) return cached;
  const { operationName, query } = goalAccruedBalanceQuery(fintualGoalKind(row));
  const data = await fetchFintualGqlDocument(query, { id: row.id }, operationName);
  const balance = parseFintualGoalAccruedBalance(data, `${row.id} ${row.name}`);
  accruedBalanceCache.set(row.id, balance);
  return balance;
}

/**
 * Ledger cuotas for the goal. The goals-API `matchedNotes` may point at an empty legacy
 * predecessor account; the cuotas live on the v2 cert account (the same account the fund_unit
 * writer uses), so prefer whichever candidate holds a positive position.
 */
function ledgerUnitsForGoal(row: FintualGoalRowWithMatch): number | null {
  const v2Notes = matchFintualCertGoalV2(row.id, row.name);
  for (const notes of [v2Notes, row.matchedNotes]) {
    if (!notes) continue;
    const accountId = accountIdForNotes(notes);
    if (accountId == null) continue;
    const u = fintualGoalUnitsFromMovements(accountId);
    if (u != null && Number.isFinite(u) && u > 0) return u;
  }
  return null;
}

/**
 * After 18:00 Chile: resolve each mapped goal's publish-day valuation and valor cuota from its
 * `/gql/` accrued balance. A fetch or parse failure throws — the poll must fail loudly rather
 * than date or price anything by guess.
 */
export async function resolveFintualGoalNavs(
  _email: string,
  _token: string,
  rows: FintualGoalRowWithMatch[],
  cl: ChileWallClock
): Promise<ResolveFintualGoalNavsResult> {
  const useAccrued = cl.hour >= 18;
  const balances = new Map<string, FintualGoalAccruedBalance>();
  let hasTodayInSeries = false;
  let latestClosureYmd: string | null = null;

  if (useAccrued) {
    for (const row of rows) {
      if (!row.matchedNotes) continue;
      const balance = await fetchGoalAccruedBalance(row);
      balances.set(row.id, balance);
      if (balance.closureYmd === cl.ymd) hasTodayInSeries = true;
      if (!latestClosureYmd || balance.closureYmd > latestClosureYmd) latestClosureYmd = balance.closureYmd;
    }
  }

  const publishYmd = resolveFintualPublishYmd(cl, {
    hasTodayInSeries,
    lastDayDate: latestClosureYmd,
  });

  const out: FintualGoalNavResolution[] = [];
  for (const row of rows) {
    const goalsApiNavClp = row.navClp;
    const balance = balances.get(row.id);
    let sharesValuationClp: number | null = null;
    let units: number | null = null;
    let fintualShares: number | null = null;
    let fundPriceClp: number | null = null;
    let pending: FintualGoalPendingBalance | null = null;
    let mismatch = false;
    let closureLagsPublish = false;

    if (balance) {
      if (balance.closureYmd > publishYmd) {
        throw new Error(
          `Fintual: goal ${row.id} (${row.name}) closure day ${balance.closureYmd} is after the resolved publish day ${publishYmd}`
        );
      }
      closureLagsPublish = balance.closureYmd < publishYmd;
      pending = balance.pending;
      units = ledgerUnitsForGoal(row);
      if (!closureLagsPublish) {
        sharesValuationClp = balance.sharesValuationClp;
        const fund = fintualGoalFundPrice(balance, `${row.id} ${row.name}`);
        if (fund) {
          fintualShares = fund.shares;
          fundPriceClp = fund.fundPriceClp;
        }
        mismatch = Math.abs(goalsApiNavClp - expectedGoalsApiNavClp(balance)) > MISMATCH_CLP;
      }
    }

    out.push({
      row: { ...row, navClp: sharesValuationClp ?? goalsApiNavClp },
      goalsApiNavClp,
      sharesValuationClp,
      appliedNavClp: sharesValuationClp ?? goalsApiNavClp,
      units,
      fintualShares,
      fundPriceClp,
      pending,
      mismatch,
      closureLagsPublish,
    });
  }

  return { resolutions: out, publishYmd };
}

function formatUnits(n: number): string {
  return n.toLocaleString("es-CL", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

/**
 * One log line per goal worth a human's eye: the nav identity broke, the ledger's cuotas differ
 * from Fintual's shares (expected while cash is in transit, a missing movement otherwise), or
 * Fintual's closure day lagged the publish day. Null when nothing is notable.
 */
export function describeFintualGoalResolution(r: FintualGoalNavResolution): string | null {
  if (r.closureLagsPublish) {
    return `${r.row.name}: Fintual closure day lags the publish day — no valor cuota written this poll`;
  }
  const parts: string[] = [];
  if (r.mismatch && r.sharesValuationClp != null && r.pending) {
    parts.push(
      `goals API $${formatClp(r.goalsApiNavClp)} ≠ shares $${formatClp(r.sharesValuationClp)}` +
        ` + pending deposits $${formatClp(r.pending.fulfillmentDepositsClp)}` +
        ` + pending payout $${formatClp(r.pending.paymentWithdrawalsClp)}`
    );
  }
  if (r.units != null && r.fintualShares != null && Math.abs(r.units - r.fintualShares) > SHARES_MISMATCH_UNITS) {
    const inTransit =
      r.pending != null && (r.pending.paymentWithdrawalsClp > 0 || r.pending.fulfillmentDepositsClp > 0);
    parts.push(
      `ledger cuotas ${formatUnits(r.units)} vs Fintual ${formatUnits(r.fintualShares)}` +
        (inTransit && r.pending
          ? ` (cash in transit: payout $${formatClp(r.pending.paymentWithdrawalsClp)}, deposits $${formatClp(r.pending.fulfillmentDepositsClp)})`
          : " (no cash in transit — the ledger is out of step with Fintual)")
    );
  }
  if (parts.length === 0) return null;
  const price = r.fundPriceClp != null ? ` · valor cuota ${formatUnits(r.fundPriceClp)}` : "";
  return `${r.row.name}: ${parts.join(" · ")}${price}`;
}

export function clearFintualRealAssetNavCaches(): void {
  accruedBalanceCache.clear();
}

export function formatClp(n: number): string {
  return Math.round(n).toLocaleString("es-CL");
}
