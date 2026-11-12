/**
 * The 1040's reading of the jurisdiction-neutral tax facts (`taxFacts/`): which interest,
 * dividends and disposals of a window enter the return, as dollar items at each item's own day
 * (`fx.ts`), ready for the pure schedule modules. The only database reads of the return besides the
 * stubs (`draft.ts`) and the foreign-account values below.
 *
 * - **Out of the 1040**: anything inside a US retirement account (a 401(k), an HSA, a Roth IRA —
 *   growth inside it is no income) or a Chilean treaty pension (Art. 18(4): AFP, AFC and the APV as
 *   read in `pfic.ts`); a PFIC's gains (Form 8621 owns them, `pfic.ts` decides which holdings are).
 * - **Dividends**: the gross the broker document states (`movement_dividend_details`); US tax
 *   withheld is a payment — on a Form 1042-S when the paying broker is not a US one (line 25c), on a
 *   Form 1099-DIV when it is (line 25b) —, tax another country withheld is a foreign tax (Form 1116,
 *   a later step). A dividend in dollars without its document throws; a peso distribution without
 *   one is the amount credited (no tax withheld on file).
 * - **Disposals**: FIFO, every broker (shares and ETFs that are not PFICs) and the coins at the
 *   exchange (commission inside the cost and the proceeds, `feePolicy: "included"`: a US basis is
 *   what was paid, the proceeds what was received); a sale through a US broker is reported on Form
 *   1099-B.
 */
import { accountKindSlugForAccountId } from "../accountBucket.js";
import { accountValueAt } from "../accountValue.js";
import { db } from "../db.js";
import type { DateWindow } from "../dateWindow.js";
import { equityBrokerHoldings } from "../equityBrokerHoldings.js";
import { equityMarketKind } from "../equityQuote.js";
import { cryptoDisposalFacts, equityAccountDisposalFacts, equityLotAccounts, type DisposalFact } from "../taxFacts/disposals.js";
import { dividendFacts, type DividendFact } from "../taxFacts/dividends.js";
import { interestFacts } from "../taxFacts/interest.js";
import { loadAccountPayers, type AccountPayer } from "../taxFacts/payers.js";
import type { DualStatusDividendItem } from "./dualStatus.js";
import type { Form8949Lot } from "./form8949.js";
import { usdOn } from "./fx.js";
import { isPficEquityTicker, isTreatyPensionAccount, isUsRetirementAccount } from "./pfic.js";
import type { ScheduleBDividendItem, ScheduleBInterestItem } from "./scheduleB.js";

/**
 * US-listed funds whose distributions are interest passed through (a T-bill or bond ETF): never a
 * qualified dividend (§1(h)(11) covers corporate dividends; the fund's Form 1099-DIV box 1b prints
 * about nothing). Data, not a name match: the instruments the demo holds that fit; a new one is a row
 * here until the registry carries the fund's income type.
 */
export const INTEREST_DERIVED_FUND_TICKERS: readonly string[] = ["SGOV"];

const accountNameStmt = db.prepare(`SELECT name FROM accounts WHERE id = ?`);
const accountName = (id: number) => (accountNameStmt.get(id) as { name: string } | undefined)?.name ?? `#${id}`;

const isUsPayer = (payers: readonly AccountPayer[]) => payers.some((p) => p.country === "US");

/** An account whose income stays out of the 1040 (a US retirement account or a treaty pension). */
function sheltered(accountId: number | null): boolean {
  return accountId != null && (isUsRetirementAccount(accountId) || isTreatyPensionAccount(accountId));
}

/* ------------------------------- interest ------------------------------- */

/** A Schedule B interest item and whether its payer is a US one (US-source: §861(a)(1)); the rest is foreign-source (Form 1116's passive income). */
export type UsInterestItem = ScheduleBInterestItem & { usSource: boolean };

/** The window's taxable interest, every payer, in dollars at each credit's day. */
export function usInterestItems(window: DateWindow): UsInterestItem[] {
  return interestFacts(window)
    .filter((f) => !sheltered(f.accountId))
    .map((f) => ({
      payer: accountName(f.accountId),
      date: f.date,
      movementId: f.movementId,
      usd: usdOn(f.amount, f.currency, f.date),
      usSource: isUsPayer(f.payers),
    }));
}

/* ------------------------------- dividends ------------------------------ */

export type UsDividendItem = ScheduleBDividendItem & {
  instrument: string | null;
  /** The instrument is US-source (a US-listed share or fund that is not a PFIC). */
  usSource: boolean;
  /** US tax withheld, dollars, and the form that reports it. */
  usWithheldUsd: number;
  usWithholdingForm: "1042-S" | "1099-DIV" | null;
  /** Tax another country withheld (a foreign tax, Form 1116), dollars, with the country. */
  foreignTaxUsd: number;
  foreignTaxCountry: string | null;
};

function dividendItem(f: DividendFact): UsDividendItem {
  const ticker = f.instrumentTicker;
  const market = ticker != null ? equityMarketKind(ticker) : null;
  const pfic = ticker != null && isPficEquityTicker(ticker);
  const usSource = market === "nyse" && !pfic;
  let gross: number;
  let withheld = 0;
  let jurisdiction: string | null = null;
  if (f.detail) {
    if (f.detail.currency !== f.currency) throw new Error(`1040: dividend ${f.movementId}: its document is in ${f.detail.currency}, the credit in ${f.currency}`);
    gross = f.detail.gross;
    withheld = f.detail.withholding;
    jurisdiction = f.detail.withholdingJurisdiction;
    if (withheld > 0 && jurisdiction == null) throw new Error(`1040: dividend ${f.movementId}: tax withheld without the country that withheld it`);
  } else if (f.currency === "usd") { // convention-ok: the 1040 reads dollars, and pesos or UF through its own fx rule
    throw new Error(`1040: dividend ${f.movementId} (${ticker ?? "?"}, ${f.date}) has no broker document with its gross and withholding`);
  } else {
    gross = f.net;
  }
  const usd = (x: number) => usdOn(x, f.currency, f.date);
  const usWithheld = jurisdiction === "US" ? usd(withheld) : 0;
  return {
    payer: ticker ?? accountName(f.fromAccountId ?? f.toAccountId ?? 0),
    date: f.date,
    movementId: f.movementId,
    usd: usd(gross),
    qualified: usSource && ticker != null && !INTEREST_DERIVED_FUND_TICKERS.includes(ticker),
    instrument: ticker,
    usSource,
    usWithheldUsd: usWithheld,
    usWithholdingForm: usWithheld > 0 ? (isUsPayer(f.payers) ? "1099-DIV" : "1042-S") : null,
    foreignTaxUsd: jurisdiction != null && jurisdiction !== "US" ? usd(withheld) : 0,
    foreignTaxCountry: jurisdiction != null && jurisdiction !== "US" ? jurisdiction : null,
  };
}

/** The window's dividends the 1040 declares (outside retirement accounts and pensions), in dollars. */
export function usDividendItems(window: DateWindow): UsDividendItem[] {
  return dividendFacts(window)
    .filter((f) => f.usRetirementAccount == null && !sheltered(f.fromAccountId) && !sheltered(f.toAccountId))
    .map(dividendItem);
}

/** The nonresident part's US-source dividends (the dual-status statement's FDAP). */
export function usDualStatusDividendItems(nonresidentWindow: DateWindow): DualStatusDividendItem[] {
  return usDividendItems(nonresidentWindow)
    .filter((d) => d.usSource)
    .map((d) => ({ date: d.date, movementId: d.movementId, instrument: d.instrument!, grossUsd: d.usd, withheldUsd: d.usWithheldUsd }));
}

/* ------------------------------- disposals ------------------------------ */

const saleCashStmt = db.prepare(`SELECT to_account_id FROM movements WHERE id = ?`);

function slicesInUsd(d: DisposalFact): Form8949Lot["slices"] {
  return d.slices.map((s) => ({ acquiredOn: s.acquiredOn, units: s.units, costUsd: usdOn(s.cost, d.currency, s.acquiredOn) }));
}

/** The window's disposals as Form 8949 lots: shares and ETFs (not PFICs, not in a retirement account) and coins. */
export function usDisposalLots(window: DateWindow): Form8949Lot[] {
  const payers = loadAccountPayers();
  const accounts = equityLotAccounts().filter((a) => !isUsRetirementAccount(a.accountId) && !isPficEquityTicker(a.ticker));
  // An option assignment moves its premium into the share trade it settles (Pub. 550): the walk takes it.
  const equity = equityAccountDisposalFacts(window, { method: "fifo", accounts, optionAdjustments: true }).flatMap((a) => a.disposals);
  const lots: Form8949Lot[] = equity.map((d) => {
    const cash = (saleCashStmt.get(d.movementId) as { to_account_id: number | null } | undefined)?.to_account_id ?? null;
    return {
      instrument: d.instrument!,
      unitLabel: "sh.",
      sold: d.date,
      movementId: d.movementId,
      units: d.units,
      proceedsUsd: usdOn(d.proceeds, d.currency, d.date),
      slices: slicesInUsd(d),
      reportedOn1099B: cash != null && isUsPayer(payers.get(cash) ?? []),
      digitalAsset: false,
      source: "equity",
    };
  });
  for (const d of cryptoDisposalFacts(window, { method: "fifo", feePolicy: "included" })) {
    lots.push({
      instrument: d.instrument!,
      unitLabel: "",
      sold: d.date,
      movementId: d.movementId,
      units: d.units,
      proceedsUsd: usdOn(d.proceeds, d.currency, d.date),
      slices: slicesInUsd(d),
      reportedOn1099B: false,
      digitalAsset: true,
      source: "crypto",
    });
  }
  return lots.sort((a, b) => a.sold.localeCompare(b.sold) || a.movementId - b.movementId);
}

/* --------------------------- foreign accounts --------------------------- */

/** Kind slugs of accounts at a Chilean financial institution (banks, a term deposit, funds and pensions). */
const FOREIGN_ACCOUNT_KIND_SLUGS: readonly string[] = ["cuenta_corriente", "cuenta_vista", "dap", "fund", "apv", "afp", "afc"];

/** Cash ledgers that are a broker's or an exchange's balance; one with no payer on file is read as Chilean (`payers.ts`'s default for a broker not listed abroad). */
const CASH_LEDGER_KIND_SLUGS: readonly string[] = ["usd", "clp", "buda_clp"];

export type ForeignAccountValue = { accountId: number; name: string; yearEndUsd: number; peakMonthEndUsd: number };

export type ForeignAccountsReport = {
  accounts: ForeignAccountValue[];
  /** Σ at the window's last day. */
  yearEndUsd: number;
  /** The largest Σ at a month end inside the window (a lower bound of the year's true peak). */
  peakMonthEndUsd: number;
  /** FinCEN 114: the aggregate exceeded US$10.000 at any time. */
  fbarRequired: boolean;
  /** Form 8938, single filer living in the US: > US$50.000 on the last day or > US$75.000 at any time. */
  form8938Required: boolean;
};

export const FBAR_AGGREGATE_THRESHOLD_USD = 10_000;
export const FORM_8938_THRESHOLDS_USD = { lastDay: 50_000, anyTime: 75_000 } as const;

function monthEndsIn(window: DateWindow, lastDay: string): string[] {
  const out: string[] = [];
  let y = Number(window.fromYmd.slice(0, 4));
  let m = Number(window.fromYmd.slice(5, 7));
  for (;;) {
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const day = end > lastDay ? lastDay : end;
    if (day >= window.fromYmd) out.push(day);
    if (end >= lastDay) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return [...new Set(out)];
}

/**
 * The foreign financial accounts' dollar values over a window: every account with a Chilean payer
 * (a bank number, a broker's cash), a Chilean term deposit, fund or pension, and the shares held
 * through a Chilean broker's cash (by `equityBrokerHoldings`'s split of each position); a broker or
 * exchange cash ledger with no payer on file reads as Chilean. Valued at
 * month ends only (a peak between two month ends is not seen). Coins at an exchange are left out
 * (FinCEN has not required virtual currency on the FBAR).
 */
export function foreignAccountsReport(window: DateWindow, lastDay: string): ForeignAccountsReport {
  const payers = loadAccountPayers();
  const foreignCash = (id: number) => {
    const list = payers.get(id) ?? [];
    if (list.length > 0) return list.some((p) => p.country === "CL");
    const slug = accountKindSlugForAccountId(id);
    return slug != null && CASH_LEDGER_KIND_SLUGS.includes(slug);
  };
  const all = (db.prepare(`SELECT id, name, equity_ticker FROM accounts ORDER BY id`).all() as { id: number; name: string; equity_ticker: string | null }[]);
  const direct = all.filter((a) => {
    if (isUsRetirementAccount(a.id)) return false;
    const slug = accountKindSlugForAccountId(a.id);
    return foreignCash(a.id) || (slug != null && FOREIGN_ACCOUNT_KIND_SLUGS.includes(slug));
  });
  const equity = equityLotAccounts().filter((a) => !isUsRetirementAccount(a.accountId));
  const days = monthEndsIn(window, lastDay);
  const byAccount = new Map<number, { name: string; values: number[] }>();
  const put = (id: number, name: string, i: number, usd: number) => {
    const r = byAccount.get(id) ?? { name, values: days.map(() => 0) };
    r.values[i] = (r.values[i] ?? 0) + usd;
    byAccount.set(id, r);
  };
  days.forEach((day, i) => {
    for (const a of direct) {
      const v = accountValueAt(a.id, day, "usd");
      if (v && v.value > 0) put(a.id, a.name, i, v.value);
    }
    for (const a of equity) {
      const v = accountValueAt(a.accountId, day, "usd");
      if (!v || !(v.value > 0)) continue;
      for (const h of equityBrokerHoldings(a.accountId, day, null)) {
        if (h.cash_account_id != null && foreignCash(h.cash_account_id)) put(a.accountId, a.accountName, i, v.value * h.share);
      }
    }
  });
  const totals = days.map((_, i) => [...byAccount.values()].reduce((s, r) => s + (r.values[i] ?? 0), 0));
  const yearEndUsd = Math.round(totals[totals.length - 1] ?? 0);
  const peakMonthEndUsd = Math.round(Math.max(0, ...totals));
  return {
    accounts: [...byAccount.entries()].map(([accountId, r]) => ({
      accountId,
      name: r.name,
      yearEndUsd: Math.round(r.values[r.values.length - 1] ?? 0),
      peakMonthEndUsd: Math.round(Math.max(...r.values)),
    })),
    yearEndUsd,
    peakMonthEndUsd,
    fbarRequired: peakMonthEndUsd > FBAR_AGGREGATE_THRESHOLD_USD,
    form8938Required: yearEndUsd > FORM_8938_THRESHOLDS_USD.lastDay || peakMonthEndUsd > FORM_8938_THRESHOLDS_USD.anyTime,
  };
}
