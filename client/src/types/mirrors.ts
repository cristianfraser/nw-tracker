/** One leg of a historical mirror pair (panel /panel/mirror-pairs). */
export interface MirrorLegDto {
  movement_id: number;
  account_id: number;
  account_name: string;
  kind_slug: string | null;
  occurred_on: string;
  amount_clp: number;
  units_delta: number | null;
  note: string | null;
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
  confidence: "high" | "ambiguous";
  blocked: boolean;
  blocked_reason: "checking_inflow_month_straddle" | null;
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
    amount_clp: number;
    note: string | null;
  };
  evidence: {
    cc_account_id: number;
    cc_account_name: string;
    statement_line_id: number | null;
    statement_id: number | null;
    pago_iso: string;
    amount_clp: number;
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

export interface MovementMirrorCandidatesResponse {
  pairs: MirrorPairCandidate[];
  rejected: RejectedMirrorPair[];
  cc_payment_pairs: CcPaymentMirrorCandidateDto[];
}

export interface MirrorPairRef {
  out_movement_id: number;
  in_movement_id: number;
}
