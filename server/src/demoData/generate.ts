/**
 * The synthetic database generator (docs/demo-generator-plan.md), for the hosted demo's person
 * and the Vitest person (`person.ts`). Order:
 *
 * 1. accounts and the nav trees, and the real-estate places (one per house; a DFL-2 house says so);
 * 2. market: the real tables (already loaded) or the synthetic ones, plus the series the person's
 *    own funds need (the AFP display frame, the APV fund);
 * 3. the life ledger (`simulate`);
 * 4. ledger rows no bank document carries (transfers between own accounts, the broker, the funds,
 *    the dollar account) — written first, so each cartola row they explain is kept as the transfer;
 * 5. the documents, through the same import functions the ingest kinds call: cartolas, this
 *    month's checking listing, card statements and the open cycle, payroll parameters and
 *    liquidaciones; then the card-payment mirrors are paired as the nightly run pairs them;
 * 6. what the app keeps beside the documents: contractor payslips, contribution periods, each
 *    house's mortgage ledger and its cuota card lines linked to the deposits they funded, the rents
 *    marked as their place's, the places' bills, book valuations (property, mortgage, AFC);
 * 6b. the tax documents (boletas, dividend splits, the DJs) and each April from the tax modules (the
 *    1040 first, then the F22, whose credit for the US tax reads it):
 *    steps 3–6b run again, from a checkpoint taken before step 3, until every April settlement the
 *    simulation booked is the one the tax module computes (`taxDocuments.ts`); then the past
 *    years' returns are stored as filed;
 * 7. category rules, colors, sync sources, the invariants;
 * 8. the ingest history the scheduler would have recorded (`ingestHistory.ts`).
 */
import { setExpenseCategoryRule } from "../expenseCategoryRules.js";
import { readFileSync } from "node:fs";
import { db } from "../db.js";
import { createPanelAccount } from "../createPanelAccount.js";
import { assignOptionContract } from "../optionAssignment.js";
import { declareTaxResidency } from "../taxResidency.js";
import { chileCalendarTodayYmd } from "../chileDate.js";
import { ensureRetirementCountrySplit, seedNavTree } from "../seedNavTree.js";
import { writeFundUnitSeriesRows } from "../fundUnitDaily.js";
import { employmentPayslipsKind } from "nw-tracker-contracts";
import { ensureAccountSyncSourcesSeeded } from "../accountSyncSources.js";
import { recomputeCcBillingMonthBalances } from "../ccBillingBalances.js";
import { afpDisplaySeriesKey, AFP_UNO_CUOTA_SERIES_KEY } from "../afpUnoSeries.js";
import { afpDisplayThroughDay, buildAfpDisplayRowsForFund, upsertAfpDisplayRows } from "../afpUnoOfficialSync.js";
import { officialPensionFundUnits } from "../spAfpFundUnits.js";
import { loadUfLookup, ufImpliedIpcVariationPct, writeOfficialIpcMonths } from "../siiOfficialIpc.js";
import { applyBankAccountStatements } from "../bankAccountStatementsApply.js";
import { applyBankAccountMovements } from "../bankAccountMovementsApply.js";
import { applyCanonicalCardStatements } from "../ccParsedStatementsApply.js";
import { importCcListingLines } from "../accountImports.js";
import { convertCcPaymentMirrors, listCcPaymentMirrorCandidates } from "../ccPaymentMirrors.js";
import { applyPayrollParameters } from "../payrollParametersApply.js";
import { applyEmploymentPayslips } from "../payslipsApply.js";
import { payslipLineKind } from "../payslipLineKinds.js";
import { getCcExpenseCategoryBySlug, normalizeCcExpenseMerchantKey } from "../ccExpenseCategories.js";
import { invalidateExpenseGenericUniqueMerchantCache } from "../expenseGenericUniqueMerchants.js";
import {
  deptoPaymentHumanNote,
  insertLoanPaymentRow,
  loanPaymentColumnsFromPaymentRow,
  upsertPropertyAppraisalUf,
  type DeptoDividendosPaymentRow,
} from "../deptoDividendosLedger.js";
import { commitMortgagePayment } from "../mortgagePaymentCreate.js";
import {
  afpAccountImportKey,
  BUDA_ACCOUNT_IMPORT_KEY,
  loanAccountImportKey,
  propertyAccountImportKey,
  TERM_DEPOSIT_ACCOUNT_IMPORT_KEY,
  usRetirementAccountImportKey,
} from "../accountIdentityKeys.js";
import { createRealEstatePlace } from "../flowsRealEstateExpenses.js";
import { assignPurchasesToRealEstateExpenses, loadGastosLinesForRealEstateMatching } from "../realEstateExpenseMatching.js";
import { upsertCheckingIncomeMovementOverride } from "../flowsCheckingIncomeOverrides.js";
import { syncMortgageExpenseDepositLinksFromSheet } from "../expenseDepositLinks.js";
import { expenseLinesForDepositLinkSync } from "../flowsExpenses.js";
import { isChileBusinessDay, isNyseTradingDay } from "../marketHolidays.js";
import { recordEquitySplit } from "../equitySplits.js";
import { ccMasterImportKeyPrefix } from "../ccIssuers.js";
import { isLoanLenderMerchant } from "../expenseDepositLinks.js";
import { buildPanelAccountNotes, buildPanelCashAccountNotes } from "../panelAccountNotes.js";
import { DEMO_AFP_MODELO_CSV_PATH, parseDemoAfpModeloCsv } from "./demoRealMarket.js";
import { dbMarketReader, declareDemoInstruments, writeSyntheticMarket, type MarketReader } from "./market.js";
import { requireMarketSymbol } from "../marketSymbols.js";
import { addDays, addMonths, BTC_TICKER, type Month, type Person, type Ymd } from "./person.js";
import {
  renderCardStatements,
  renderCartolas,
  renderCurrentMonthListing,
  renderOpenCycle,
  renderPayrollParameters,
  renderPayslips,
  renderUsStatementRows,
  DEMO_CHECKING_NUMBER,
  DEMO_US_CHECKING_NUMBER,
  DEMO_US_SAVINGS_NUMBER,
} from "./render.js";
import {
  AFP_SWITCH_MONTH,
  APV_FUND_SERIES_KEY,
  MONEY_MARKET_DEPOSIT_DESCRIPTION,
  MONEY_MARKET_FEE_PCT,
  MONEY_MARKET_REDEMPTION_DESCRIPTION,
  MONEY_MARKET_SERIES_KEY,
  US_RETIREMENT_FUND_SERIES_KEY,
  MUTUAL_FUND_SERIES_KEY,
  moneyMarketAnnualRatePct,
  simulate,
  type Acct,
  type Ledger,
} from "./simulate.js";
import { DEMO_US_BANK_ISSUER } from "../usBankAccounts.js";
import { assertDemoInvariants, type DemoDbReport } from "./invariants.js";
import { writeIngestHistory } from "./ingestHistory.js";
import {
  aprilSettlementsFromTaxModule,
  settlementDifferences,
  usAprilSettlementsFromTaxModule,
  usSettlementDifferences,
  writeDemoFiledReturns,
  writeDemoFiledUsReturns,
  writeDemoTaxDocuments,
} from "./taxDocuments.js";
import { resetDemoDatabaseToPristine, saveDemoPristineCopy } from "../demoWritable.js";
import fs from "node:fs";

/** Passes of the life simulation before the April settlements must agree with the tax module. */
const MAX_TAX_PASSES = 6;

export type GenerateDemoDbOptions = { person: Person; market: "synthetic" | "real"; today?: Ymd };

/* ------------------------------------ accounts ------------------------------------ */

function ensureAssetGroup(slug: string, label: string, parentSlug: string): number {
  const existing = db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(slug) as { id: number } | undefined;
  if (existing) return existing.id;
  const parent = db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(parentSlug) as { id: number } | undefined;
  if (!parent) throw new Error(`demo: asset group ${parentSlug} missing (schema seed incomplete?)`);
  return Number(db.prepare(`INSERT INTO asset_groups (slug, label, sort_order, parent_id) VALUES (?, ?, 90, ?)`).run(slug, label, parent.id).lastInsertRowid);
}

function createAccount(groupId: number, name: string, opts: { key?: string; ticker?: string; series?: string } = {}): number {
  return Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key, equity_ticker, fund_series_key) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(groupId, name, opts.key ?? `demo:${name}`, opts.key ?? null, opts.ticker ?? null, opts.series ?? null).lastInsertRowid
  );
}

function createAccounts(person: Person): Map<Acct, number> {
  const ids = new Map<Acct, number>();
  const g = (slug: string) => {
    const r = db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(slug) as { id: number } | undefined;
    if (!r) throw new Error(`demo: asset group ${slug} missing`);
    return r.id;
  };
  ids.set("vista", createAccount(g("cash_eqs__cuenta_vista"), "Cuenta vista"));
  ids.set("checking", createAccount(g("cash_eqs__cuenta_corriente"), "Cuenta corriente"));
  ids.set("checkingUsd", createAccount(ensureAssetGroup("cash_eqs__cuenta_usd__usd", "Cuenta corriente USD", "cash_eqs__checking_accounts"), "Cuenta corriente USD"));
  ids.set("brokerClp", createAccount(ensureAssetGroup("cash_eqs__cash_savings__broker_clp__clp", "Broker CLP", "cash_eqs__cash_savings"), "Broker CLP", { key: buildPanelCashAccountNotes("clp", "broker_clp") }));
  ids.set("brokerUsd", createAccount(ensureAssetGroup("cash_eqs__cash_savings__broker_usd__usd", "Broker USD", "cash_eqs__cash_savings"), "Broker USD", { key: buildPanelCashAccountNotes("usd", "broker_usd") }));
  if (person.btc) {
    ids.set("exchangeClp", createAccount(ensureAssetGroup("brokerage_crypto__buda_clp", "Exchange CLP", "brokerage_crypto"), "Exchange CLP", { key: BUDA_ACCOUNT_IMPORT_KEY }));
    ids.set("btc", createAccount(g("brokerage_crypto__bitcoin"), "Bitcoin", { ticker: "BTC-USD" }));
  }
  for (const t of person.brokerTickers) {
    // The name is the instrument's display symbol: «CFIETFIPSA.SN» is the CFIETFIPSA account, «CSPX.L» CSPX.
    const name = requireMarketSymbol(t).display_symbol;
    const leaf = ensureAssetGroup(`brokerage_acciones__${name.toLowerCase()}`, name, "brokerage_acciones");
    ids.set(`stock:${t}`, createAccount(leaf, name, { key: buildPanelAccountNotes(t, `demo_${t}`), ticker: t }));
  }
  if (person.ibkr) {
    const ibkr = createAccount(ensureAssetGroup("cash_eqs__cash_savings__ibkr_usd__usd", "IBKR USD", "cash_eqs__cash_savings"), "IBKR USD", {
      key: buildPanelCashAccountNotes("usd", "ibkr_usd"),
    });
    // No identity seeds this broker's role (accountRoles271.ts): it is written as data.
    db.prepare(`INSERT INTO account_roles (account_id, role, param) VALUES (?, 'broker_cash', 'ibkr|usd')`).run(ibkr);
    ids.set("ibkrUsd", ibkr);
  }
  if (person.dap) ids.set("dap", createAccount(g("cash_eqs__dap"), "Depósito a plazo", { key: TERM_DEPOSIT_ACCOUNT_IMPORT_KEY }));
  if (person.fund) {
    ids.set("fund", createAccount(g("brokerage_mutual_funds__fintual_risky_norris"), person.fund.name, { key: "import:panel|kind=fund|key=demo_fondo", series: MUTUAL_FUND_SERIES_KEY }));
  }
  if (person.savings.clp) {
    // The money-market fund the Chilean cushion sits in: a book account under Cash savings (cuotas × its series).
    const leaf = ensureAssetGroup("cash_eqs__cash_savings__fm_money_market__fund", person.savings.clp.fundName, "cash_eqs__cash_savings");
    ids.set("savingsClp", createAccount(leaf, person.savings.clp.fundName, { key: "import:panel|kind=fund|key=demo_fm_money_market", series: MONEY_MARKET_SERIES_KEY }));
  }
  ids.set("apvA", createAccount(g("retirement_apv_a__apv"), "APV A", { series: APV_FUND_SERIES_KEY }));
  ids.set("apvB", createAccount(g("retirement_apv_b__apv"), "APV B", { series: APV_FUND_SERIES_KEY }));
  const afp = (slug: string, name: string) => {
    const key = afpAccountImportKey(slug, "A");
    return createAccount(g("retirement_afp_afc__afp"), name, { key, series: afpDisplaySeriesKey(slug, "A") });
  };
  // Modelo only for a life that starts before the switch into UNO.
  if (person.firstMonth < AFP_SWITCH_MONTH) ids.set("afpModelo", afp("modelo", "Modelo-A"));
  ids.set("afpUno", afp("uno", "UNO-A"));
  ids.set("afc", createAccount(g("retirement_afp_afc__afc"), "AFC"));
  for (const h of person.houses) {
    // The keys give the property its `property` role and the loan `loan_of` it (migration 299);
    // the lender, as the card prints it, is a role written as data.
    const property = createAccount(g("real_estate__property"), h.label, { key: propertyAccountImportKey(h.key) });
    const loan = createAccount(g("liabilities__mortgage"), h.label, { key: loanAccountImportKey(h.key) });
    db.prepare(`INSERT INTO account_roles (account_id, role, param) VALUES (?, 'lender_pattern', ?)`).run(loan, h.lender.pattern);
    ids.set(`property:${h.key}`, property);
    ids.set(`loan:${h.key}`, loan);
  }
  for (const c of person.cards) {
    const id = createAccount(g("credit_cards__credit_card"), c.displayName, { key: `${ccMasterImportKeyPrefix(c.issuer)}${c.last4}` });
    db.prepare(
      `INSERT INTO credit_card_account_config (account_id, cupo_clp, cupo_usd, billing_cycle_start_day, billing_cycle_end_day, card_last4, issuer)
       VALUES (?, ?, ?, 21, 20, ?, ?)`
    ).run(id, c.key === "main" ? 8_000_000 : 12_000_000, c.key === "main" ? 3_000 : 6_000, c.last4, c.issuer);
    ids.set(`card:${c.key}` as Acct, id);
  }
  if (person.us) {
    // The US checking account: a dollar ledger under Checking accounts, whose bank statement lists its rows.
    const us = createAccount(ensureAssetGroup("cash_eqs__cuenta_us__usd", "Checking (US)", "cash_eqs__checking_accounts"), "Checking (US)", {
      key: buildPanelCashAccountNotes("usd", "us_checking"),
    });
    ids.set("usChecking", us);
    const declare = db.prepare(`INSERT INTO bank_account_numbers (account_id, issuer, number, currency) VALUES (?, ?, ?, 'usd')`);
    declare.run(us, DEMO_US_BANK_ISSUER, DEMO_US_CHECKING_NUMBER);
    if (person.us.bank.number !== DEMO_US_CHECKING_NUMBER) throw new Error("demo: the US bank number and the statement's differ");
    if (person.savings.usd) {
      // The savings account at the same bank: a dollar ledger under Cash savings; its number declared
      // beside the checking one is what makes its interest the 1040's line 2b (`usBankAccounts.ts`).
      const savings = createAccount(ensureAssetGroup("cash_eqs__cash_savings__us_savings__usd", person.savings.usd.bankLabel, "cash_eqs__cash_savings"), person.savings.usd.bankLabel, {
        key: buildPanelCashAccountNotes("usd", "us_savings"),
      });
      ids.set("usSavings", savings);
      declare.run(savings, DEMO_US_BANK_ISSUER, DEMO_US_SAVINGS_NUMBER);
    }
  }
  if (person.usJobs.length > 0) {
    // The US retirement accounts (the Retirement tree splits into Chile and US once they exist).
    const provider = person.usJobs[0]!.id;
    ids.set("k401", createAccount(g("retirement_us_401k__us_401k"), "401(k)", { key: usRetirementAccountImportKey("us_401k", provider), series: US_RETIREMENT_FUND_SERIES_KEY }));
    ids.set("hsa", createAccount(g("retirement_us_hsa__hsa"), "HSA", { key: usRetirementAccountImportKey("hsa", provider), series: US_RETIREMENT_FUND_SERIES_KEY }));
    if (person.us?.roth) {
      ids.set("rothIra", createAccount(g("retirement_us_roth_ira__roth_ira"), "Roth IRA", { key: usRetirementAccountImportKey("roth_ira", provider), ticker: "SPY" }));
      // The IRA's cash sweep: a dollar ledger on its own leaf under the Roth bucket (kind `usd`, the
      // leaf's suffix), so a contribution and a dividend land as cash and the SPY buy is a
      // `stock_buy` from it — the shape every reader (deposits, tax lots, broker holdings) knows.
      // It ends every day at zero, so it is chart-inactive and out of the nav.
      const sweep = ensureAssetGroup("retirement_us_roth_ira__roth_ira_cash__usd", "Roth IRA cash", "retirement_us_roth_ira");
      ids.set("rothCash", createAccount(sweep, "Roth IRA cash", { key: buildPanelCashAccountNotes("usd", "roth_ira_cash") }));
    }
  }
  db.prepare(`INSERT INTO bank_account_numbers (account_id, issuer, number, currency) VALUES (?, 'santander', ?, 'clp')`).run(ids.get("checking")!, DEMO_CHECKING_NUMBER);
  db.prepare(`INSERT INTO bank_account_numbers (account_id, issuer, number, currency) VALUES (?, 'santander', '5100234567', 'usd')`).run(ids.get("checkingUsd")!);
  return ids;
}

/* ------------------------------------- market -------------------------------------- */

/**
 * The US retirement fund (a 2060 target-date fund): 90 % SPY, 10 % a steady 3,5 %/yr bond sleeve,
 * in dollars, valued every NYSE trading day from the stored SPY closes — the same rows on the
 * synthetic and the real market (on `--real-market` SPY's closes are Yahoo's), no other source.
 */
function writeUsRetirementFundSeries(market: MarketReader, from: Ymd, today: Ymd): void {
  const spy0 = market.close("SPY", from);
  const rows: { day: string; unit_value: number; note: string }[] = [];
  for (let d = from; d <= today; d = addDays(d, 1)) {
    if (!isNyseTradingDay(d)) continue;
    const years = (Date.parse(d) - Date.parse(from)) / (365.25 * 86_400_000);
    const v = 25 * (0.9 * (market.close("SPY", d) / spy0) + 0.1 * Math.pow(1.035, years));
    rows.push({ day: d, unit_value: Math.round(v * 1e4) / 1e4, note: "demo" });
  }
  db.transaction(() => writeFundUnitSeriesRows({ seriesKey: US_RETIREMENT_FUND_SERIES_KEY, currency: "usd", rows }))();
}

/**
 * A peso fund's valor cuota, valued on every Chile business day: a mix of SPY in pesos and a steady
 * 3 %/yr sleeve (`equityShare`: the APV fund 65 %, the mutual fund 90 %), or a money-market fund
 * accruing a yearly rate curve day by day (`annualRatePct`, no equity).
 */
function writeFundSeries(
  seriesKey: string,
  mix: { equityShare: number } | { annualRatePct: (day: Ymd) => number },
  market: MarketReader,
  from: Ymd,
  today: Ymd
): void {
  const ins = db.prepare(`INSERT OR REPLACE INTO fund_unit_daily (series_key, day, unit_value, note) VALUES (?, ?, ?, 'demo')`);
  const spy0 = "equityShare" in mix ? market.close("SPY", from) * market.fx(from) : 0;
  let accrued = 1_000;
  db.transaction(() => {
    for (let d = from; d <= today; d = addDays(d, 1)) {
      // The money market accrues every calendar day; a value is written on business days only.
      if ("annualRatePct" in mix && d > from) accrued *= Math.pow(1 + mix.annualRatePct(d) / 100, 1 / 365);
      if (!isChileBusinessDay(d)) continue;
      const years = (Date.parse(d) - Date.parse(from)) / (365.25 * 86_400_000);
      const v =
        "equityShare" in mix
          ? 10_000 * (mix.equityShare * ((market.close("SPY", d) * market.fx(d)) / spy0) + (1 - mix.equityShare) * Math.pow(1.03, years))
          : accrued;
      // The mixes keep their two decimals (the suite's fixtures); the money market's small daily steps need four.
      ins.run(seriesKey, d, "equityShare" in mix ? Math.round(v * 100) / 100 : Math.round(v * 10_000) / 10_000);
    }
  })();
}

function writeAfpDisplaySeries(person: Person, today: Ymd): void {
  if (person.firstMonth < AFP_SWITCH_MONTH) {
    const modelo = officialPensionFundUnits("modelo", "A");
    if (modelo.length === 0) throw new Error("demo: no Modelo fund A values (the committed snapshot)");
    const modeloRows = buildAfpDisplayRowsForFund("modelo", "A", modelo[0]!.day, modelo.at(-1)!.day);
    upsertAfpDisplayRows(afpDisplaySeriesKey("modelo", "A"), "modelo", modeloRows, false);
  }
  const uno = officialPensionFundUnits("uno", "A");
  if (uno.length === 0) throw new Error("demo: no UNO fund A values");
  const through = afpDisplayThroughDay(uno, today);
  upsertAfpDisplayRows(AFP_UNO_CUOTA_SERIES_KEY, "uno", buildAfpDisplayRowsForFund("uno", "A", uno[0]!.day, through), false);
}

/**
 * The official monthly IPC (the SII's one-decimal variation) as the UF implies it: each month's
 * variation is the UF's growth over the window the UF applies it (`ufWindowForIpcMonth`) — the
 * identity `writeOfficialIpcMonths` verifies. One base, so the printed index chains from 100.
 */
function writeOfficialIpcFromUf(fromMonth: Month): void {
  const ufOn = loadUfLookup();
  const months: { month: string; variationPct: number; indexPoints: number }[] = [];
  let index = 100;
  for (let m = fromMonth; ; m = addMonths(m, 1)) {
    const pct = ufImpliedIpcVariationPct(`${m}-01`, ufOn);
    if (pct == null) break;
    index = Math.round(index * (1 + pct / 100) * 100) / 100;
    months.push({ month: `${m}-01`, variationPct: pct, indexPoints: index });
  }
  writeOfficialIpcMonths(months, false);
}

/* --------------------------------- direct writes ----------------------------------- */

/**
 * The options wheel's contract series as accounts, through the app's own account creation
 * (`option_contracts` row, `brokerage_opciones` leaf, no equity ticker). The ids join the map under
 * each series' key; a pass's database reset drops them, so every pass creates them again.
 */
function createOptionContractAccounts(ledger: Ledger, ids: Map<Acct, number>): void {
  // An earlier pass's series (another set, perhaps) is gone with its database.
  for (const key of [...ids.keys()]) if (key.startsWith("option:")) ids.delete(key);
  for (const c of ledger.optionContracts) {
    const r = createPanelAccount({
      account: {
        account_type: "option",
        name: "",
        bucket_slug: "brokerage_opciones",
        option: { underlying: c.underlying, right: c.right, strike: c.strike, expiry: c.expiry },
        exclude_from_group_totals: false,
      },
    });
    ids.set(c.key, r.account_id);
  }
}

function writeDirect(ledger: Ledger, ids: Map<Acct, number>): void {
  const id = (a: Acct) => {
    const v = ids.get(a);
    if (v == null) throw new Error(`demo: no account for ${a}`);
    return v;
  };
  const insSingle = db.prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta, flow_kind) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insTransfer = db.prepare(
    `INSERT INTO movements (account_id, from_account_id, to_account_id, amount, currency, counter_amount, counter_currency, occurred_on, note, units_delta, counter_units_delta, flow_kind)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insKind = db.prepare(`INSERT INTO crypto_movement_kinds (movement_id, kind) VALUES (?, ?)`);
  // The exchange's record of each trade: the tax module prices a coin's lots from it (cryptoTaxLotEvents.ts).
  const insTrade = db.prepare(
    `INSERT INTO crypto_trade_details (movement_id, exchange_trade_id, units, price, price_currency, fee_amount, fee_currency, created_at)
     VALUES (?, ?, ?, ?, 'clp', ?, 'clp', ?)`
  );
  const insPeriod = db.prepare(`INSERT INTO pension_contribution_periods (movement_id, period_month) VALUES (?, ?)`);
  const sorted = [...ledger.direct].sort((a, b) => a.date.localeCompare(b.date));
  db.transaction(() => {
    for (const m of sorted) {
      if (m.type === "option_assign") {
        // The contract's `option_assign` row and the share leg at the strike, linked in `option_assignments`.
        assignOptionContract({
          contract_account_id: id(m.contract),
          stock_account_id: id(m.stock),
          cash_account_id: id(m.cash),
          occurred_on: m.date,
          contracts: m.contracts,
          note: m.note,
        });
      } else if (m.type === "single") {
        const r = insSingle.run(id(m.account), m.amount, m.currency, m.date, m.note, m.units ?? null, m.flowKind ?? null);
        const mid = Number(r.lastInsertRowid);
        if (m.cryptoKind) insKind.run(mid, m.cryptoKind);
        if (m.exchangeTrade) {
          if (m.units == null) throw new Error(`demo: exchange trade without units on ${m.date}`);
          insTrade.run(mid, `demo-trade-${mid}`, m.units, m.exchangeTrade.priceClp, m.exchangeTrade.feeClp, `${m.date}T12:00:00Z`);
        }
        for (const p of m.contributionPeriods ?? []) insPeriod.run(mid, p);
      } else {
        insTransfer.run(
          id(m.from),
          id(m.to),
          m.amount,
          m.currency,
          m.counterUsd ?? m.counterClp ?? null,
          m.counterUsd != null ? "usd" : m.counterClp != null ? "clp" : null,
          m.date,
          m.note,
          m.units ?? null,
          m.counterUnits ?? null,
          m.flowKind
        );
      }
    }
  })();
}

/**
 * The US checking account's statement rows (`renderUsStatementRows`): no US statement importer
 * exists, so they are written as the cartola import writes a statement row — single-leg, the
 * statement identity in the note, the bank's evidence kind from it. A row a transfer explains
 * (checking ↔ savings) is skipped, as the import keeps the transfer leg for a cartola row.
 */
function writeUsStatementRows(ledger: Ledger, ids: Map<Acct, number>): void {
  const rows = renderUsStatementRows(ledger).filter((r) => !r.transfer);
  if (rows.length === 0) return;
  const id = ids.get("usChecking");
  if (id == null) throw new Error("demo: US statement rows without a US checking account");
  // A single-leg dollar row is positive, its direction in the flow kind (`signedUsdDeltaForAccountMovement`).
  const ins = db.prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, ?, 'usd', ?, ?, ?)`);
  db.transaction(() => {
    for (const r of rows) ins.run(id, Math.abs(r.amount), r.date, r.note, r.amount > 0 ? "compra_usd" : "withdrawal_usd");
  })();
}

function writeContractorPayslips(ledger: Ledger): void {
  const ins = db.prepare(
    `INSERT INTO payroll_work_earnings (
       period_month, employer_name, employer_rut, pay_period_label, earning_type,
       total_haberes_clp, desc_other_clp, total_descuentos_clp, liquido, liquido_currency,
       source_pdf, parse_version, movement_id, link_source, wire_received_on, origin, rebuilt_basis, pension_fund
     ) VALUES (?, ?, NULL, ?, 'salary', ?, ?, ?, ?, 'usd', ?, 'demo', NULL, NULL, ?, 'rebuilt', ?, NULL)`
  );
  const insLine = db.prepare(`INSERT INTO payslip_lines (payslip_id, position, side, section, label, amount, kind) VALUES (?, ?, ?, NULL, ?, ?, ?)`);
  db.transaction(() => {
    for (const p of ledger.contractorPayslips) {
      const net = Math.round((p.grossUsd - p.feeUsd) * 100) / 100;
      const r = ins.run(
        p.month,
        p.job.employer,
        p.month,
        Math.round(p.grossUsd * p.fx),
        Math.round(p.feeUsd * p.fx),
        Math.round(p.feeUsd * p.fx),
        net,
        `contractor/${p.job.id}/${p.month}.pdf`,
        p.wireDate,
        `${p.job.platform} contractor invoice`
      );
      const pid = Number(r.lastInsertRowid);
      insLine.run(pid, 0, "haber", "Honorarios (contrato en USD)", p.grossUsd, payslipLineKind("haber", "Honorarios (contrato en USD)", "cl"));
      insLine.run(pid, 1, "descuento", "Comisión de transferencia", p.feeUsd, payslipLineKind("descuento", "Comisión de transferencia", "cl"));
    }
  })();
}

/**
 * Each house's mortgage ledger: the pie is written as the bank states it (no prior balance to
 * compute it from), every cuota and prepago through the app's own writer (`commitMortgagePayment`,
 * as the mortgage sheet import writes them) with the bank's figures. The property's appraisal on
 * each payment day is a valuation of the property account in UF.
 */
function writeMortgages(ledger: Ledger, ids: Map<Acct, number>): void {
  for (const m of ledger.mortgages) writeMortgage(m, ids);
}

function writeMortgage(m: Ledger["mortgages"][number], ids: Map<Acct, number>): void {
  const h = m.house;
  const propertyId = ids.get(`property:${h.key}`)!;
  const loanId = ids.get(`loan:${h.key}`)!;
  // The card line that pays a cuota must be one the app recognizes as this loan's lender.
  if (!isLoanLenderMerchant(h.lender.merchant, loanId)) throw new Error(`demo: ${h.lender.merchant} is not ${h.label}'s lender`);
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
  const valueUfAt = (day: Ymd) => h.valueUf * Math.pow(1 + h.monthlyAppreciation, Math.max(0, (Date.parse(day) - Date.parse(m.pieDate)) / (30.44 * 86_400_000)));
  // Not one transaction: each payment is the writer's own, and inside an outer one the depto
  // ledger it re-reads would be rebuilt from scratch for every cuota.
  {
    const pie: DeptoDividendosPaymentRow = {
      cuota: "pie",
      occurred_on: m.pieDate,
      amount_clp: m.pieClp,
      credito_restante_uf: r4(m.principalUf),
      min_uf: null,
      max_uf: null,
      amortizacion_clp: null,
      amortizacion_ext_clp: null,
      interes_clp: null,
      incendio_clp: null,
      desgravamen_clp: null,
    };
    const pm = db
      .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', ?, ?)`)
      .run(propertyId, pie.amount_clp, pie.occurred_on, deptoPaymentHumanNote("property", "pie", false));
    insertLoanPaymentRow({ movement_id: Number(pm.lastInsertRowid), loan_account_id: loanId, leg: "property", origin: "import", ...loanPaymentColumnsFromPaymentRow(pie) });
    upsertPropertyAppraisalUf(propertyId, m.pieDate, r4(h.valueUf));
    for (const c of [...m.cuotas].sort((a, b) => a.date.localeCompare(b.date))) {
      // A prepago is all extra amortization, with no interest or insurance.
      const regular = c.n != null;
      commitMortgagePayment(
        loanId,
        {
          occurred_on: c.date,
          cuota: c.label,
          pago_clp: c.clp,
          interes_clp: regular ? Math.round(c.interestUf * c.ufDay) : 0,
          incendio_clp: regular ? h.lender.incendioClp : 0,
          desgravamen_clp: regular ? h.lender.desgravamenClp : 0,
          amortizacion_ext_clp: regular ? Math.round(c.extUf * c.ufDay) : c.clp,
          min_uf: regular ? r5(c.pmtUf) : null,
          max_uf: regular ? r5(c.pmtUf * 1.2 + c.extUf) : null,
          credito_restante_uf: r4(c.balanceAfterUf),
        },
        { origin: "import" }
      );
      upsertPropertyAppraisalUf(propertyId, c.date, r4(valueUfAt(c.date)));
    }
  }
}

/** The real-estate page's places, one per house (a DFL-2 house says so): config, written once. */
function writePlaces(person: Person, ids: Map<Acct, number>): void {
  for (const h of person.houses) {
    createRealEstatePlace({
      slug: h.key,
      label: h.label,
      activeFrom: h.month,
      propertyAccountId: ids.get(`property:${h.key}`)!,
      dfl2: h.dfl2 ? { dfl2: true, builtM2: h.dfl2.builtM2, receptionYear: h.dfl2.receptionYear } : { dfl2: false },
    });
  }
}

/** The single-leg checking movement the bank printed `description` on for `clp` that day. */
function checkingMovementFor(checkingId: number, day: Ymd, clp: number, description: string): number {
  const rows = db
    .prepare(`SELECT id FROM movements WHERE account_id = ? AND occurred_on = ? AND amount = ? AND note LIKE ?`)
    .all(checkingId, day, clp, `%${description}%`) as { id: number }[];
  if (rows.length !== 1) throw new Error(`demo: ${rows.length} checking movements for «${description}» ${clp} on ${day}`);
  return rows[0]!.id;
}

/** Each rent the agency forwarded is the rent of its place (the income override names it). */
function writeRentOverrides(ledger: Ledger, ids: Map<Acct, number>): void {
  const checkingId = ids.get("checking")!;
  db.transaction(() => {
    for (const r of ledger.rents) {
      upsertCheckingIncomeMovementOverride(checkingMovementFor(checkingId, r.date, r.clp, r.description), { income_kind: "rent", rent_place_slug: r.house });
    }
  })();
}

/**
 * The places' gastos comunes and contribuciones as bill rows, each created from the checking
 * purchase that paid it (the real-estate assign path: a bill exists only when a purchase backs it).
 */
function writePlaceBills(ledger: Ledger): void {
  if (ledger.placeBills.length === 0) return;
  const lines = loadGastosLinesForRealEstateMatching().filter((l) => l.source === "checking");
  const byKey = new Map<string, string[]>();
  for (const l of lines) {
    const k = `${l.purchase_on}|${Math.round(l.amount_clp)}|${l.merchant}`;
    byKey.set(k, [...(byKey.get(k) ?? []), l.purchase_key]);
  }
  assignPurchasesToRealEstateExpenses(
    ledger.placeBills.map((b) => {
      const keys = byKey.get(`${b.date}|${b.clp}|${b.description}`) ?? [];
      if (keys.length !== 1) throw new Error(`demo: ${keys.length} expense lines for ${b.kind} of ${b.house} on ${b.date} (${b.clp})`);
      return { purchaseKey: keys[0]!, accountSlug: b.house, kind: b.kind };
    })
  );
}

/**
 * Each regular cuota's card line linked to the property deposit it funded (amortization vs carrying),
 * as the app's link sync pairs them after a write — the generator writes no categories through the
 * funnel, so it runs the mortgage half of that sync itself (outside a transaction: inside one the
 * process caches it reads are rebuilt per cuota).
 */
function writeMortgageCardLinks(ledger: Ledger): void {
  if (ledger.mortgages.length === 0) return;
  const lines = expenseLinesForDepositLinkSync().filter((l) => l.source === "cc");
  const made = syncMortgageExpenseDepositLinksFromSheet(lines);
  const regular = ledger.mortgages.reduce((a, m) => a + m.cuotas.filter((c) => c.n != null).length, 0);
  if (made.length !== regular) throw new Error(`demo: ${made.length} mortgage card lines linked, ${regular} regular cuotas`);
}

/**
 * APV, mutual fund and money-market accounts are book accounts: units × the fund's value, marked
 * every business day (a transfer out of the fund — a redemption — sells its units).
 */
function writeFundValuations(ids: Map<Acct, number>, market: MarketReader, today: Ymd): void {
  const insVal = db.prepare(`INSERT OR REPLACE INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')`);
  for (const [key, series] of [["apvA", APV_FUND_SERIES_KEY], ["apvB", APV_FUND_SERIES_KEY], ["fund", MUTUAL_FUND_SERIES_KEY], ["savingsClp", MONEY_MARKET_SERIES_KEY]] as const) {
    const id = ids.get(key);
    if (id == null) continue;
    const rows = db
      .prepare(
        `SELECT occurred_on, CASE WHEN from_account_id = ? THEN -units_delta ELSE units_delta END AS units_delta
           FROM movements WHERE (account_id = ? OR to_account_id = ? OR from_account_id = ?) AND units_delta IS NOT NULL ORDER BY occurred_on`
      )
      .all(id, id, id, id) as { occurred_on: string; units_delta: number }[];
    if (rows.length === 0) continue;
    let units = 0;
    let i = 0;
    db.transaction(() => {
      for (let d = rows[0]!.occurred_on; d <= today; d = addDays(d, 1)) {
        while (i < rows.length && rows[i]!.occurred_on <= d) units += rows[i++]!.units_delta;
        if (!isChileBusinessDay(d) && d !== today) continue;
        insVal.run(id, d, Math.round(units * market.fundUnit(series, d)));
      }
    })();
  }
}

/**
 * The term-deposit account is a book account: each deposit's principal plus the interest accrued
 * (simple, as the bank pays it), marked on every Chile business day from its opening; on a renewal
 * day the new principal, after the last payout 0.
 */
function writeTermDepositValuations(ledger: Ledger, dapId: number, today: Ymd): void {
  const deposits = ledger.termDeposits;
  if (deposits.length === 0) return;
  const insVal = db.prepare(`INSERT OR REPLACE INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')`);
  db.transaction(() => {
    for (const [i, t] of deposits.entries()) {
      const days = (Date.parse(t.maturity) - Date.parse(t.open)) / 86_400_000;
      for (let d = t.open; d < t.maturity && d <= today; d = addDays(d, 1)) {
        if (!isChileBusinessDay(d)) continue;
        const elapsed = (Date.parse(d) - Date.parse(t.open)) / 86_400_000;
        insVal.run(dapId, d, Math.round(t.principal + ((t.payout - t.principal) * elapsed) / days));
      }
      const next = deposits[i + 1];
      if (t.paid && !(next && next.open === t.maturity)) insVal.run(dapId, t.maturity, 0);
    }
  })();
}

/** Records the person's stock splits (and each holder's split row) through the app's own writer. */
function writeSplits(person: Person, today: Ymd): void {
  for (const sp of person.splits) {
    if (sp.exDate > today) continue;
    recordEquitySplit(
      { ticker: sp.ticker, ex_date: sp.exDate, numerator: sp.numerator, denominator: sp.denominator, source: "yahoo" },
      new Date(`${today}T18:00:00Z`)
    );
  }
}

/** The AFC book account: contributions grow at ~3,5 %/yr, marked on every Chile business day. */
function writeAfc(ledger: Ledger, afcId: number, today: Ymd): void {
  if (ledger.afcContributions.length === 0) return;
  const insMov = db.prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', ?, ?)`);
  const insVal = db.prepare(`INSERT OR REPLACE INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')`);
  const insPeriod = db.prepare(`INSERT INTO pension_contribution_periods (movement_id, period_month) VALUES (?, ?)`);
  const byDay = new Map(ledger.afcContributions.map((c) => [c.date, c]));
  const drift = Math.log(1.035) / 250;
  let value = 0;
  let noise = 0.37;
  db.transaction(() => {
    for (let d = ledger.afcContributions[0]!.date; d <= today; d = addDays(d, 1)) {
      const business = isChileBusinessDay(d);
      if (business && value > 0) {
        noise = (noise * 9301 + 49297) % 233280;
        value *= Math.exp(drift + (noise / 233280 - 0.5) * 0.002);
      }
      const c = byDay.get(d);
      if (c) {
        const r = insMov.run(afcId, c.clp, d, `Cotización AFC ${c.month}`);
        insPeriod.run(Number(r.lastInsertRowid), c.month);
        value += c.clp;
      }
      if (business && value > 0) insVal.run(afcId, d, Math.round(value));
    }
  })();
}

/* ------------------------------------ rules ---------------------------------------- */

/** The demo files gym gear and games under «Hobbies»: the seeded «trees» row is renamed in the demo DB only. */
function renameTreesCategoryToHobbies(): void {
  const res = db
    .prepare(
      `UPDATE cc_expense_categories SET slug = 'hobbies', label = 'Hobbies', label_i18n_key = 'expenses.creditCard.categories.hobbies' WHERE slug = 'trees'`
    )
    .run();
  if (res.changes !== 1) throw new Error("demo: cc_expense_categories missing slug trees (reference migrations not applied?)");
}

function seedCategoryRules(ledger: Ledger, ids: Map<Acct, number>): void {
  const cat = (slug: string) => {
    const c = getCcExpenseCategoryBySlug(slug);
    if (!c) throw new Error(`demo: no expense category ${slug}`);
    return c.id;
  };
  // Category rules are global (keyed on the vendor), whichever card or account paid.
  if (ledger.person.cards.length > 0) {
    for (const [merchant, slug] of ledger.categoryByMerchant) setExpenseCategoryRule(normalizeCcExpenseMerchantKey(merchant), null, cat(slug));
  }
  if (ids.has("checking") || ids.has("vista")) {
    for (const [desc, slug] of ledger.categoryByCheckingDescription) setExpenseCategoryRule(normalizeCcExpenseMerchantKey(desc), null, cat(slug));
  }
  for (const [desc, slug] of ledger.categoryByUsDescription) setExpenseCategoryRule(normalizeCcExpenseMerchantKey(desc), null, cat(slug));
  // A cuota's card line: the app's link sync files a linked cuota under «Cuentas y servicios»
  // (its carrying cost; the amortización is split off by the link) — the rule says the same.
  for (const h of ledger.person.houses) setExpenseCategoryRule(normalizeCcExpenseMerchantKey(h.lender.merchant), null, cat("bills"));
  const generic = db.prepare(`INSERT OR IGNORE INTO cc_expense_generic_unique_merchants (merchant_key, sort_order) VALUES (?, ?)`);
  [
    "TRANSF A BROKER DEMO SPA",
    "TRANSF A CRYPTO EXCHANGE SPA",
    "TRANSF A AGF ANDES APV",
    MONEY_MARKET_DEPOSIT_DESCRIPTION,
    MONEY_MARKET_REDEMPTION_DESCRIPTION,
    ...ledger.person.houses.map((h) => h.pieDescription),
  ].forEach((k, i) =>
    generic.run(normalizeCcExpenseMerchantKey(k), 1000 + i * 10)
  );
  invalidateExpenseGenericUniqueMerchantCache();
}

const GROUP_COLORS: ReadonlyArray<[string, string]> = [
  ["net_worth", "255,255,255"],
  ["inversiones", "245,158,11"],
  ["brokerage", "36,36,191"],
  ["brokerage_acciones", "29,153,168"],
  ["brokerage_crypto", "234,179,8"],
  ["cash_eqs", "160,218,232"],
  ["cash_savings", "157,227,245"],
  ["liabilities", "143,24,24"],
  ["real_estate", "91,40,189"],
  ["retirement", "26,171,19"],
  ["retirement_afp_afc", "32,201,58"],
  ["retirement_apv", "38,181,126"],
];

function applyColors(ids: Map<Acct, number>): void {
  const g = db.prepare(`UPDATE portfolio_groups SET color_rgb = ? WHERE slug = ?`);
  for (const [slug, rgb] of GROUP_COLORS) g.run(rgb, slug);
  const a = db.prepare(`UPDATE accounts SET color_rgb = ? WHERE id = ?`);
  const colors: [Acct, string][] = [
    ["checking", "161,11,29"],
    ["checkingUsd", "90,90,150"],
    ["usChecking", "60,110,200"],
    ["usSavings", "40,160,120"],
    ["savingsClp", "120,190,160"],
    ["k401", "59,130,246"],
    ["hsa", "14,165,233"],
    ["rothIra", "124,58,237"],
    ["rothCash", "168,130,240"],
    ["ibkrUsd", "200,40,40"],
    ["dap", "120,160,200"],
    ["btc", "234,179,8"],
    ["stock:NVDA", "118,185,0"],
    ["stock:SPY", "35,55,217"],
    ["card:main", "75,153,189"],
    ["card:second", "180,120,60"],
    ["card:us", "190,30,45"],
  ];
  for (const [key, rgb] of colors) {
    const id = ids.get(key);
    if (id != null) a.run(rgb, id);
  }
}

/* ------------------------------------ entry ---------------------------------------- */


/** The demo person's name as a name pattern (`owner_identity`): «TITULAR DEMO - SANTANDER» is its own transfer. */
export const DEMO_OWNER_NAME_PATTERN = "TITULAR\\s+DEMO";
export function generateDemoDb(opts: GenerateDemoDbOptions): DemoDbReport {
  const person = opts.person;
  const today = opts.today ?? chileCalendarTodayYmd();
  const n = (db.prepare(`SELECT COUNT(*) AS c FROM accounts`).get() as { c: number }).c;
  if (n > 0) throw new Error(`demo: target DB already has ${n} accounts — point NW_TRACKER_TEST_DB at a fresh file`);

  // The instruments first: the registry decides every holding's calendar and currency.
  declareDemoInstruments([...person.brokerTickers, ...(person.btc ? [BTC_TICKER] : [])]);
  const ids = createAccounts(person);
  writePlaces(person, ids);
  // The owner as the bank prints its own transfers (`owner_identity`, migration 277).
  db.prepare(`INSERT INTO owner_identity (kind, value) VALUES ('name_pattern', ?)`).run(DEMO_OWNER_NAME_PATTERN);
  // The tax residency he declares, before the April loop: the F22 of every year reads it.
  for (const d of person.taxResidency) declareTaxResidency({ jurisdiction: d.jurisdiction, fromDate: d.from, note: d.note });
  seedNavTree();
  // With US retirement accounts the Retirement tree reads Chile / US (the personal instance never splits).
  if (ids.has("k401")) ensureRetirementCountrySplit();
  renameTreesCategoryToHobbies();

  if (opts.market === "synthetic") {
    writeSyntheticMarket(person, person.marketFromMonth(today), addDays(today, -1), parseDemoAfpModeloCsv(readFileSync(DEMO_AFP_MODELO_CSV_PATH, "utf8")));
  }
  writeAfpDisplaySeries(person, today);
  const prices = dbMarketReader();
  const spyFrom = (db.prepare(`SELECT MIN(trade_date) AS d FROM equity_daily WHERE ticker = 'SPY' AND trade_date >= ?`).get(
    `${person.marketFromMonth(today)}-01`
  ) as { d: string | null }).d;
  if (!spyFrom) throw new Error("demo: no SPY closes for the APV fund");
  const fundFrom = spyFrom > "2019-01-02" ? spyFrom : "2019-01-02";
  // The APV fund is balanced (65 % equities); the mutual fund is the risky one (90 %); the money
  // market accrues the story's term-deposit curve less its fee.
  writeFundSeries(APV_FUND_SERIES_KEY, { equityShare: 0.65 }, prices, fundFrom, today);
  if (person.fund) writeFundSeries(MUTUAL_FUND_SERIES_KEY, { equityShare: 0.9 }, prices, fundFrom, today);
  if (person.savings.clp) {
    if (`${person.savings.clp.from}-01` < fundFrom) throw new Error(`demo: the money-market fund starts ${person.savings.clp.from}, before its series (${fundFrom})`);
    writeFundSeries(MONEY_MARKET_SERIES_KEY, { annualRatePct: (d) => moneyMarketAnnualRatePct(d) - MONEY_MARKET_FEE_PCT }, prices, fundFrom, today);
  }
  if (person.usJobs.length > 0) {
    const first = person.usJobs.map((j) => j.firstPayDate).sort()[0]!;
    writeUsRetirementFundSeries(prices, addDays(first, -60), today);
  }
  writeOfficialIpcFromUf(person.marketFromMonth(today));
  const market = dbMarketReader();

  // Steps 3–6b run from this checkpoint until the April settlements agree with the tax module.
  const dbFile = (db as unknown as { name: string }).name;
  if (!dbFile || dbFile === ":memory:") throw new Error("demo: the tax passes need a file-backed database");
  const checkpoint = `${dbFile}.pretax`;
  saveDemoPristineCopy(checkpoint);
  let overrides = new Map<number, number>();
  let usOverrides = new Map<number, number>();
  let ledger: Ledger | null = null;
  let payslipResult: ReturnType<typeof applyEmploymentPayslips> | null = null;
  try {
    for (let pass = 1; ; pass++) {
      const life = writeLife(person, market, ids, today, overrides, usOverrides);
      // The 1040 first: the F22's credit for the US tax on the salary reads its line 24.
      const fromUsModule = usAprilSettlementsFromTaxModule(life.ledger, today);
      const fromModule = aprilSettlementsFromTaxModule(life.ledger, today);
      const diffs = [
        ...usSettlementDifferences(life.ledger, fromUsModule).map((d) => ({ ...d, label: `1040 ${d.year}` })),
        ...settlementDifferences(life.ledger, fromModule).map((d) => ({ ...d, label: `F22 ${d.year}` })),
      ];
      if (diffs.length === 0) {
        ledger = life.ledger;
        payslipResult = life.payslipResult;
        console.log(`demo: April settlements agree with the tax module after ${pass} pass(es)`);
        break;
      }
      if (pass >= MAX_TAX_PASSES) {
        throw new Error(
          `demo: April settlements still differ from the tax module after ${pass} passes: ${diffs
            .map((d) => `${d.label} booked ${d.booked} vs module ${d.module}`)
            .join("; ")}`
        );
      }
      console.log(`demo: pass ${pass}: ${diffs.map((d) => `${d.label} ${d.booked} → ${d.module}`).join(", ")}`);
      overrides = fromModule;
      usOverrides = fromUsModule;
      resetDemoDatabaseToPristine({ force: true, pristinePath: checkpoint });
    }
  } finally {
    fs.rmSync(checkpoint, { force: true });
  }
  writeDemoFiledUsReturns(ledger, today);
  writeDemoFiledReturns(ledger, today);

  for (const c of person.cards) recomputeCcBillingMonthBalances(ids.get(`card:${c.key}` as Acct)!);
  seedCategoryRules(ledger, ids);
  ensureAccountSyncSourcesSeeded();
  seedNavTree();
  applyColors(ids);

  const report = assertDemoInvariants(ledger, ids, market, today, { payslips: payslipResult });
  // Last: the history reads the finished ledger (the bank checks state what it holds).
  writeIngestHistory(ledger, ids, person, today);
  return report;
}

/** Steps 3–6b: the life ledger and everything written from it, for one pass. */
function writeLife(
  person: Person,
  market: MarketReader,
  ids: Map<Acct, number>,
  today: Ymd,
  aprilSettlements: ReadonlyMap<number, number>,
  usAprilSettlements: ReadonlyMap<number, number>
): { ledger: Ledger; payslipResult: ReturnType<typeof applyEmploymentPayslips> | null } {
  const ledger = simulate(person, market, today, { aprilSettlements, usAprilSettlements });
  createOptionContractAccounts(ledger, ids);
  writeDirect(ledger, ids);
  writeUsStatementRows(ledger, ids);
  writeSplits(person, today);

  const cartolas = renderCartolas(ledger);
  for (const p of cartolas.statements) {
    const d = applyBankAccountStatements(p);
    const errors = d.files.filter((f) => f.error);
    if (errors.length) throw new Error(`demo: cartola import failed: ${errors.map((e) => `${e.file}: ${e.error}`).join("; ")}`);
  }
  const listing = renderCurrentMonthListing(cartolas.currentMonth);
  if (listing) applyBankAccountMovements(listing, `demo-ultimos-movimientos-${today}.xlsx`);

  const cards = applyCanonicalCardStatements(renderCardStatements(ledger), { dryRun: false, full: true });
  if (cards.problems.length) throw new Error(`demo: card statements: ${cards.problems.join("; ")}`);
  for (const o of renderOpenCycle(ledger)) importCcListingLines(ids.get(`card:${o.card.key}`)!, o.listing, "cc_web_paste");

  const candidates = listCcPaymentMirrorCandidates().filter((c) => !c.blocked);
  if (candidates.length > 0) convertCcPaymentMirrors(candidates.map((c) => ({ out_movement_id: c.out.movement_id, statement_line_id: c.evidence.statement_line_id, statement_id: c.evidence.statement_id })));

  const params = renderPayrollParameters(ledger, market);
  if (params) applyPayrollParameters(params);
  const payslips = renderPayslips(ledger);
  // Parsed as the ingest route parses it: the contract checks every stub's sums.
  const payslipResult = payslips ? applyEmploymentPayslips(employmentPayslipsKind.payload.parse(payslips)) : null;
  writeContractorPayslips(ledger);
  writeMortgages(ledger, ids);
  writeMortgageCardLinks(ledger);
  writeRentOverrides(ledger, ids);
  writePlaceBills(ledger);
  writeFundValuations(ids, market, today);
  writeAfc(ledger, ids.get("afc")!, today);
  if (ids.has("dap")) writeTermDepositValuations(ledger, ids.get("dap")!, today);
  writeDemoTaxDocuments(ledger, today);
  return { ledger, payslipResult };
}
