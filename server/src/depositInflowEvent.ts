/** The dated capital flow the deposit timelines are made of (a leaf type; `accountDeposits.ts` re-exports it). */

/** Dated CLP flow toward cumulative “aportes” (positive = in, negative = out). */
export type DepositInflowEvent = {
  /** Display date: the movement's bank date, or Chile today when that date is still ahead. */
  occurred_on: string;
  /**
   * Bank posting date when it lies after Chile today. The event is already counted (dated
   * today) and moves to this date once the calendar reaches it — the same rule the ledger
   * balances apply (`displayLedgerCutoffYmd`), so value and flow legs always agree.
   */
  posted_on?: string;
  /** CLP amount for CLP display (wire CLP or reference CLP). */
  amt: number;
  /** Native USD when known (wire or USD-reference capital). */
  amt_usd?: number | null;
  /** A foreign cash event in another currency than the dollar: its own amount (signed like `amt`). */
  amt_native?: number | null;
  native_currency?: string | null;
  capital_kind?: "clp_wire" | "usd_reference";
};
