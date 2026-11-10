/**
 * Foreign-source income a Chilean tax resident declares in the F22 besides the foreign dividends
 * and share sales `f22Draft` already reads: a salary earned abroad, and the interest a foreign
 * broker pays. Chile taxes a resident on worldwide income (art. 3 LIR) and credits the tax paid
 * abroad (art. 41 A, with the Chile–US treaty from income year 2024, art. 23 of the treaty).
 *
 * Sources (read 2026-11-10): the SII's AT2026 Formulario 22 (`f22_at2026.pdf`,
 * sii.cl/ayudas/formularios) and its line-by-line instructions — the Suplemento's text per line,
 * `sii.cl/servicios_online/renta/2026/archivos/l<N>_instruccion.pdf` —, Circular N° 31 de 2021
 * (art. 41 A after Ley 21.210, the instructions every line delegates the credit to), the SII's
 * observation G08 (AT2026) and the Chile–US convention (`sii.cl/pagina/jurisprudencia/convenios/
 * chile_usa_ing.pdf`).
 *
 * **A US salary** (the `jurisdiction = 'us'` pay stubs) is an art. 42 N°1 income obtained abroad:
 *
 * - **Code 1030, línea 13** «Sueldos y otras rentas similares de fuente extranjera» (líneas 12 and
 *   13 of the AT2026 form; this module once named them 11 and 12). Instrucciones 13.3: «Cuando sean
 *   de FE, se deberán declarar en el código 1030 de esta línea, hayan soportado o no impuestos en el
 *   extranjero», and 161 = 1098 + 1030. **The amount is the Renta Neta of art. 41 A N°3: the gross
 *   pay less the US income tax, nothing else deducted.** Circular 31 §1.2.2.2.2 a) i): «las rentas
 *   líquidas percibidas del N° 1 del artículo 42 no admiten deducción de gasto alguno … salvo las
 *   cotizaciones obligatorias destinadas a la formación de los fondos de previsión y retiro y las
 *   cotizaciones que se destinen para financiar las prestaciones de salud, establecidas en la
 *   legislación chilena» — Social Security and Medicare are US contributions, not Chilean ones, so
 *   they are not deducted (until 2026-11-10 this module read them like the AFP and health of a
 *   Chilean payslip and took them off); the 401(k) deferral, the HSA and the health premiums are
 *   not deductible either and stay in. «Líquida» is net of the US income tax (the 1040's line 24,
 *   see the credit), which the incremento in 748 adds back.
 * - **Conversion: the dólar observado at the end of the year, no IPC reajuste.** Instrucciones
 *   13.3: «De tener aplicación el artículo 41 A de la LIR, las rentas de FE se convertirán a su
 *   equivalente en pesos chilenos conforme lo dispuesto en la letra a) del N° 7 de dicho
 *   artículo»; Circular 31 §1.3.2.2: the parity of the day the amounts were received, «salvo
 *   tratándose de contribuyentes no obligados a aplicar normas sobre corrección monetaria, en cuyo
 *   caso se aplicará la paridad cambiaria vigente al término del ejercicio respectivo» — a person
 *   keeps no books, so the year end; §1.2.2.2.1 b) i)–ii) says the same for the art. 42 incomes
 *   and the taxes on them, and annex 3 converts a June salary «según tipo de cambio vigente al
 *   término del ejercicio» with no reajuste. The dividends in 1104 already convert that way. Until
 *   2026-11-10 each stub converted at its pay day's observado and was reajustado to December. For
 *   an open year the latest observado stands in (`provisional`).
 * - **The credit** is the US federal income tax of the year: the 1040's line 24 (total tax, the
 *   filed return when one is stored, else the draft — v1 has no income but wages and a little bank
 *   interest, so all of it is read as the salary's: an assumption kept), converted at the same
 *   year-end rate (Circular 31 §1.2.2.2.1 b) ii)). FICA is not a creditable tax: the convention's
 *   art. 2(3)(a) covers «the Federal income taxes imposed by the Internal Revenue Code (but
 *   excluding social security taxes)». **Crédito Total Disponible = the tope individual only**
 *   (Circular 31 §1.2.2.2.2 a) ii) and footnote 22: for art. 42 N°1 incomes «solo se aplicará el
 *   tope individual», no tope global): the lesser of the tax and 35 % of the Renta Bruta
 *   ({@link FOREIGN_TAX_CREDIT_CAP}; the gross pay, which the W-2 states, so the 35/65 formula for
 *   a gross that cannot be proven is not needed). It is the incremento in **748, línea 14**
 *   (Instrucciones 14.2: «los contribuyentes que declaren rentas en el código 1104 de la línea 12 y
 *   código 1030 de la línea 13 del F-22 deben registrar el aludido incremento por IPE en el código
 *   748, para luego anotar con los límites establecidos en la ley el crédito por dicho concepto en
 *   el código 1018 de la línea 45») and the credit in **1018, línea 45** («Crédito al IUSC o IGC
 *   por impuestos soportados en el exterior, según arts. 41 A N°4 letra B) o N° 5 LIR»;
 *   Instrucciones 45.1 c): art. 42 N°1 incomes declared in 1030). No refund (45.1: «El remanente …
 *   no dará derecho a devolución o imputación a otros impuestos, ni podrá recuperarse en los años
 *   posteriores»): `computeF22Tax` caps it at the IGC on the Renta Imponible (1030 + its 748) by
 *   the one-decimal proportion of Circular 31 §1.2.2.2.1 b) (`f22ForeignSalaryCreditCap`), taken
 *   after every other credit («con posterioridad a cualquier otro crédito autorizado por la ley» —
 *   the chain's 304 is a sum, so the order changes nothing). Remaining assumptions: line 24 as the
 *   salary's whole tax; the April settlement's part of it converts at the same year-end rate.
 *
 * **Code 746 is not this credit.** Observation G08 names both because it covers both: 746 is
 * línea 49, «Crédito al IGC por impuestos soportados en el exterior, según art. 41 A N° 4 letra A)
 * letra b) LIR» — Instrucciones 49.1: the credit «asociado a los retiros y dividendos que
 * percibieron … en su calidad de propietarias de empresas domiciliadas o residentes en el país …
 * informado … mediante los Certificados Modelos N° 43, 44, 70 y 71», a Chilean company's
 * pass-through; a natural person's own foreign dividends go in 1104 with their credit in 1018
 * (Instrucciones 12.3: «El crédito por IPE a que dan derecho las rentas que se declaren en esta
 * línea … se deberá registrar como incremento en el código 748 de la línea 14 del F-22 y luego
 * trasladarse a la línea 45»; 45.1 a)). The chain subtracts a filed 746 in 304 (`f22Code304`) and
 * never drafts it.
 *
 * **A foreign broker's or a US bank's interest** (`savings_earnings` on the dollar cash of a broker
 * listed in {@link FOREIGN_BROKERS}: IBKR's sweep interest; or on a dollar account at a US bank,
 * `usBankAccounts.ts`) is «otras rentas de fuente extranjera» (línea 12, code 1104, with the
 * dividends). No US tax is withheld from a US resident's interest, so it carries no credit.
 * Converted like the dividends: at the 31-December observado.
 */
import { db } from "./db.js";
import { buildF1040Draft } from "./f1040Draft.js";
import { US_BANK_ISSUERS } from "./usBankAccounts.js";
import { filedF1040 } from "./f1040Filed.js";
import { CHILE_US_TREATY_FIRST_INCOME_YEAR, FOREIGN_TAX_CREDIT_CAP } from "./legalParameters.js";

/** Brokers domiciled abroad: the interest their cash earns is foreign-source (the `broker_cash` role's broker). */
export const FOREIGN_BROKERS: readonly string[] = ["ibkr"];

export type F22ForeignSalaryStub = {
  payDate: string;
  employer: string;
  /** Every haber of the stub: the Renta Bruta before the US tax. */
  grossUsd: number;
  /** Social Security and Medicare withheld — reported, not deductible (Circular 31 §1.2.2.2.2 a) i)). */
  ficaUsd: number;
  /** The year-end observado every stub converts at. */
  observado: number;
  /** grossUsd × observado. */
  incomeClp: number;
};

/** The year-end rate the salary and its tax convert at (art. 41 A N°7 letra a): the latest observado while the year is open. */
export type F22ForeignYearEnd = { observado: number; provisional: boolean };

export type F22ForeignSalary = {
  stubs: F22ForeignSalaryStub[];
  /** Σ gross pay, dollars (the Renta Bruta). */
  incomeUsd: number;
  /** The same in pesos at the year-end observado: the income before the US tax. */
  grossClp: number;
  /** The 1040's line 24 and where it came from. */
  usTaxUsd: number;
  usTaxSource: "filed" | "draft" | null;
  /** The US tax in pesos at the year-end observado. */
  usTaxClp: number;
  /** 1030: grossClp − usTaxClp (the Renta Neta). */
  netClp: number;
  /** min(US tax, 35 % of the gross): the Crédito Total Disponible before the IGC cap, and the incremento (748). */
  creditClp: number;
  /** The year is open: the latest observado stood in for the year end's. */
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

const cents = (x: number) => Math.round(x * 100) / 100;

/** The US salary of `incomeYear` for the F22 at the year-end rate, or zeros without US pay stubs. */
export function foreignSalaryForYear(incomeYear: number, todayYmd: string, yearEnd: F22ForeignYearEnd): F22ForeignSalary {
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
  if (!(yearEnd.observado > 0)) throw new Error(`F22 ${incomeYear}: no year-end dólar observado for the US salary`);
  const lineStmt = db.prepare(`SELECT side, kind, amount FROM payslip_lines WHERE payslip_id = ?`);
  const stubs = heads.map((h): F22ForeignSalaryStub => {
    if (h.pay_date == null) throw new Error(`F22 ${incomeYear}: US payslip ${h.source_pdf} has no pay date`);
    const lines = lineStmt.all(h.id) as { side: string; kind: string | null; amount: number }[];
    if (lines.length === 0) throw new Error(`F22 ${incomeYear}: US payslip ${h.source_pdf} has no lines`);
    const grossUsd = cents(lines.filter((l) => l.side === "haber").reduce((s, l) => s + l.amount, 0));
    const ficaUsd = cents(
      lines
        .filter((l) => l.side === "descuento" && (l.kind === "social_security_tax" || l.kind === "medicare_tax"))
        .reduce((s, l) => s + l.amount, 0)
    );
    return {
      payDate: h.pay_date,
      employer: h.employer_name,
      grossUsd,
      ficaUsd,
      observado: yearEnd.observado,
      incomeClp: grossUsd * yearEnd.observado,
    };
  });
  const incomeUsd = cents(stubs.reduce((s, x) => s + x.grossUsd, 0));
  const grossClp = Math.round(incomeUsd * yearEnd.observado);
  const filed = filedF1040(incomeYear);
  const usTaxUsd = filed ? (filed.lines["24"] ?? 0) : (buildF1040Draft(incomeYear, todayYmd).lines["24"] ?? 0);
  const usTaxClp = Math.round(usTaxUsd * yearEnd.observado);
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
    provisional: yearEnd.provisional,
  };
}

/** The interest the foreign brokers' dollar cash and the US bank accounts earned in `incomeYear`, at the year-end observado. */
export function foreignInterestForYear(incomeYear: number, yearEndObservado: number): F22ForeignInterest {
  const brokerMatch = FOREIGN_BROKERS.map(() => `r.param LIKE ?`).join(" OR ");
  const bankMatch = US_BANK_ISSUERS.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT m.id, m.account_id, m.occurred_on, m.amount, m.currency FROM movements m
        WHERE m.flow_kind = 'savings_earnings' AND m.occurred_on LIKE ?
          AND (m.account_id IN (SELECT r.account_id FROM account_roles r WHERE r.role = 'broker_cash' AND (${brokerMatch}))
               OR m.account_id IN (SELECT b.account_id FROM bank_account_numbers b WHERE b.currency = 'usd' AND b.issuer IN (${bankMatch})))
        ORDER BY m.occurred_on, m.id`
    )
    .all(`${incomeYear}-%`, ...FOREIGN_BROKERS.map((b) => `${b}|%`), ...US_BANK_ISSUERS) as {
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
