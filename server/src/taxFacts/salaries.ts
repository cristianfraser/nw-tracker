/**
 * Pay in a window, as its documents state it: the Chilean liquidaciones (keyed by the month they
 * pay, `period_month`), the US pay stubs (keyed by the day they were paid, with every printed line),
 * and the boletas de honorarios issued. Amounts as stored, in the document's currency. No reajuste,
 * no taxable-pay rule: which lines a return counts is the return's (`f22/salary.ts`, `usW2.ts`).
 */
import { db } from "../db.js";
import { windowMonths, type DateWindow } from "../dateWindow.js";

/** A Chilean liquidación's totals (`payroll_work_earnings`, `jurisdiction = 'cl'`); pesos unless `liquidoCurrency` says otherwise. */
export type ChileanPayslipFact = {
  payslipId: number;
  periodMonth: string;
  employer: string;
  earningType: string;
  liquidoCurrency: string;
  totalHaberesClp: number | null;
  totalImponibleClp: number | null;
  totalNoImponibleClp: number | null;
  colacionClp: number | null;
  movilizacionClp: number | null;
  descAfpClp: number | null;
  descHealthClp: number | null;
  descCesantiaClp: number | null;
  descTaxClp: number | null;
};

/** The liquidaciones whose period month falls in the window, by month then id. */
export function chileanPayslipFacts(window: DateWindow): ChileanPayslipFact[] {
  const { fromMonth, throughMonth } = windowMonths(window);
  return (
    db
      .prepare(
        `SELECT id, period_month, employer_name, earning_type, liquido_currency, total_haberes_clp, total_imponible_clp,
                total_no_imponible_clp, colacion_clp, movilizacion_clp, desc_afp_clp, desc_health_clp, desc_cesantia_clp,
                desc_tax_clp
           FROM payroll_work_earnings
          WHERE jurisdiction = 'cl' AND period_month >= ? AND period_month <= ?
          ORDER BY period_month, id`
      )
      .all(fromMonth, throughMonth) as {
      id: number;
      period_month: string;
      employer_name: string;
      earning_type: string;
      liquido_currency: string;
      total_haberes_clp: number | null;
      total_imponible_clp: number | null;
      total_no_imponible_clp: number | null;
      colacion_clp: number | null;
      movilizacion_clp: number | null;
      desc_afp_clp: number | null;
      desc_health_clp: number | null;
      desc_cesantia_clp: number | null;
      desc_tax_clp: number | null;
    }[]
  ).map((r) => ({
    payslipId: r.id,
    periodMonth: r.period_month,
    employer: r.employer_name,
    earningType: r.earning_type,
    liquidoCurrency: r.liquido_currency,
    totalHaberesClp: r.total_haberes_clp,
    totalImponibleClp: r.total_imponible_clp,
    totalNoImponibleClp: r.total_no_imponible_clp,
    colacionClp: r.colacion_clp,
    movilizacionClp: r.movilizacion_clp,
    descAfpClp: r.desc_afp_clp,
    descHealthClp: r.desc_health_clp,
    descCesantiaClp: r.desc_cesantia_clp,
    descTaxClp: r.desc_tax_clp,
  }));
}

export type PayStubLineFact = { side: string; kind: string | null; amount: number };

/** A US pay stub (`jurisdiction = 'us'`) and its printed lines, in dollars. */
export type UsPayStubFact = {
  payslipId: number;
  payDate: string;
  employer: string;
  sourcePdf: string;
  /** In printed order (`position`). */
  lines: PayStubLineFact[];
};

/** The US pay stubs paid in the window, by pay date then id (a stub without a pay date is never in a window). */
export function usPayStubFacts(window: DateWindow): UsPayStubFact[] {
  const heads = db
    .prepare(
      `SELECT id, pay_date, employer_name, source_pdf FROM payroll_work_earnings
        WHERE jurisdiction = 'us' AND pay_date >= ? AND pay_date <= ? ORDER BY pay_date, id`
    )
    .all(window.fromYmd, window.throughYmd) as { id: number; pay_date: string; employer_name: string; source_pdf: string }[];
  const lineStmt = db.prepare(`SELECT side, kind, amount FROM payslip_lines WHERE payslip_id = ? ORDER BY position`);
  return heads.map((h) => ({
    payslipId: h.id,
    payDate: h.pay_date,
    employer: h.employer_name,
    sourcePdf: h.source_pdf,
    lines: lineStmt.all(h.id) as PayStubLineFact[],
  }));
}

/** A boleta de honorarios the person issued (`sii_issued_fee_receipts`), in pesos. */
export type FeeReceiptFact = {
  number: number;
  issuedOn: string;
  payer: string;
  grossClp: number;
  retentionClp: number;
  /** Who paid the retention to the SII: the payer, or the issuer in his F29. */
  retainedBy: "payer" | "issuer";
};

/** The boletas issued in the window, by date then number. */
export function feeReceiptFacts(window: DateWindow): FeeReceiptFact[] {
  return (
    db
      .prepare(
        `SELECT number, issued_on, payer_name, gross_clp, retention_clp, retained_by FROM sii_issued_fee_receipts
          WHERE issued_on >= ? AND issued_on <= ? ORDER BY issued_on, number`
      )
      .all(window.fromYmd, window.throughYmd) as {
      number: number;
      issued_on: string;
      payer_name: string;
      gross_clp: number;
      retention_clp: number;
      retained_by: "payer" | "issuer";
    }[]
  ).map((r) => ({
    number: r.number,
    issuedOn: r.issued_on,
    payer: r.payer_name,
    grossClp: r.gross_clp,
    retentionClp: r.retention_clp,
    retainedBy: r.retained_by,
  }));
}
