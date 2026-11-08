/**
 * The match windows: one row per relation between two records that one matcher pairs, with how far
 * apart in time the two may be and how their money must agree. A matcher imports its row from here
 * instead of carrying its own day literal, so every window that decides a pairing reads in one place.
 *
 * Convention: a window is read from the ANCHOR record (the one the matcher walks, named per row) to
 * the CANDIDATE record — `daysBefore` days the candidate may precede the anchor, `daysAfter` days it
 * may follow it, both inclusive. A symmetric window has the same number on both sides. `unit` is
 * `"days"` unless the row is counted in calendar months.
 *
 * Nothing here is a heuristic of its own: each number is what its matcher used before the table
 * existed (`tests` pin the table against the rows' former literals).
 */

export type AmountRule =
  /** Same pesos / dollars to the unit the matcher compares at. */
  | "exact"
  /** Same pesos, with a tolerance in percent (`toleranceFraction`). */
  | "tolerance"
  /** Cross-currency: an implied rate inside a sanity band instead of equality. */
  | "fx_band"
  /** Sums of several records equal the figure (one record is paid by several). */
  | "sum"
  /** The relation does not look at money. */
  | "none";

export type MatchWindow = {
  /** What the matcher walks (the anchor) and what it looks for (the candidate), in words. */
  anchor: string;
  candidate: string;
  daysBefore: number;
  daysAfter: number;
  unit: "days" | "months";
  amount: AmountRule;
  /** For `amount: "tolerance"`: the largest relative difference that still agrees. */
  toleranceFraction?: number;
  note?: string;
};

const sym = (days: number) => ({ daysBefore: days, daysAfter: days });

export const MATCH_WINDOWS = {
  // ── card line evidence (one statement or listing replaces another's line) ──────────────────────
  statement_bucket_line: {
    anchor: "web-paste bucket line",
    candidate: "statement line",
    ...sym(1),
    unit: "days",
    amount: "exact",
    note: "merchant also has to match; the bucket line may be dated a day off the statement's",
  },
  truncated_merchant: {
    anchor: "fuller listing",
    candidate: "listing cut at the web table's width",
    ...sym(4),
    unit: "days",
    amount: "exact",
    note: "the settled row may be restated a few days after the authorization",
  },
  pending_authorization: {
    anchor: "settled row",
    candidate: "pending authorization under a shorter name",
    ...sym(0),
    unit: "days",
    amount: "exact",
    note: "the feed keeps the date when it settles",
  },
  feed_mirror: {
    anchor: "card feed row",
    candidate: "bucket line the feed no longer lists",
    ...sym(4),
    unit: "days",
    amount: "exact",
  },
  planted_payment: {
    anchor: "planted payment line",
    candidate: "the bank's own payment line",
    daysBefore: 0,
    daysAfter: 5,
    unit: "days",
    amount: "exact",
  },
  recurring_pending: {
    anchor: "pending listing under the entry's first name",
    candidate: "posted line under another of its names",
    daysBefore: 0,
    daysAfter: 7,
    unit: "days",
    amount: "tolerance",
    note: "the posted pesos must fit the entry (UF of the posted day)",
  },
  manual_statement_plan: {
    anchor: "hand-entered installment plan",
    candidate: "statement line of the same purchase",
    ...sym(2),
    unit: "days",
    amount: "exact",
    note: "merchant, contract amount and cuota count have to agree as well",
  },

  // ── card payments and financing ────────────────────────────────────────────────────────────────
  payment_mirror: {
    anchor: "checking debit",
    candidate: "card payment evidence",
    ...sym(4),
    unit: "days",
    amount: "exact",
    note: "a divisas debit pairs against dollar evidence inside an implied-rate band instead (`fx_band`)",
  },
  financing_payment: {
    anchor: "installment purchases paid on one day",
    candidate: "payment line on the paid card",
    daysBefore: 3,
    daysAfter: 5,
    unit: "days",
    amount: "sum",
  },
  financing_pay_by_grace: {
    anchor: "closed facturado's pay-by",
    candidate: "installment purchases that financed it",
    daysBefore: 0,
    daysAfter: 10,
    unit: "days",
    amount: "sum",
    note: "purchases must also be dated after the facturado's close",
  },

  // ── own-account transfers and deposits ─────────────────────────────────────────────────────────
  internal_transfer_legs: {
    anchor: "deposit",
    candidate: "redemption of another account",
    ...sym(7),
    unit: "days",
    amount: "exact",
    note: "settlement/booking lag between the two legs of an internal net-worth transfer",
  },
  mirror_pair: {
    anchor: "outflow",
    candidate: "inflow of another account",
    ...sym(5),
    unit: "days",
    amount: "exact",
  },
  mirror_month_precision_boundary: {
    anchor: "month-precision leg",
    candidate: "real-day leg across the month boundary",
    ...sym(7),
    unit: "days",
    amount: "exact",
  },
  deposit_outflow: {
    anchor: "deposit",
    candidate: "checking outflow",
    ...sym(3),
    unit: "days",
    amount: "exact",
  },
  net_worth_capital_return: {
    anchor: "withdrawal",
    candidate: "returning credit",
    daysBefore: 0,
    daysAfter: 14,
    unit: "days",
    amount: "exact",
  },
  afp_retiro_return: {
    anchor: "AFP retiro ledger row",
    candidate: "checking credit",
    ...sym(31),
    unit: "days",
    amount: "exact",
  },
  splittable_internal_transfer: {
    anchor: "deposit",
    candidate: "checking outflow split across deposits",
    ...sym(8),
    unit: "days",
    amount: "exact",
  },
  dap_abono: {
    anchor: "DAP deposit",
    candidate: "abono",
    daysBefore: 0,
    daysAfter: 365,
    unit: "days",
    amount: "exact",
  },
  manual_deposit_assertion: {
    anchor: "manually marked deposits outflow",
    candidate: "deposit",
    ...sym(14),
    unit: "days",
    amount: "exact",
    note: "the user's assertion that a deposit exists widens the automatic window",
  },
  transfer_notice: {
    anchor: "mail's day",
    candidate: "bank row",
    daysBefore: 0,
    daysAfter: 6,
    unit: "days",
    amount: "exact",
  },
  transfer_notice_movement_max_age: {
    anchor: "today",
    candidate: "mail-written movement still waiting for its bank row",
    daysBefore: 3,
    daysAfter: 0,
    unit: "days",
    amount: "none",
  },
  incoming_wire_notices: {
    anchor: "notice",
    candidate: "notice of the same wire",
    ...sym(2),
    unit: "days",
    amount: "exact",
  },
  incoming_wire_request: {
    anchor: "withdrawal request's pay day",
    candidate: "wire into the destination account",
    daysBefore: 0,
    daysAfter: 7,
    unit: "days",
    amount: "exact",
  },
  incoming_wire_existing_transfer: {
    anchor: "wire's value date",
    candidate: "hand-entered transfer",
    ...sym(5),
    unit: "days",
    amount: "exact",
  },

  // ── mortgage ───────────────────────────────────────────────────────────────────────────────────
  mortgage_cuota_card_line: {
    anchor: "ledger cuota's payment day",
    candidate: "card line",
    daysBefore: 0,
    daysAfter: 3,
    unit: "days",
    amount: "exact",
  },
  mortgage_cuota_stored_link: {
    anchor: "sheet row's day",
    candidate: "card purchase",
    ...sym(14),
    unit: "days",
    amount: "exact",
    note: "the stored deposit link keeps this wider window until the flow model decides (F9 step 3)",
  },

  // ── receipts, orders and recurring payments ────────────────────────────────────────────────────
  receipt: {
    anchor: "receipt's payment day",
    candidate: "card/expense line",
    daysBefore: 1,
    daysAfter: 5,
    unit: "days",
    amount: "tolerance",
    toleranceFraction: 0.04,
    note: "the tolerance applies to a receipt in pesos paid with dollars (and an App Store receipt priced in another currency)",
  },
  subscription_cadence: {
    anchor: "billing cycle date",
    candidate: "charge",
    ...sym(3),
    unit: "days",
    amount: "tolerance",
    toleranceFraction: 0.03,
  },
  recurring_uf_line: {
    anchor: "line's day",
    candidate: "UF value that may price it",
    daysBefore: 0,
    daysAfter: 5,
    unit: "days",
    amount: "tolerance",
    note: "a listing is priced at its posting day, up to five days after",
  },
  utility_bill_charge: {
    anchor: "bill's due day",
    candidate: "charge that paid it",
    daysBefore: 0,
    daysAfter: 20,
    unit: "days",
    amount: "exact",
    note: "starts at the bill's issue day",
  },
  hoa_bill_charge: {
    anchor: "statement's issue day",
    candidate: "transfer that paid it",
    daysBefore: 0,
    daysAfter: 35,
    unit: "days",
    amount: "exact",
  },
  utility_bill_overdue: {
    anchor: "end of the charge window",
    candidate: "no charge yet",
    daysBefore: 0,
    daysAfter: 5,
    unit: "days",
    amount: "none",
  },
  unbilled_hoa_payment_grace: {
    anchor: "today",
    candidate: "gastos comunes payment without a statement",
    daysBefore: 10,
    daysAfter: 0,
    unit: "days",
    amount: "none",
  },
  real_estate_bill_purchase: {
    anchor: "bill month",
    candidate: "purchase month",
    daysBefore: 0,
    daysAfter: 2,
    unit: "months",
    amount: "exact",
  },
  same_split: {
    anchor: "split announced",
    candidate: "the same split from another source",
    ...sym(7),
    unit: "days",
    amount: "none",
  },
} as const satisfies Record<string, MatchWindow>;

export type MatchRelation = keyof typeof MATCH_WINDOWS;

/** The window of a relation, typed as a plain `MatchWindow`. */
export function matchWindow(relation: MatchRelation): MatchWindow {
  return MATCH_WINDOWS[relation];
}
