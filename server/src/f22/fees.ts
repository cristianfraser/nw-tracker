/**
 * Fees (art. 42 N°2, línea 2) for a year with no filed form: the boletas de honorarios issued
 * (`taxFacts/salaries.ts`' fee receipts) as the fees box — gross (547), presumed expenses (494: 30 %
 * of the gross, at most 15 UTA), an APV régimen B deposit declared in the box (770) when no employer
 * reported the year, the net (110) and the retention as a credit (198). The pension contributions the
 * SII charges on fees (900) are not drafted (`draft.ts` header).
 */
import type { DateWindow } from "../dateWindow.js";
import { PRESUMED_EXPENSES_CAP_UTA, PRESUMED_EXPENSES_RATE } from "../legalParameters.js";
import { feeReceiptFacts } from "../taxFacts/salaries.js";
import type { F22FeesBox } from "./types.js";

export type F22FeeReceipts = { receipts: number; grossClp: number; retentionClp: number };

/** The boletas de honorarios issued in the window (inside `incomeYear`): count, gross and retention. */
export function loadFeeReceipts(incomeYear: number, window: DateWindow): F22FeeReceipts {
  const receipts = feeReceiptFacts(window).filter((r) => r.issuedOn.startsWith(`${incomeYear}-`));
  return {
    receipts: receipts.length,
    grossClp: receipts.reduce((s, r) => s + r.grossClp, 0),
    retentionClp: receipts.reduce((s, r) => s + r.retentionClp, 0),
  };
}

/**
 * The fees box from the year's boletas: `apvClp` is the APV régimen B deposit the box may declare
 * (0 when an employer reported the year: it is then the employee's 765), capped at the box's net.
 */
export function feesBox(receipts: F22FeeReceipts, utaClp: number, apvClp: number): F22FeesBox {
  const presumed = Math.round(Math.min(PRESUMED_EXPENSES_RATE * receipts.grossClp, PRESUMED_EXPENSES_CAP_UTA * utaClp));
  const beforeApv = receipts.grossClp - presumed;
  const apv = Math.min(apvClp, beforeApv);
  return {
    receipts: receipts.receipts,
    grossClp: receipts.grossClp,
    presumedExpensesClp: presumed,
    apvClp: apv,
    netClp: beforeApv - apv,
    retentionClp: receipts.retentionClp,
  };
}

/** The box's codes, written into the draft's input. */
export function writeFeesBoxCodes(input: Record<number, number>, fees: F22FeesBox): void {
  input[547] = fees.grossClp;
  input[494] = fees.presumedExpensesClp;
  if (fees.apvClp > 0) input[770] = fees.apvClp;
  input[110] = fees.netClp;
  input[198] = fees.retentionClp;
}
