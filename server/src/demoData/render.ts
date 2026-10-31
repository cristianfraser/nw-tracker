/**
 * The documents the bank, the card issuer and the employers would issue, rendered from the life
 * ledger in the canonical ingest shapes (`server/contracts`):
 *
 * - monthly cartolas (cuenta vista, cuenta corriente) → `bank_account.statements`;
 * - this month's «últimos movimientos» listing of the cuenta corriente → `bank_account.movements`;
 * - every closed facturación, pesos and dollars → `card.parsed_statements` rows (the statement
 *   parser's columns), and the open cycle as the card feed would list it;
 * - liquidaciones → `employment.payslips`, with the month's Previred parameters → `payroll.parameters`.
 */
import type {
  BankAccountMovementsPayload,
  BankAccountStatement,
  BankAccountStatementsPayload,
  EmploymentPayslipsPayload,
  PayrollParametersPayload,
} from "nw-tracker-contracts";
import { CARD_PARSED_STATEMENT_COLUMNS } from "nw-tracker-contracts";
import type { CcStatementCsvRecord } from "../ccStatementsImport.js";
import type { CcWebPasteParseResult } from "../ccWebPasteParse.js";
import { webPasteAmountFromDebtPositive } from "../ccPaymentLines.js";
import type { MarketReader } from "./market.js";
import { addMonths, daysInMonth, MONTH_NAMES_ES, monthOf, type CardDef, type Month, type Ymd, ymd } from "./person.js";
import { afpWorkerRate, BRANCH, type BankRow, type CardStatement, type Ledger } from "./simulate.js";

function ddmmyyyy(day: Ymd): string {
  return `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
}
function usd(n: number): string {
  return n.toFixed(2).replace(".", ",");
}

/* --------------------------------- cartolas -------------------------------------- */

export type RenderedCartolas = {
  statements: BankAccountStatementsPayload[];
  /** Rows of the current (open) month, for the daily listing. */
  currentMonth: BankRow[];
};

export const DEMO_CHECKING_NUMBER = "0071234567";

/** One cartola per calendar month from the account's first row through last month. */
export function renderCartolas(ledger: Ledger): RenderedCartolas {
  const current = monthOf(ledger.today);
  const out: BankAccountStatementsPayload[] = [];
  const currentMonth: BankRow[] = [];
  for (const account of ["vista", "checking"] as const) {
    const rows = ledger.bank.filter((r) => r.account === account).sort((a, b) => a.date.localeCompare(b.date));
    if (rows.length === 0) continue;
    const statements: BankAccountStatement[] = [];
    let balance = 0;
    let doc = 1;
    for (let m = monthOf(rows[0]!.date); m < current; m = addMonths(m, 1)) {
      const mine = rows.filter((r) => monthOf(r.date) === m);
      const opening = balance;
      for (const r of mine) balance += r.amount;
      statements.push({
        document: `cartola-${account === "vista" ? "cuenta-vista" : "cuenta-corriente"}-${m}.pdf`,
        period_month: m,
        period_from: `${m}-01`,
        period_to: ymd(m, daysInMonth(m)),
        opening_balance: opening,
        closing_balance: balance,
        month_closing_balances: null,
        movements: mine.map((r) => ({
          date: r.date,
          branch: BRANCH,
          description: r.description,
          document_no: String(doc++).padStart(9, "0"),
          amount: r.amount,
        })),
        skipped_rows: [],
        notes: [],
      });
    }
    if (account === "checking") currentMonth.push(...rows.filter((r) => monthOf(r.date) === current));
    out.push({
      account: { issuer: "santander", product: account === "vista" ? "demand_deposit" : "checking" },
      apply: true,
      force_reimport: false,
      statements,
      unreadable: [],
    });
  }
  return { statements: out, currentMonth };
}

export function renderCurrentMonthListing(rows: BankRow[]): BankAccountMovementsPayload | null {
  if (rows.length === 0) return null;
  return {
    account: { issuer: "santander", product: "checking", currency: "clp", number: DEMO_CHECKING_NUMBER },
    movements: rows.map((r, i) => ({
      date: r.date,
      description: r.description,
      currency: "clp" as const,
      amount: r.amount,
      document_no: String(900_000 + i),
      wire_reference: null,
    })),
    rejected_rows: [],
  };
}

/* ------------------------------ card statements ---------------------------------- */

function emptyRecord(): CcStatementCsvRecord {
  return Object.fromEntries(CARD_PARSED_STATEMENT_COLUMNS.map((c) => [c, ""])) as CcStatementCsvRecord;
}

/** Every closed facturación as the statement parser would print its lines. */
export function renderCardStatementRecords(ledger: Ledger): CcStatementCsvRecord[] {
  const out: CcStatementCsvRecord[] = [];
  for (const s of ledger.statements) out.push(...statementRecords(s, ledger.person.cards));
  return out;
}

function statementRecords(s: CardStatement, cards: readonly CardDef[]): CcStatementCsvRecord[] {
  const card = cards.find((c) => c.key === s.card)!;
  const clp = s.currency === "clp";
  const source = `import:demo-statement|${card.last4}|${s.currency}|${s.close}`;
  const header = (): CcStatementCsvRecord => {
    const r = emptyRecord();
    r.card_group = "A";
    r.source_pdf = source;
    r.statement_date = ddmmyyyy(s.close);
    r.period_from = ddmmyyyy(s.periodFrom);
    r.period_to = ddmmyyyy(s.close);
    r.pay_by = ddmmyyyy(s.payBy);
    r.card_last4 = card.last4;
    r.card_product = card.displayName;
    r.parser_layout = clp ? "compact" : "international_usd";
    r.currency = s.currency;
    const fmt = (n: number) => (clp ? String(Math.round(n)) : usd(n));
    r.statement_saldo_anterior = fmt(s.saldoAnterior);
    r.statement_compras_cargos = fmt(s.facturado);
    r.statement_monto_facturado = fmt(s.facturado);
    r.pdf_total_operaciones = clp ? fmt(s.facturado) : "";
    if (clp) {
      r.statement_deuda_total = fmt(s.facturado);
      r.statement_abono = s.paidPrevious ? fmt(s.paidPrevious) : "0";
      r.statement_monto_facturado_anterior = fmt(s.saldoAnterior);
      if (s.paidPrevious > 0 && s.paidPreviousDate) {
        r.statement_monto_pagado_anterior = fmt(s.paidPrevious);
        r.statement_monto_pagado_anterior_date = s.paidPreviousDate;
      }
    } else {
      r.statement_abono = fmt(-s.paidPrevious);
      r.statement_deuda_total = fmt(s.saldoAnterior - s.paidPrevious + s.facturado);
    }
    r.statement_next_period_from = ddmmyyyy(s.close);
    r.statement_next_period_to = ddmmyyyy(s.nextClose);
    return r;
  };
  const rows: CcStatementCsvRecord[] = [];
  let i = 0;
  const id = () => `demo|${card.last4}|${s.currency}|${s.close}|${i++}`;
  for (const l of s.lines) {
    const r = header();
    r.transaction_date = ddmmyyyy(l.date);
    r.merchant = l.merchant;
    r.description_merged = l.merchant;
    r.raw_line = `${ddmmyyyy(l.date)} ${l.merchant}`;
    r.installment_flag = "false";
    if (clp) r.amount_clp = String(Math.round(l.amount));
    else r.amount_usd = usd(l.amount);
    r.row_id = r.dedupe_key = r.canonical_row_id = id();
    rows.push(r);
  }
  for (const c of s.cuotas) {
    const r = header();
    r.transaction_date = ddmmyyyy(c.plan.purchaseDate);
    r.merchant = c.plan.merchant;
    r.description_merged = c.plan.merchant;
    r.raw_line = `${ddmmyyyy(c.plan.purchaseDate)} ${c.plan.merchant} ${String(c.n).padStart(2, "0")}/${String(c.plan.cuotas).padStart(2, "0")}`;
    r.installment_flag = "true";
    r.amount_clp = String(c.plan.cuotaClp);
    r.nro_cuota_current = String(c.n);
    r.nro_cuota_total = String(c.plan.cuotas);
    r.valor_cuota_mensual_clp = String(c.plan.cuotaClp);
    r.monto_origen_operacion_clp = String(c.plan.totalClp);
    r.monto_total_a_pagar_clp = String(c.plan.totalClp);
    r.interest_rate_text = "0,00%";
    r.tipo_cuota = "CUOTA COMERCIO";
    r.row_id = r.dedupe_key = id();
    r.canonical_row_id = `demo|plan|${c.plan.id}`;
    rows.push(r);
  }
  if (!clp && s.paidPrevious > 0 && s.paidPreviousDate) {
    const r = header();
    const label = s.paidPreviousViaDivisas ? "ABONO DE DIVISAS" : "MONTO CANCELADO";
    r.transaction_date = ddmmyyyy(s.paidPreviousDate);
    r.merchant = label;
    r.description_merged = label;
    r.raw_line = `${ddmmyyyy(s.paidPreviousDate)} ${label}`;
    r.installment_flag = "false";
    r.amount_usd = usd(-s.paidPrevious);
    r.row_id = r.dedupe_key = r.canonical_row_id = id();
    rows.push(r);
  }
  if (rows.length === 0) throw new Error(`demo: statement ${source} has no lines`);
  return rows;
}

/** The open cycle (after the last close) as the card feed lists it, per card. */
export function renderOpenCycle(ledger: Ledger): { card: CardDef; listing: CcWebPasteParseResult }[] {
  return ledger.openCycle
    .map((o) => {
      const card = ledger.person.cards.find((c) => c.key === o.card)!;
      const lines: CcWebPasteParseResult["lines"] = o.lines.map((l) => {
        const pasted = webPasteAmountFromDebtPositive(l.amount, card.issuer);
        return {
          transaction_date: l.date,
          merchant: l.merchant,
          amount_clp: l.currency === "clp" ? pasted : 0,
          amount_usd: l.currency === "usd" ? pasted : null,
          currency: l.currency,
          raw_line: `${l.date} ${l.merchant}`,
        };
      });
      if (o.payment) {
        if (o.payment.clp > 0)
          lines.push({ transaction_date: o.payment.date, merchant: "PAGO", amount_clp: webPasteAmountFromDebtPositive(-o.payment.clp, card.issuer), amount_usd: null, currency: "clp", raw_line: "PAGO" });
        if (o.payment.usd > 0)
          lines.push({
            transaction_date: o.payment.date,
            merchant: o.payment.usdViaDivisas ? "ABONO DE DIVISAS" : "MONTO CANCELADO",
            amount_clp: 0,
            amount_usd: webPasteAmountFromDebtPositive(-o.payment.usd, card.issuer),
            currency: "usd",
            raw_line: o.payment.usdViaDivisas ? "ABONO DE DIVISAS" : "MONTO CANCELADO",
          });
      }
      return { card, listing: { lines, errors: [] } };
    })
    .filter((o) => o.listing.lines.length > 0);
}

/* --------------------------------- payroll --------------------------------------- */

export function renderPayslips(ledger: Ledger): EmploymentPayslipsPayload | null {
  if (ledger.payslips.length === 0) return null;
  return {
    apply: true,
    parser_version: "demo",
    payslips: ledger.payslips.map((p) => {
      const sum = (side: "haber" | "descuento", section?: string) =>
        p.lines.filter((l) => l.side === side && (section == null || l.section === section)).reduce((a, l) => a + l.amount, 0);
      const by = (label: string) => p.lines.find((l) => l.label === label)?.amount ?? null;
      const haberes = sum("haber");
      const descuentos = sum("descuento");
      const [y, mo] = p.month.split("-").map(Number) as [number, number];
      return {
        document: `liquidaciones/${p.job.id}/${p.month}${p.kind === "severance" ? "-finiquito" : ""}.pdf`,
        period_month: p.month,
        employer: { name: p.job.employer, rut: p.job.employerRut },
        pay_period_label: `${MONTH_NAMES_ES[mo - 1]} ${y}`,
        kind: p.kind,
        pension_fund: p.pensionFund,
        earnings: {
          base_salary: by("Sueldo base"),
          meal_allowance: by("Colación"),
          transport_allowance: by("Movilización"),
          bonus: by("Bono"),
          taxable_total: p.kind === "salary" ? sum("haber", "imponible") : null,
          non_taxable_total: sum("haber", "no_imponible"),
          total: haberes,
        },
        deductions: {
          pension: p.pension || null,
          health: p.health || null,
          income_tax: p.kind === "salary" ? p.tax : null,
          unemployment_insurance: p.afc || null,
          voluntary_pension: null,
          other: null,
          total: descuentos,
        },
        net_pay: haberes - descuentos,
        lines: p.lines.map((l, i) => ({ position: i, side: l.side, section: l.section, label: l.label, amount: l.amount })),
        indices: { uf: p.uf, utm: p.utm, pension_cap_uf: null, unemployment_cap_uf: null },
      };
    }),
  };
}

/** Previred's monthly indicators for every month a liquidación prints. */
export function renderPayrollParameters(ledger: Ledger, market: MarketReader): PayrollParametersPayload | null {
  const months = [...new Set(ledger.payslips.filter((p) => p.kind === "salary").map((p) => p.month))].sort();
  if (months.length === 0) return null;
  return {
    months: months.map((m: Month) => {
      const year = Number(m.slice(0, 4));
      const caps: Record<number, number> = { 2018: 78.3, 2019: 79.2, 2020: 80.2, 2021: 81.6, 2022: 81.6 };
      const cap = caps[year] ?? 81.6;
      return {
        period_month: m,
        document: `previred-indicadores/${m}.pdf`,
        uf: market.uf(ymd(m, daysInMonth(m))),
        utm: market.utm(m),
        pension_cap_uf: cap,
        unemployment_cap_uf: Math.round(cap * 1.5 * 10) / 10,
        afp_worker_rates: {
          modelo: afpWorkerRate("modelo", m),
          uno: afpWorkerRate("uno", m),
          habitat: 11.27,
          capital: 11.44,
          cuprum: 11.44,
          planvital: 11.16,
          provida: 11.45,
        },
        afp_employer_rate: m >= "2025-08" ? 0.1 : 0,
        afc_worker_rate: 0.6,
        afc_employer_rate: 2.4,
      };
    }),
  };
}
