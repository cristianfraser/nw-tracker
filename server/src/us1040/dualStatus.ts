/**
 * The dual-status year (Pub. 519 ch. 6; docs/us-1040-readings.md §1): a person who becomes a US
 * resident during the year and is one at its end files a Form 1040 marked «Dual-Status Return» for
 * the resident part, with a statement (Form 1040-NR used as one, «Dual-Status Statement») for the
 * nonresident part. Pure.
 *
 * - **Resident part**: worldwide income received or realized from the residency starting day (the
 *   1040's own lines; `draft.ts` reads every fact in that window). Foreign-source income received
 *   before it «is not taxable if you receive it while a nonresident»; foreign gains realized before
 *   it are out. US-source wages of either part are taxed at graduated rates on the 1040 (the demo's
 *   stubs all fall after the day).
 * - **No standard deduction**: «You cannot use the standard deduction allowed on Form 1040»
 *   (Pub. 519); line 12 / 12e is 0 and the 2025 form's box 12c is checked. Itemized deductions are
 *   allowed but none is on file (Texas has no income tax; foreign real-property taxes are not an
 *   itemized deduction, §164(b)(6)) — the itemized total is stated as 0.
 * - **Nonresident statement**: US-source FDAP of the nonresident part — the US dividends paid before
 *   the day — taxed «at the flat 30% rate or lower treaty rate», with no deductions. The rate is the
 *   one in force on each pay day (`usDividendWithholdingRateForChileanResident`: 30 % before
 *   2024-02-01, the convention's 15 % from then); the tax withheld on them (Form 1042-S) is a payment.
 *   US bank deposit interest of a nonresident is not US-source FDAP taxed at 30 % (§871(i)(2)(A)) and
 *   stays off the statement.
 *
 * Where the statement's tax goes on the 1040: {@link DUAL_STATUS_STATEMENT_TAX_LINE} (line 16, added
 * to the tax on line 15). The readings did not quote the line; the alternative would be Schedule 2
 * «other taxes». Its withholding goes to line 25c with every Form 1042-S.
 */
import type { YearResidency } from "../taxResidency.js";

/** The 1040 line the nonresident statement's tax is added to (reading not quoted in the sources read; alternative: Schedule 2). */
export const DUAL_STATUS_STATEMENT_TAX_LINE = "16";

export type UsResidencyKind = "full" | "dual_status" | "nonresident" | "undeclared";

export type UsResidencyOfYear = {
  kind: UsResidencyKind;
  /** The residency starting day of a dual-status year; null otherwise. */
  from: string | null;
};

/** How the US treats the person in `incomeYear`, from R1's declared residency. */
export function usResidencyOfYear(r: YearResidency): UsResidencyOfYear {
  if (!r.declared) return { kind: "undeclared", from: null };
  if (r.us === "full") return { kind: "full", from: null };
  if (r.us === "none") return { kind: "nonresident", from: null };
  return { kind: "dual_status", from: r.us.from };
}

export type DualStatusDividendItem = {
  date: string;
  movementId: number;
  instrument: string;
  grossUsd: number;
  /** US tax withheld (Form 1042-S), dollars. */
  withheldUsd: number;
};

export type DualStatusStatementRow = DualStatusDividendItem & { ratePct: number; taxUsd: number };

export type DualStatusStatement = {
  from: string;
  rows: DualStatusStatementRow[];
  grossUsd: number;
  /** The statement's tax, whole dollars. */
  tax: number;
  /** Withheld on those dividends, whole dollars (line 25c). */
  withheld: number;
};

/** The nonresident statement of the part before `from`, from its US-source dividends. */
export function dualStatusStatement(from: string, items: readonly DualStatusDividendItem[], rateOn: (payDay: string) => number): DualStatusStatement {
  const rows = items.map((i): DualStatusStatementRow => {
    if (i.date >= from) throw new Error(`Dual-status statement: dividend ${i.movementId} on ${i.date} is not before ${from}`);
    if (i.grossUsd < 0 || i.withheldUsd < 0) throw new Error(`Dual-status statement: dividend ${i.movementId} has a negative amount`);
    const rate = rateOn(i.date);
    return { ...i, ratePct: rate * 100, taxUsd: Math.round(i.grossUsd * rate * 100) / 100 };
  });
  return {
    from,
    rows,
    grossUsd: Math.round(rows.reduce((s, r) => s + r.grossUsd, 0) * 100) / 100,
    tax: Math.round(rows.reduce((s, r) => s + r.taxUsd, 0)),
    withheld: Math.round(rows.reduce((s, r) => s + r.withheldUsd, 0)),
  };
}
