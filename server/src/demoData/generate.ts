/**
 * The synthetic database generator (docs/demo-generator-plan.md), for the hosted demo's person
 * and the Vitest person (`person.ts`). Order:
 *
 * 1. accounts and the nav trees;
 * 2. market: the real tables (already loaded) or the synthetic ones, plus the series the person's
 *    own funds need (the AFP display frame, the APV fund);
 * 3. the life ledger (`simulate`);
 * 4. ledger rows no bank document carries (transfers between own accounts, the broker, the funds,
 *    the dollar account) — written first, so each cartola row they explain is kept as the transfer;
 * 5. the documents, through the same import functions the ingest kinds call: cartolas, this
 *    month's checking listing, card statements and the open cycle, payroll parameters and
 *    liquidaciones; then the card-payment mirrors are paired as the nightly run pairs them;
 * 6. what the app keeps beside the documents: contractor payslips, contribution periods, the
 *    mortgage ledger, book valuations (property, mortgage, AFC);
 * 6b. the tax documents (boletas, dividend splits, the DJs) and each April from the tax module:
 *    steps 3–6b run again, from a checkpoint taken before step 3, until every April settlement the
 *    simulation booked is the one the tax module computes (`taxDocuments.ts`); then the past
 *    years' returns are stored as filed;
 * 7. category rules, colors, sync sources, the invariants;
 * 8. the ingest history the scheduler would have recorded (`ingestHistory.ts`).
 */
import { setExpenseCategoryRule } from "../expenseCategoryRules.js";
import { readFileSync } from "node:fs";
import { db } from "../db.js";
import { chileCalendarTodayYmd } from "../chileDate.js";
import { seedNavTree } from "../seedNavTree.js";
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
  MORTGAGE_ACCOUNT_IMPORT_KEY,
  PROPERTY_ACCOUNT_IMPORT_KEY,
} from "../accountIdentityKeys.js";
import { isChileBusinessDay } from "../marketHolidays.js";
import { recordEquitySplit } from "../equitySplits.js";
import { ccMasterImportKeyPrefix } from "../ccIssuers.js";
import { isMortgageCcExpenseMerchant } from "../expenseDepositLinks.js";
import { buildPanelAccountNotes, buildPanelCashAccountNotes } from "../panelAccountNotes.js";
import { DEMO_AFP_MODELO_CSV_PATH, parseDemoAfpModeloCsv } from "./demoRealMarket.js";
import { dbMarketReader, writeSyntheticMarket, type MarketReader } from "./market.js";
import { addDays, addMonths, type Month, type Person, type Ymd } from "./person.js";
import {
  renderCardStatements,
  renderCartolas,
  renderCurrentMonthListing,
  renderOpenCycle,
  renderPayrollParameters,
  renderPayslips,
  DEMO_CHECKING_NUMBER,
} from "./render.js";
import { AFP_SWITCH_MONTH, APV_FUND_SERIES_KEY, MORTGAGE_DESGRAVAMEN_CLP, MORTGAGE_INCENDIO_CLP, MORTGAGE_MERCHANT, MUTUAL_FUND_SERIES_KEY, simulate, type Acct, type Ledger } from "./simulate.js";
import { assertDemoInvariants, type DemoDbReport } from "./invariants.js";
import { writeIngestHistory } from "./ingestHistory.js";
import { aprilSettlementsFromTaxModule, settlementDifferences, writeDemoFiledReturns, writeDemoTaxDocuments } from "./taxDocuments.js";
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
    // The exchange suffix is the market, not the name: «CFIETFIPSA.SN» is the CFIETFIPSA account.
    const name = t.replace(/\.SN$/i, "");
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
  if (person.dap) ids.set("dap", createAccount(g("cash_eqs__dap"), "Depósito a plazo"));
  if (person.fund) {
    ids.set("fund", createAccount(g("brokerage_mutual_funds__fintual_risky_norris"), person.fund.name, { key: "import:panel|kind=fund|key=demo_fondo", series: MUTUAL_FUND_SERIES_KEY }));
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
  if (person.house) {
    ids.set("property", createAccount(g("real_estate__property"), "Vitacura", { key: PROPERTY_ACCOUNT_IMPORT_KEY }));
    ids.set("mortgage" as Acct, createAccount(g("liabilities__mortgage"), "Vitacura", { key: MORTGAGE_ACCOUNT_IMPORT_KEY }));
  }
  for (const c of person.cards) {
    const id = createAccount(g("credit_cards__credit_card"), c.displayName, { key: `${ccMasterImportKeyPrefix(c.issuer)}${c.last4}` });
    db.prepare(
      `INSERT INTO credit_card_account_config (account_id, cupo_clp, cupo_usd, billing_cycle_start_day, billing_cycle_end_day, card_last4, issuer)
       VALUES (?, ?, ?, 21, 20, ?, ?)`
    ).run(id, c.key === "main" ? 8_000_000 : 12_000_000, c.key === "main" ? 3_000 : 6_000, c.last4, c.issuer);
    ids.set(`card:${c.key}` as Acct, id);
  }
  db.prepare(`INSERT INTO bank_account_numbers (account_id, issuer, number, currency) VALUES (?, 'santander', ?, 'clp')`).run(ids.get("checking")!, DEMO_CHECKING_NUMBER);
  db.prepare(`INSERT INTO bank_account_numbers (account_id, issuer, number, currency) VALUES (?, 'santander', '5100234567', 'usd')`).run(ids.get("checkingUsd")!);
  return ids;
}

/* ------------------------------------- market -------------------------------------- */

/** The APV fund: a balanced fund (65 % SPY in pesos, 35 % a steady 3 %/yr sleeve), valued daily. */
function writeFundSeries(seriesKey: string, equityShare: number, market: MarketReader, from: Ymd, today: Ymd): void {
  const ins = db.prepare(`INSERT OR REPLACE INTO fund_unit_daily (series_key, day, unit_value, note) VALUES (?, ?, ?, 'demo')`);
  const spy0 = market.close("SPY", from) * market.fx(from);
  db.transaction(() => {
    for (let d = from; d <= today; d = addDays(d, 1)) {
      if (!isChileBusinessDay(d)) continue;
      const years = (Date.parse(d) - Date.parse(from)) / (365.25 * 86_400_000);
      const v = 10_000 * (equityShare * ((market.close("SPY", d) * market.fx(d)) / spy0) + (1 - equityShare) * Math.pow(1.03, years));
      ins.run(seriesKey, d, Math.round(v * 100) / 100);
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
      if (m.type === "single") {
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
 * The mortgage ledger: the pie is written as the bank states it (no prior balance to compute it
 * from), every cuota and prepago through the app's own writer (`commitMortgagePayment`, as the
 * mortgage sheet import writes them) with the bank's figures. The property's appraisal on each
 * payment day is a valuation of the property account in UF.
 */
function writeMortgage(ledger: Ledger, ids: Map<Acct, number>): void {
  const m = ledger.mortgage;
  const HOUSE = ledger.person.house;
  if (!m || !HOUSE) return;
  // The card line that pays a cuota must be one the app recognizes as the mortgage's.
  if (!isMortgageCcExpenseMerchant(MORTGAGE_MERCHANT)) throw new Error(`demo: ${MORTGAGE_MERCHANT} is not a known mortgage lender`);
  const propertyId = ids.get("property")!;
  const mortgageId = ids.get("mortgage" as Acct)!;
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
  const valueUfAt = (day: Ymd) => HOUSE.valueUf * Math.pow(1 + HOUSE.monthlyAppreciation, Math.max(0, (Date.parse(day) - Date.parse(m.pieDate)) / (30.44 * 86_400_000)));
  db.transaction(() => {
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
    insertLoanPaymentRow({ movement_id: Number(pm.lastInsertRowid), loan_account_id: mortgageId, leg: "property", origin: "import", ...loanPaymentColumnsFromPaymentRow(pie) });
    upsertPropertyAppraisalUf(propertyId, m.pieDate, r4(HOUSE.valueUf));
    for (const c of [...m.cuotas].sort((a, b) => a.date.localeCompare(b.date))) {
      // A prepago is all extra amortization, with no interest or insurance.
      const regular = c.n != null;
      commitMortgagePayment(
        mortgageId,
        {
          occurred_on: c.date,
          cuota: c.label,
          pago_clp: c.clp,
          interes_clp: regular ? Math.round(c.interestUf * c.ufDay) : 0,
          incendio_clp: regular ? MORTGAGE_INCENDIO_CLP : 0,
          desgravamen_clp: regular ? MORTGAGE_DESGRAVAMEN_CLP : 0,
          amortizacion_ext_clp: regular ? Math.round(c.extUf * c.ufDay) : c.clp,
          min_uf: regular ? r5(c.pmtUf) : null,
          max_uf: regular ? r5(c.pmtUf * 1.2 + c.extUf) : null,
          credito_restante_uf: r4(c.balanceAfterUf),
        },
        { origin: "import" }
      );
      upsertPropertyAppraisalUf(propertyId, c.date, r4(valueUfAt(c.date)));
    }
  })();
}

/** APV and mutual fund accounts are book accounts: units × the fund's value, marked every business day. */
function writeFundValuations(ids: Map<Acct, number>, market: MarketReader, today: Ymd): void {
  const insVal = db.prepare(`INSERT OR REPLACE INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')`);
  for (const [key, series] of [["apvA", APV_FUND_SERIES_KEY], ["apvB", APV_FUND_SERIES_KEY], ["fund", MUTUAL_FUND_SERIES_KEY]] as const) {
    const id = ids.get(key);
    if (id == null) continue;
    const rows = db
      .prepare(
        `SELECT occurred_on, units_delta FROM movements WHERE (account_id = ? OR to_account_id = ?) AND units_delta IS NOT NULL ORDER BY occurred_on`
      )
      .all(id, id) as { occurred_on: string; units_delta: number }[];
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
  const generic = db.prepare(`INSERT OR IGNORE INTO cc_expense_generic_unique_merchants (merchant_key, sort_order) VALUES (?, ?)`);
  ["TRANSF A BROKER DEMO SPA", "TRANSF A CRYPTO EXCHANGE SPA", "TRANSF A AGF ANDES APV", "TRANSF A INMOBILIARIA LOS ALAMOS"].forEach((k, i) =>
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
    ["ibkrUsd", "200,40,40"],
    ["dap", "120,160,200"],
    ["btc", "234,179,8"],
    ["stock:NVDA", "118,185,0"],
    ["stock:SPY", "35,55,217"],
    ["card:main", "75,153,189"],
    ["card:second", "180,120,60"],
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

  const ids = createAccounts(person);
  // The owner as the bank prints its own transfers (`owner_identity`, migration 277).
  db.prepare(`INSERT INTO owner_identity (kind, value) VALUES ('name_pattern', ?)`).run(DEMO_OWNER_NAME_PATTERN);
  seedNavTree();
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
  // The APV fund is balanced (65 % equities); the mutual fund is the risky one (90 %).
  writeFundSeries(APV_FUND_SERIES_KEY, 0.65, prices, fundFrom, today);
  if (person.fund) writeFundSeries(MUTUAL_FUND_SERIES_KEY, 0.9, prices, fundFrom, today);
  writeOfficialIpcFromUf(person.marketFromMonth(today));
  const market = dbMarketReader();

  // Steps 3–6b run from this checkpoint until the April settlements agree with the tax module.
  const dbFile = (db as unknown as { name: string }).name;
  if (!dbFile || dbFile === ":memory:") throw new Error("demo: the tax passes need a file-backed database");
  const checkpoint = `${dbFile}.pretax`;
  saveDemoPristineCopy(checkpoint);
  let overrides = new Map<number, number>();
  let ledger: Ledger | null = null;
  let payslipResult: ReturnType<typeof applyEmploymentPayslips> | null = null;
  try {
    for (let pass = 1; ; pass++) {
      const life = writeLife(person, market, ids, today, overrides);
      const fromModule = aprilSettlementsFromTaxModule(life.ledger, today);
      const diffs = settlementDifferences(life.ledger, fromModule);
      if (diffs.length === 0) {
        ledger = life.ledger;
        payslipResult = life.payslipResult;
        console.log(`demo: April settlements agree with the tax module after ${pass} pass(es)`);
        break;
      }
      if (pass >= MAX_TAX_PASSES) {
        throw new Error(
          `demo: April settlements still differ from the tax module after ${pass} passes: ${diffs
            .map((d) => `${d.year} booked ${d.booked} vs module ${d.module}`)
            .join("; ")}`
        );
      }
      console.log(`demo: pass ${pass}: ${diffs.map((d) => `${d.year} ${d.booked} → ${d.module}`).join(", ")}`);
      overrides = fromModule;
      resetDemoDatabaseToPristine({ force: true, pristinePath: checkpoint });
    }
  } finally {
    fs.rmSync(checkpoint, { force: true });
  }
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
  aprilSettlements: ReadonlyMap<number, number>
): { ledger: Ledger; payslipResult: ReturnType<typeof applyEmploymentPayslips> | null } {
  const ledger = simulate(person, market, today, { aprilSettlements });
  writeDirect(ledger, ids);
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
  const payslipResult = payslips ? applyEmploymentPayslips(payslips) : null;
  writeContractorPayslips(ledger);
  writeMortgage(ledger, ids);
  writeFundValuations(ids, market, today);
  writeAfc(ledger, ids.get("afc")!, today);
  if (ids.has("dap")) writeTermDepositValuations(ledger, ids.get("dap")!, today);
  writeDemoTaxDocuments(ledger, today);
  return { ledger, payslipResult };
}
