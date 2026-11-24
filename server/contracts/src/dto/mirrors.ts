/** One leg of a historical mirror pair (panel /panel/mirror-pairs). */
export interface MirrorLegDto {
  movement_id: number;
  account_id: number;
  account_name: string;
  kind_slug: string | null;
  occurred_on: string;
  /** Signed in `currency`: an outflow negative, an inflow positive. */
  amount: number;
  currency: string;
  units_delta: number | null;
  note: string | null;
}

/** A leg that could take one side of an ambiguous pair instead of the offered one. */
export interface MirrorPairAlternative {
  leg: MirrorLegDto;
  gap_days: number;
  within_business_day_window: boolean;
  month_straddle: boolean;
}

export interface MirrorPairCandidate {
  out: MirrorLegDto;
  in: MirrorLegDto;
  gap_days: number;
  within_business_day_window: boolean;
  /** One leg is month-precision (cuenta de ahorro): dates are conventional month-ends. */
  month_precision: boolean;
  month_straddle: boolean;
  /** Pair comes from an existing expense_deposit_links row (gastos match), not the heuristic. */
  linked: boolean;
  out_candidate_count: number;
  in_candidate_count: number;
  /** Other outflows that could pair with this inflow, and other inflows for this outflow. */
  out_alternatives: MirrorPairAlternative[];
  in_alternatives: MirrorPairAlternative[];
  confidence: "high" | "ambiguous";
}

export interface RejectedMirrorPair {
  out: MirrorLegDto;
  in: MirrorLegDto;
  created_at: string;
}

/** Checking↔credit-card payment mirror: the "in" side is statement evidence, not a movement. */
export interface CcPaymentMirrorCandidateDto {
  out: {
    movement_id: number;
    account_id: number;
    account_name: string;
    occurred_on: string;
    amount_clp: number; // convention-ok: a peso checking debit paired with card payment evidence in pesos
    note: string | null;
  };
  evidence: {
    cc_account_id: number;
    cc_account_name: string;
    statement_line_id: number | null;
    statement_id: number | null;
    pago_iso: string;
    amount_clp: number; // convention-ok: a peso checking debit paired with card payment evidence in pesos
    label: string;
  };
  skew_days: number;
  blocked: boolean;
  blocked_reason: string | null;
}

export interface CcPaymentMirrorRefDto {
  out_movement_id: number;
  statement_line_id?: number | null;
  statement_id?: number | null;
}

/** One end of a mirror route: the account money leaves or reaches. */
export interface MirrorRouteAccount {
  account_id: number;
  account_name: string;
}

/** The pairs of a section that move money along one route (from → to), in the section's order. */
export interface MirrorRouteGroup<P> {
  from: MirrorRouteAccount;
  to: MirrorRouteAccount;
  count: number;
  pairs: P[];
}

/** A panel section: its pair count and its pairs grouped by route (routes in first-pair order). */
export interface MirrorPairSection<P> {
  count: number;
  routes: MirrorRouteGroup<P>[];
}

/**
 * /panel/mirror-pairs, built by the server: high-confidence and ambiguous pairs, convertible card
 * payments (blocked ones left out), each grouped by route; rejected pairs as a flat list.
 */
export interface MovementMirrorCandidatesResponse {
  high: MirrorPairSection<MirrorPairCandidate>;
  ambiguous: MirrorPairSection<MirrorPairCandidate>;
  cc_payments: MirrorPairSection<CcPaymentMirrorCandidateDto>;
  rejected: RejectedMirrorPair[];
}

export interface MirrorPairRef {
  out_movement_id: number;
  in_movement_id: number;
}
