/**
 * Foreign-source income a Chilean tax resident declares in the F22 besides the foreign dividends
 * and share sales `f22Draft` already reads: a salary earned abroad, and the interest a foreign
 * broker pays. Chile taxes a resident on worldwide income (art. 3 LIR) and credits the tax paid
 * abroad (art. 41 A, with the Chile–US treaty from income year 2024, art. 23 of the treaty).
 *
 * **A US salary** (the `jurisdiction = 'us'` pay stubs) is an art. 42 N°1 income obtained abroad:
 *
 * - **Code 1030**, línea 12 «Sueldos y otras rentas similares de fuente extranjera» (the AT2023 form
 *   prints it beside 1098; observation G08 of AT2026 still names 1030 with 748 and 1018). Línea 12's
 *   total, 161, is then 1098 + 1030. The income is the stub's gross pay less the US social-security
 *   contributions withheld (Social Security and Medicare: compulsory contributions, read like the
 *   Chilean «leyes sociales» an art. 42 N°1 base excludes — this module's reading; the 401(k),
 *   HSA and the health premiums are voluntary or cafeteria choices and stay in), less the US income
 *   tax, as art. 41 A declares a foreign income net of the tax it bore. Each stub converts at the
 *   dólar observado of its pay date and is reajustado to December by the SII's one-decimal IPC (as
 *   the rents are, `f22Rentals`) — confidence: medium; the Suplemento's conversion rule for art.
 *   41 A incomes is «la fecha de percepción».
 * - **The credit** is the US federal income tax of the year: the 1040's line 24 (total tax, the
 *   filed return when one is stored, else the draft — v1 has no income but wages, so all of it is
 *   on the salary), converted at the salary's own average rate (each stub's withholding was paid on
 *   its day; the April settlement takes the same weight — a simplification). Art. 41 A caps it
 *   individually at 35 % of the gross foreign income (net + tax, {@link FOREIGN_TAX_CREDIT_CAP});
 *   the credited amount is the gross-up (incremento, code 748, línea 14, beside the dividends') and
 *   the credit itself is code 1018 (línea 43, «Crédito al IUSC o IGC por impuestos soportados en el
 *   exterior, según art. 41 A N°4 letra B) o N°5»). The credit has no refund: `computeF22Tax` caps
 *   it at the IGC proportional to this income (157 × (1030 + its 748) / 158); what the cap leaves
 *   is lost (confidence: medium — the Suplemento's «crédito total disponible» worksheet is not
 *   reproduced line by line).
 *
 * **A foreign broker's interest** (`savings_earnings` on the dollar cash of a broker listed in
 * {@link FOREIGN_BROKERS}: IBKR's sweep interest) is «otras rentas de fuente extranjera» (línea 11,
 * code 1104, with the dividends). No US tax is withheld from a US resident's interest, so it carries
 * no credit. Converted like the dividends: at the 31-December observado.
 */
import { db } from "./db.js";
import { buildF1040Draft } from "./f1040Draft.js";
import { filedF1040 } from "./f1040Filed.js";
import { CHILE_US_TREATY_FIRST_INCOME_YEAR, FOREIGN_TAX_CREDIT_CAP } from "./legalParameters.js";
import { ipcReajuste, monthBeforeYmd } from "./siiOfficialIpc.js";
import { observadoOnOrBefore } from "./usdCashTaxLotEvents.js";

/** Brokers domiciled abroad: the interest their cash earns is foreign-source (the `broker_cash` role's broker). */
export const FOREIGN_BROKERS: readonly string[] = ["ibkr"];

export type F22ForeignSalaryStub = {
  payDate: string;
  employer: string;
  grossUsd: number;
  ficaUsd: number;
  observado: number;
  /** (gross − FICA) × observado, reajustado to December. */
  incomeClp: number;
};

export type F22ForeignSalary = {
  stubs: F22ForeignSalaryStub[];
  /** Σ (gross − FICA), dollars. */
  incomeUsd: number;
  /** Σ (gross − FICA) in pesos, reajustado: the income before the US tax. */
  grossClp: number;
  /** The 1040's line 24 and where it came from. */
  usTaxUsd: number;
  usTaxSource: "filed" | "draft" | null;
  /** The US tax in pesos at the salary's average rate. */
  usTaxClp: number;
  /** 1030: grossClp − usTaxClp. */
  netClp: number;
  /** min(US tax, 35 % of the gross): the credit before the IGC cap, and the incremento (748). */
  creditClp: number;
  /** The December reajuste used the latest published month (open year). */
  provisional: boolean;
};

export type F22ForeignInterestLine = { date: string; movementId: number; accountId: number; usd: number };

export type F22ForeignInterest = { lines: F22ForeignInterestLine[]; usd: number; clp: number };

const EMPTY_SALARY: F22ForeignSalary = {
  stubs: [],
  incomeUsd: 0,
  grossClp: 0,
  usTaxUsd: 0,
  usTaxSource: null,
  usTaxClp: 0,
  netClp: 0,
  creditClp: 0,
  provisional: false,
};

type StubRow = { id: number; pay_date: string | null; employer_name: string; source_pdf: string };

/** The US salary of `incomeYear` for the F22, or zeros without US pay stubs. */
export function foreignSalaryForYear(incomeYear: number, todayYmd: string): F22ForeignSalary {
  const heads = db
    .prepare(
      `SELECT id, pay_date, employer_name, source_pdf FROM payroll_work_earnings
        WHERE jurisdiction = 'us' AND pay_date LIKE ? ORDER BY pay_date, id`
    )
    .all(`${incomeYear}-%`) as StubRow[];
  if (heads.length === 0) return EMPTY_SALARY;
  if (incomeYear < CHILE_US_TREATY_FIRST_INCOME_YEAR) {
    throw new Error(`F22 ${incomeYear}: a US salary before the Chile–US treaty applies (${CHILE_US_TREATY_FIRST_INCOME_YEAR}) — not modelled`);
  }
  const lineStmt = db.prepare(`SELECT side, kind, amount FROM payslip_lines WHERE payslip_id = ?`);
  const ipc = ipcReajuste({ round: true, floorAtZero: true });
  const { toMonth, provisional } = ipc.december(incomeYear);
  const stubs = heads.map((h): F22ForeignSalaryStub => {
    if (h.pay_date == null) throw new Error(`F22 ${incomeYear}: US payslip ${h.source_pdf} has no pay date`);
    const lines = lineStmt.all(h.id) as { side: string; kind: string | null; amount: number }[];
    if (lines.length === 0) throw new Error(`F22 ${incomeYear}: US payslip ${h.source_pdf} has no lines`);
    const grossUsd = lines.filter((l) => l.side === "haber").reduce((s, l) => s + l.amount, 0);
    const ficaUsd = lines
      .filter((l) => l.side === "descuento" && (l.kind === "social_security_tax" || l.kind === "medicare_tax"))
      .reduce((s, l) => s + l.amount, 0);
    const observado = observadoOnOrBefore(h.pay_date);
    const incomeClp = (grossUsd - ficaUsd) * observado * (1 + ipc.pct(monthBeforeYmd(h.pay_date), toMonth) / 100);
    return { payDate: h.pay_date, employer: h.employer_name, grossUsd, ficaUsd, observado, incomeClp };
  });
  const incomeUsd = Math.round(stubs.reduce((s, x) => s + x.grossUsd - x.ficaUsd, 0) * 100) / 100;
  const grossClp = Math.round(stubs.reduce((s, x) => s + x.incomeClp, 0));
  const filed = filedF1040(incomeYear);
  const usTaxUsd = filed ? (filed.lines["24"] ?? 0) : (buildF1040Draft(incomeYear, todayYmd).lines["24"] ?? 0);
  const usTaxClp = incomeUsd > 0 ? Math.round((usTaxUsd * grossClp) / incomeUsd) : 0;
  const creditClp = Math.round(Math.min(usTaxClp, FOREIGN_TAX_CREDIT_CAP * grossClp));
  return {
    stubs,
    incomeUsd,
    grossClp,
    usTaxUsd,
    usTaxSource: filed ? "filed" : "draft",
    usTaxClp,
    netClp: grossClp - usTaxClp,
    creditClp,
    provisional,
  };
}

/** The interest the foreign brokers' dollar cash earned in `incomeYear`, at the year-end observado. */
export function foreignInterestForYear(incomeYear: number, yearEndObservado: number): F22ForeignInterest {
  const brokerMatch = FOREIGN_BROKERS.map(() => `r.param LIKE ?`).join(" OR ");
  const rows = db
    .prepare(
      `SELECT m.id, m.account_id, m.occurred_on, m.amount, m.currency FROM movements m
        WHERE m.flow_kind = 'savings_earnings' AND m.occurred_on LIKE ?
          AND m.account_id IN (SELECT r.account_id FROM account_roles r WHERE r.role = 'broker_cash' AND (${brokerMatch}))
        ORDER BY m.occurred_on, m.id`
    )
    .all(`${incomeYear}-%`, ...FOREIGN_BROKERS.map((b) => `${b}|%`)) as {
    id: number;
    account_id: number;
    occurred_on: string;
    amount: number;
    currency: string;
  }[];
  const lines = rows.map((r): F22ForeignInterestLine => {
    if (r.currency !== "usd") throw new Error(`F22 ${incomeYear}: foreign interest movement ${r.id} is in ${r.currency}, expected dollars`);
    return { date: r.occurred_on, movementId: r.id, accountId: r.account_id, usd: r.amount };
  });
  const usd = Math.round(lines.reduce((s, l) => s + l.usd, 0) * 100) / 100;
  return { lines, usd, clp: Math.round(usd * yearEndObservado) };
}
