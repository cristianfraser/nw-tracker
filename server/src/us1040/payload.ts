/**
 * The /tax-return page's US tab: the local Form 1040 for one tax year as ordered rows (the client
 * only labels and formats them; `line` is the role, `printed_line` the number the year's form
 * prints — 7a, 12e on the 2025 form), the schedules and worksheets behind them, Form 8949's rows,
 * the dual-status statement, the foreign-account flags, the W-2s behind line 1a, FICA reported
 * beside the return, the filed return and its settlement. A nonresident year is not drafted: the
 * payload says why and carries the W-2s. Server: us1040/draft.ts, us1040/filed.ts.
 */
import type {
  UsTaxReturnResponse,
  UsTaxReturnRow,
  UsTaxReturnRowSection,
  UsTaxReturnSchedule,
} from "nw-tracker-contracts/dto/taxReturn";
import { chileWallClockNow } from "../chileDate.js";
import { availableUsTaxYears, buildF1040Draft, loadStubs, usReturnStatusForYear, type F1040Draft } from "./draft.js";
import { f1040Settlement } from "./filed.js";
import { F1040_LINES, f1040PrintedLine, f1040YearHasLine, type F1040Line } from "./identities.js";
import { usW2sFromStubLines } from "../usW2.js";

const ROW_SECTION: Record<F1040Line, UsTaxReturnRowSection> = {
  "1a": "income",
  "1z": "subtotal",
  "2a": "income",
  "2b": "income",
  "3a": "income",
  "3b": "income",
  "7": "income",
  "8": "income",
  "9": "subtotal",
  "10": "deduction",
  "11": "subtotal",
  "12": "deduction",
  "13": "deduction",
  "13b": "deduction",
  "14": "deduction",
  "15": "subtotal",
  "16": "tax",
  "17": "tax",
  "18": "tax",
  "19": "credit",
  "20": "credit",
  "21": "credit",
  "22": "tax",
  "23": "tax",
  "24": "result",
  "25a": "payment",
  "25b": "payment",
  "25c": "payment",
  "25d": "payment",
  "26": "payment",
  "27": "payment",
  "28": "payment",
  "29": "payment",
  "31": "payment",
  "32": "payment",
  "33": "payment",
  "34": "result",
  "35a": "result",
  "36": "result",
  "37": "result",
};

/** Lines shown even at zero: the chain from wages to what is owed or refunded. */
const ALWAYS_SHOWN = new Set<F1040Line>(["1a", "11", "12", "15", "16", "24", "25a", "25d", "33"]);

function schedules(d: F1040Draft): UsTaxReturnSchedule[] {
  const of = (form: UsTaxReturnSchedule["form"], lines: Record<string, number>): UsTaxReturnSchedule => ({
    form,
    lines: Object.entries(lines).map(([line, amount]) => ({ line, amount })),
  });
  const out: UsTaxReturnSchedule[] = [
    of("schedule_b", { "2": d.scheduleB.line2, "4": d.scheduleB.line4, "6": d.scheduleB.line6 }),
    of("schedule_d", d.scheduleD.lines),
    of("schedule_1", d.schedule1),
    of("schedule_2", d.schedule2),
    of("schedule_3", d.schedule3),
    of("form_8960", d.form8960),
  ];
  if (d.qdcgWorksheet) out.push(of("qdcg_worksheet", d.qdcgWorksheet));
  return out;
}

export function buildF1040Payload(taxYear: number, todayYmd: string = chileWallClockNow().ymd): UsTaxReturnResponse {
  const status = usReturnStatusForYear(taxYear);
  const available = availableUsTaxYears(todayYmd);
  if (!status.drafted) {
    const { stubs, statuses } = loadStubs(taxYear);
    if (statuses.size !== 1) throw new Error(`1040 ${taxYear}: the stubs carry ${statuses.size} W-4 filing statuses`);
    const w2s = usW2sFromStubLines(stubs);
    return {
      jurisdiction: "us",
      tax_year: taxYear,
      available_tax_years: available,
      drafted: false,
      not_drafted_reason: status.reason,
      residency: { kind: status.residency.kind, from: status.residency.from },
      resident_window: null,
      provisional: taxYear >= Number(todayYmd.slice(0, 4)),
      law_year: taxYear,
      filing_status: [...statuses][0]!,
      stubs: stubs.length,
      notes: [],
      w2s: w2s.map(w2Row),
      fica: { social_security: 0, medicare: 0, total: 0, additional_medicare_tax: 0 },
      rows: [],
      schedules: [],
      schedule_b: null,
      form_8949: [],
      capital_loss_carryover: null,
      dual_status_statement: null,
      foreign_accounts: null,
      foreign_tax_withheld_usd: 0,
      schedule_e: null,
      form_8582: null,
      form_1116: null,
      form_8621: [],
      tax_filed: null,
      tax_draft: 0,
      refund_draft: 0,
      owed_draft: 0,
      filed: null,
      settlement: null,
    };
  }
  const d = buildF1040Draft(taxYear, todayYmd);
  const filedLines = d.filed?.lines ?? null;
  const rows: UsTaxReturnRow[] = F1040_LINES.filter((l) => f1040YearHasLine(l, d.taxYear)).filter(
    (l) => filedLines?.[l] != null || (d.lines[l] ?? 0) !== 0 || ALWAYS_SHOWN.has(l)
  ).map((line) => {
    const filed = filedLines ? (filedLines[line] ?? 0) : null;
    const draft = d.lines[line] ?? 0;
    return {
      line,
      printed_line: f1040PrintedLine(line, d.taxYear),
      section: ROW_SECTION[line],
      filed,
      draft,
      changed: filed != null && filed !== draft,
    };
  });
  const s = d.dualStatusStatement;
  const fa = d.foreignAccounts;
  return {
    jurisdiction: "us",
    tax_year: d.taxYear,
    available_tax_years: available,
    drafted: true,
    not_drafted_reason: null,
    residency: { kind: d.residency.kind, from: d.residency.from },
    resident_window: { from: d.residentWindow.fromYmd, through: d.residentWindow.throughYmd },
    provisional: d.provisional,
    law_year: d.lawYear,
    filing_status: d.filingStatus,
    stubs: d.stubs,
    notes: d.notes,
    w2s: d.w2s.map(w2Row),
    fica: {
      social_security: d.fica.socialSecurity,
      medicare: d.fica.medicare,
      total: Math.round((d.fica.socialSecurity + d.fica.medicare) * 100) / 100,
      additional_medicare_tax: d.additionalMedicareTax,
    },
    rows,
    schedules: schedules(d),
    schedule_b: { interest: d.scheduleB.interestRows, dividends: d.scheduleB.dividendRows, qualified_dividends: d.scheduleB.qualifiedDividends },
    form_8949: d.form8949.map((r) => ({
      box: r.box,
      term: r.term,
      description: r.description,
      acquired: r.acquired,
      sold: r.sold,
      proceeds: r.proceeds,
      cost: r.cost,
      adjustment_code: r.adjustmentCode,
      adjustment: r.adjustment,
      gain: r.gain,
      source: r.source,
    })),
    capital_loss_carryover: {
      in: { short_term: d.capitalLossCarryoverIn.shortTerm, long_term: d.capitalLossCarryoverIn.longTerm },
      out: { short_term: d.capitalLossCarryoverOut.shortTerm, long_term: d.capitalLossCarryoverOut.longTerm },
    },
    dual_status_statement: s
      ? {
          from: s.from,
          rows: s.rows.map((r) => ({
            date: r.date,
            instrument: r.instrument,
            gross_usd: Math.round(r.grossUsd * 100) / 100,
            rate_pct: r.ratePct,
            tax_usd: r.taxUsd,
            withheld_usd: Math.round(r.withheldUsd * 100) / 100,
          })),
          gross_usd: s.grossUsd,
          tax: s.tax,
          withheld: s.withheld,
        }
      : null,
    foreign_accounts: fa
      ? {
          accounts: fa.accounts.map((a) => ({ name: a.name, year_end_usd: a.yearEndUsd, peak_month_end_usd: a.peakMonthEndUsd })),
          year_end_usd: fa.yearEndUsd,
          peak_month_end_usd: fa.peakMonthEndUsd,
          fbar_required: fa.fbarRequired,
          form8938_required: fa.form8938Required,
        }
      : null,
    foreign_tax_withheld_usd: d.foreignTaxWithheldUsd,
    ...wiredSections(d),
    tax_filed: filedLines ? (filedLines["24"] ?? 0) : null,
    tax_draft: d.lines["24"] ?? 0,
    refund_draft: d.lines["35a"] ?? 0,
    owed_draft: d.lines["37"] ?? 0,
    filed: d.filed ? { filed_on: d.filed.filedOn, filing_status: d.filed.filingStatus, source_file: d.filed.sourceFile } : null,
    settlement: f1040Settlement(taxYear),
  };
}

const usd = (x: number) => Math.round(x);
const usdCents = (x: number) => Math.round(x * 100) / 100;

/** Schedule E, Form 8582, Form 1116 and Form 8621 as the draft composed them. */
function wiredSections(d: F1040Draft): Pick<UsTaxReturnResponse, "schedule_e" | "form_8582" | "form_1116" | "form_8621"> {
  const r = d.rentals;
  const f = r?.form8582 ?? null;
  const t = d.foreignTaxCredit;
  return {
    schedule_e:
      r && r.scheduleE.places.length > 0
        ? {
            places: r.scheduleE.places.map((p, i) => ({
              label: p.label,
              lines: Object.entries(p.lines).map(([k, v]) => ({ line: k.slice(1), amount: usd(v) })),
              depreciation: {
                basis_usd: usd(r.inputs[i]!.depreciation.basisUsd),
                basis_origin: r.inputs[i]!.depreciation.basisOrigin,
                building_basis_usd: usd(p.depreciation.buildingBasisUsd),
                start_date: p.depreciation.startDate,
                reading: p.depreciation.reading,
                months_in_window: Math.round(p.depreciation.monthsInWindow * 100) / 100,
                amount_usd: usd(p.depreciation.amountUsd),
              },
            })),
            net_usd: usd(r.scheduleE.netUsd),
          }
        : null,
    form_8582:
      r && f
        ? {
            magi_usd: usd(r.magiUsd),
            allowance_before_phase_out_usd: usd(f.allowanceBeforePhaseOutUsd),
            allowance_usd: usd(f.allowanceUsd),
            prior_suspended_loss_usd: usd(r.priorSuspendedLossUsd),
            limited_loss_usd: usd(f.limitedLossUsd),
            allowed_loss_usd: usd(f.allowedLossUsd),
            suspended_loss_usd: usd(f.suspendedLossUsd),
            prior_loss_absorbed_usd: usd(f.priorLossAbsorbedUsd),
            included_in_income_usd: r.line5,
          }
        : null,
    form_1116: t
      ? {
          chile: t.chile
            ? { tax_year: t.chile.taxYear, adicional_clp: t.chile.adicionalClp, adicional_source: t.chile.adicionalSource, unico_art107_clp: t.chile.unicoArt107Clp }
            : null,
          rate_clp_per_usd: usdCents(t.rateClpPerUsd),
          taxes: t.classified.map((c) => ({ item: c.item, amount_usd: usd(c.amountUsd), creditable: c.creditable, unverified: c.unverified, form8833: c.form8833 })),
          foreign_passive_gross_usd: usd(t.input.foreignPassiveGrossUsd),
          foreign_passive_deductions_usd: usd(t.input.foreignPassiveDeductionsUsd),
          foreign_passive_taxable_income_usd: usd(t.result.foreignPassiveTaxableIncomeUsd),
          taxable_income_usd: t.input.taxableIncomeUsd,
          us_tax_before_credits_usd: t.input.usTaxBeforeCreditsUsd,
          limit_fraction: Math.round(t.result.limitFraction * 1e6) / 1e6,
          limit_usd: usd(t.result.limitUsd),
          taxes_accrued_usd: usd(t.input.taxesAccruedUsd),
          available_usd: usd(t.result.availableUsd),
          credit_usd: t.credit,
          carryovers_in: t.input.carryoversIn.map((c) => ({ tax_year: c.taxYear, amount_usd: usd(c.amountUsd) })),
          carryovers_out: t.result.carryoversOut.map((c) => ({ tax_year: c.taxYear, amount_usd: usd(c.amountUsd) })),
          expired_usd: usd(t.result.expiredUsd),
        }
      : null,
    form_8621: d.form8621.map((x) => ({
      label: x.label,
      start_units: Math.round(x.startUnits * 1e4) / 1e4,
      start_basis_usd: usd(x.startBasisUsd),
      basis_before_mark_usd: usd(x.basisBeforeMarkUsd),
      fmv_year_end_usd: usd(x.fmvYearEndUsd),
      inclusion_usd: usd(x.inclusionUsd),
      deduction_usd: usd(x.deductionUsd),
      disallowed_loss_usd: usd(x.disallowedLossUsd),
      disposals: x.disposals.map((p) => ({
        date: p.date,
        units: Math.round(p.units * 1e4) / 1e4,
        proceeds_usd: usd(p.proceedsUsd),
        basis_usd: usd(p.basisUsd),
        ordinary_gain_usd: usd(p.ordinaryGainUsd),
        ordinary_loss_usd: usd(p.ordinaryLossUsd),
        capital_loss_usd: usd(p.capitalLossUsd),
      })),
      ordinary_income_usd: usd(x.ordinaryIncomeUsd),
      capital_loss_usd: usd(x.capitalLossUsd),
      end_units: Math.round(x.stateOut.units * 1e4) / 1e4,
      end_basis_usd: usd(x.stateOut.adjustedBasisUsd),
      unreversed_inclusions_usd: usd(x.stateOut.unreversedInclusionsUsd),
      part_v_possible: x.flags.partVPossible,
    })),
  };
}

function w2Row(w: ReturnType<typeof usW2sFromStubLines>[number]): UsTaxReturnResponse["w2s"][number] {
  return {
    employer: w.employer,
    ein: w.ein,
    stubs: w.stubs,
    box1_wages: w.wages,
    box2_federal_withheld: w.federalWithheld,
    box3_social_security_wages: w.socialSecurityWages,
    box4_social_security_tax: w.socialSecurityTax,
    box5_medicare_wages: w.medicareWages,
    box6_medicare_tax: w.medicareTax,
    box12_d: w.box12D,
    box12_aa: w.box12AA,
    box12_w: w.box12W,
  };
}
