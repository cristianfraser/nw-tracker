/**
 * The schedules the 1040 draft composes from their own modules, computed from the ledger for a
 * drafted year with a declared US residency (docs/us-1040-readings.md is the law; each pure module
 * states its readings):
 *
 * - **Schedule E** per rented place (`scheduleE.ts`, the window's rents and bills, the loan's
 *   interest and fire insurance, ADS depreciation) and **Form 8582** (`form8582.ts`): the passive
 *   limit at the year's modified AGI, the suspended loss carried from the prior year's draft. What
 *   passes is Schedule 1 line 5 and Form 8960 line 4a.
 * - **Form 8621 Part IV** for every PFIC holding (`pfic.ts`, `form8621.ts`), rolled forward from
 *   the first US year (its arrival basis): the ordinary result is Schedule 1 line 8z and part of
 *   Form 8960 line 5a; a sale's capital loss is a Form 8949 row.
 * - **Options** (`optionTaxLotEvents.ts`): each closed lot a Form 8949 row (a written option always
 *   short-term, §1234(b); a long one by its dates); an assigned or exercised contract has no row of
 *   its own — its premium is in the share trade's basis or proceeds (`facts.ts` turns the equity
 *   walk's option adjustments on).
 * - **Form 1116**, passive category (`form1116.ts`): the Chilean taxes of the same income year
 *   under the accrued method — the F22's Impuesto Adicional (code 34) and art. 107 único (1830) of
 *   its non-resident part, read from the F22 module after `taxReturnOrder` says it comes first —,
 *   classified (`classifyChileanTaxes`), translated at the year's average rate
 *   ({@link FTC_ACCRUED_TAX_TRANSLATION}); the limit on the foreign-source passive income (the
 *   rents as Form 8582 lets them through, foreign dividends and interest); carryovers from the prior
 *   year's draft. The credit is Schedule 3 line 1 → Form 1040 line 20.
 */
import { art107InstrumentKind } from "../art107Instruments.js";
import { db } from "../db.js";
import { inDateWindow, type DateWindow } from "../dateWindow.js";
import { f22TaxOnUsWindow, type F22TaxOnUsWindow } from "../f22/year.js";
import { OPTION_TRANSFER_FLOW_KINDS } from "../optionFlowKinds.js";
import { requireOptionContract } from "../optionContracts.js";
import { loadOptionTaxLotEvents, optionLotResults, type OptionLotResult } from "../optionTaxLotEvents.js";
import { equityAccountDisposalFacts, equityLotAccounts } from "../taxFacts/disposals.js";
import { loadAccountPayers } from "../taxFacts/payers.js";
import { assertReadsEarlierReturn } from "../taxReturnOrder.js";
import { listTaxResidencyPeriods } from "../taxResidency.js";
import { classifyChileanTaxes, form1116, type ClassifiedChileanTax, type Form1116Input, type Form1116Result, type FtcCarryover } from "./form1116.js";
import { form8582, type Form8582Result, type Form8582Status } from "./form8582.js";
import { form8621Inputs, form8621Year, type Form8621Result, type Form8621State } from "./form8621.js";
import { form8949Box, type Form8949Row, type Form8949Term } from "./form8949.js";
import { usdClpYearlyAverage, usdOn } from "./fx.js";
import { scheduleE, scheduleEInputs, type ScheduleEPlaceInput, type ScheduleEResult } from "./scheduleE.js";

/* ------------------------------- residency ------------------------------ */

/** The first day of the declared US residency the window lies in (Schedule E's and Form 8621's «first day as a US person»). */
export function usPersonSinceFor(window: DateWindow): string {
  const p = listTaxResidencyPeriods().find(
    (x) => x.jurisdiction === "us" && x.fromDate <= window.fromYmd && (x.toDate == null || x.toDate >= window.fromYmd)
  );
  if (!p) throw new Error(`1040: no declared US residency covers ${window.fromYmd}`);
  return p.fromDate;
}

/* ------------------------- Schedule E and 8582 -------------------------- */

export type F1040Rentals = {
  inputs: ScheduleEPlaceInput[];
  scheduleE: ScheduleEResult;
  /** Null without a rented place in the window and nothing carried in. */
  form8582: Form8582Result | null;
  /** The modified AGI Form 8582 read, and the loss carried in. */
  magiUsd: number;
  priorSuspendedLossUsd: number;
  /** Schedule 1 line 5, whole dollars. */
  line5: number;
};

/** Schedule E's places of the window (each amount at its own day's rate) before the passive limit. */
export function scheduleEForWindow(window: DateWindow): { inputs: ScheduleEPlaceInput[]; scheduleE: ScheduleEResult } {
  const inputs = scheduleEInputs(window, usdOn, { usPersonSince: usPersonSinceFor(window) });
  return { inputs, scheduleE: scheduleE(inputs) };
}

/**
 * Form 8582 on Schedule E's net: the special allowance at `magiWithoutPassiveLoss` (§469(i)(3)(F):
 * AGI figured without any passive activity loss — a net rental income is in it, a loss is not).
 */
export function rentalsAfterPassiveLimit(
  e: { inputs: ScheduleEPlaceInput[]; scheduleE: ScheduleEResult },
  status: Form8582Status,
  magiWithoutPassiveLoss: number,
  priorSuspendedLossUsd: number
): F1040Rentals {
  const base = { ...e, magiUsd: magiWithoutPassiveLoss, priorSuspendedLossUsd };
  if (e.inputs.length === 0 && priorSuspendedLossUsd === 0) return { ...base, form8582: null, line5: 0 };
  const f = form8582({ status, magiUsd: magiWithoutPassiveLoss, rentalNetUsd: e.scheduleE.netUsd, priorSuspendedLossUsd });
  return { ...base, form8582: f, line5: Math.round(f.includedInIncomeUsd) };
}

/* ------------------------------- Form 8621 ------------------------------ */

/**
 * A PFIC sale's capital loss (above its unreversed inclusions, Reg. §1.1296-1(c)(4)) is a Form 8949
 * row. Its term is not settled by the lots: Form 8621's basis is pro rata over the whole holding,
 * so the sold units carry no purchase day of their own. Read as long-term (the holdings are years
 * old on the demo); the alternative is FIFO lot dates through the equity walk. Stated on the return.
 */
export const PFIC_CAPITAL_LOSS_TERM: Form8949Term = "long_term";

/** Every PFIC holding's Part IV for the year, each from its prior year's state (none in the first US year: the arrival basis). */
export function form8621ForYear(
  taxYear: number,
  residentWindow: DateWindow,
  firstUsYear: number,
  priorStates: ReadonlyMap<number, Form8621State> | null
): Form8621Result[] {
  return form8621Inputs(taxYear, residentWindow, usdOn, { firstUsYear }).map((input) => {
    const carried = priorStates?.get(input.accountId) ?? null;
    if (input.arrival && carried) throw new Error(`Form 8621: ${input.label} has an arrival basis and a state carried from ${taxYear - 1}`);
    return form8621Year(input, input.arrival ? null : carried);
  });
}

/** The Form 8949 rows of the PFIC sales' capital losses ({@link PFIC_CAPITAL_LOSS_TERM}). */
export function pficCapitalLossRows(results: readonly Form8621Result[], taxYear: number): Form8949Row[] {
  return results.flatMap((r) =>
    r.disposals
      .filter((d) => Math.round(d.capitalLossUsd) > 0)
      .map((d): Form8949Row => {
        const proceeds = Math.round(d.proceedsUsd);
        const cost = proceeds + Math.round(d.capitalLossUsd);
        return {
          description: `${Math.round(d.units * 1e4) / 1e4} ${r.label} (Form 8621, capital part)`,
          acquired: "VARIOUS",
          sold: d.date,
          proceeds,
          cost,
          adjustmentCode: null,
          adjustment: 0,
          gain: proceeds - cost,
          term: PFIC_CAPITAL_LOSS_TERM,
          box: form8949Box(PFIC_CAPITAL_LOSS_TERM, { reportedOn1099B: false, digitalAsset: false }, taxYear),
          source: "pfic",
          movementId: null,
        };
      })
  );
}

/* -------------------------------- options ------------------------------- */

/** The cash account a contract's premiums settle in (one for the contract), or null without premium movements. */
function contractCashAccount(contractId: number): number | null {
  const kinds = OPTION_TRANSFER_FLOW_KINDS as readonly string[];
  const rows = db
    .prepare(
      `SELECT DISTINCT CASE WHEN from_account_id = ? THEN to_account_id ELSE from_account_id END AS cash FROM movements
        WHERE (from_account_id = ? OR to_account_id = ?) AND flow_kind IN (${kinds.map(() => "?").join(", ")})`
    )
    .all(contractId, contractId, contractId, ...kinds) as { cash: number | null }[];
  const cash = [...new Set(rows.map((r) => r.cash))];
  if (cash.length > 1) throw new Error(`Option lots: contract ${contractId} settles premiums in ${cash.length} accounts`);
  return cash[0] ?? null;
}

export type F1040OptionLot = OptionLotResult & { contractAccountId: number; contract: string };

/** The option lots closed in the window and their Form 8949 rows (assigned / exercised lots have none: their premium is in the share trade). */
export function optionRowsForWindow(window: DateWindow, taxYear: number): { lots: F1040OptionLot[]; rows: Form8949Row[] } {
  const contracts = (db.prepare(`SELECT account_id FROM option_contracts ORDER BY account_id`).all() as { account_id: number }[]).map((r) => r.account_id);
  const payers = loadAccountPayers();
  const names = db.prepare(`SELECT name FROM accounts WHERE id = ?`);
  const lots: F1040OptionLot[] = [];
  const rows: Form8949Row[] = [];
  for (const id of contracts) {
    requireOptionContract(id);
    const results = optionLotResults(loadOptionTaxLotEvents(id)).filter((r) => inDateWindow(r.closedOn, window));
    if (results.length === 0) continue;
    const contract = (names.get(id) as { name: string }).name;
    const cash = contractCashAccount(id);
    const reportedOn1099B = cash != null && (payers.get(cash) ?? []).some((p) => p.country === "US");
    for (const r of results) {
      lots.push({ ...r, contractAccountId: id, contract });
      if (r.how === "assigned" || r.how === "exercised") continue;
      const proceeds = Math.round(r.proceeds);
      const cost = Math.round(r.cost);
      rows.push({
        description: `${r.contracts} ${contract} (${r.side === "short" ? "written" : "bought"}, ${r.how.replace("_", " ")})`,
        acquired: r.openedOn,
        sold: r.closedOn,
        proceeds,
        cost,
        adjustmentCode: null,
        adjustment: 0,
        gain: proceeds - cost,
        term: r.term,
        box: form8949Box(r.term, { reportedOn1099B, digitalAsset: false }, taxYear),
        source: "option",
        movementId: r.closeMovementId,
      });
    }
  }
  return { lots, rows };
}

/* ------------------------------- Form 1116 ------------------------------ */

/**
 * How an accrued foreign tax becomes dollars: the average rate of the year it relates to (Pub. 514
 * «Exception», §986(a)(1): paid within 24 months of the year's end, the currency not inflationary —
 * the F22's April payment always is). The alternative, `payment_day_spot`, is the rule when either
 * condition fails (or under the paid method); not built.
 */
export const FTC_ACCRUED_TAX_TRANSLATION = "yearly_average_fx_daily" as const;

export type F1040ForeignTaxCredit = {
  /** What the F22 module states for the US-resident months (null when Chile taxed nothing there). */
  chile: F22TaxOnUsWindow | null;
  /** CLP per USD the taxes translate at ({@link FTC_ACCRUED_TAX_TRANSLATION}). */
  rateClpPerUsd: number;
  classified: ClassifiedChileanTax[];
  input: Form1116Input;
  result: Form1116Result;
  /** Schedule 3 line 1, whole dollars. */
  credit: number;
};

/**
 * Whether Chile taxes anything of the US-resident window — a rent credit on a rented place, an
 * art. 107 instrument sold —, i.e. whether the 1040 has a Chilean tax to read. Without one the F22
 * is not asked (Chile taxes a non-resident on nothing else the app models).
 */
export function chileTaxesUsWindow(window: DateWindow, rentals: { inputs: ScheduleEPlaceInput[] }): boolean {
  if (rentals.inputs.some((p) => p.rentsUsd > 0)) return true;
  const art107 = equityLotAccounts().filter((a) => art107InstrumentKind(a.ticker) != null);
  return equityAccountDisposalFacts(window, { method: "fifo", accounts: art107 }).some((a) => a.disposals.length > 0);
}

/** Chile's taxes on the year's US-resident months, read from the F22 (which `taxReturnOrder` computes first). */
export function chileanTaxForF1040(incomeYear: number, todayYmd: string): F22TaxOnUsWindow | null {
  assertReadsEarlierReturn("f1040", "f22", incomeYear);
  return f22TaxOnUsWindow(incomeYear, todayYmd);
}

export function foreignTaxCredit(input: {
  taxYear: number;
  rateThroughYmd: string;
  chile: F22TaxOnUsWindow | null;
  foreignPassiveGrossUsd: number;
  foreignPassiveDeductionsUsd: number;
  taxableIncomeUsd: number;
  usTaxBeforeCreditsUsd: number;
  carryoversIn: readonly FtcCarryover[];
}): F1040ForeignTaxCredit | null {
  const items: { item: "adicional_on_rent" | "unico_on_etf_sale"; amountUsd: number }[] = [];
  const hasTaxes = input.chile != null && (input.chile.adicionalClp > 0 || input.chile.unicoArt107Clp > 0);
  if (!hasTaxes && input.carryoversIn.every((c) => c.amountUsd <= 0)) return null;
  const rate = usdClpYearlyAverage(input.taxYear, input.rateThroughYmd);
  if (input.chile && input.chile.adicionalClp > 0) items.push({ item: "adicional_on_rent", amountUsd: input.chile.adicionalClp / rate });
  if (input.chile && input.chile.unicoArt107Clp > 0) items.push({ item: "unico_on_etf_sale", amountUsd: input.chile.unicoArt107Clp / rate });
  const { creditableUsd, classified } = classifyChileanTaxes(items);
  const f: Form1116Input = {
    taxYear: input.taxYear,
    foreignPassiveGrossUsd: input.foreignPassiveGrossUsd,
    foreignPassiveDeductionsUsd: input.foreignPassiveDeductionsUsd,
    taxableIncomeUsd: input.taxableIncomeUsd,
    usTaxBeforeCreditsUsd: input.usTaxBeforeCreditsUsd,
    taxesAccruedUsd: creditableUsd,
    carryoversIn: input.carryoversIn,
  };
  const result = form1116(f);
  return { chile: input.chile, rateClpPerUsd: rate, classified, input: f, result, credit: Math.round(result.creditAllowedUsd) };
}
