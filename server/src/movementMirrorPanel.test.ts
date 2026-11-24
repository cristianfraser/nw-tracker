import { describe, expect, it } from "vitest";
import type { CcPaymentMirrorCandidateDto, MirrorLegDto, MirrorPairCandidate } from "nw-tracker-contracts/dto/mirrors";
import { buildMirrorPairsPanel } from "./movementMirrorPanel.js";

function leg(id: number, accountId: number, amount: number): MirrorLegDto {
  return {
    movement_id: id,
    account_id: accountId,
    account_name: `acct-${accountId}`,
    kind_slug: null,
    occurred_on: "2020-01-01",
    amount,
    currency: "clp",
    units_delta: null,
    note: null,
  };
}

function pair(outId: number, from: number, to: number, confidence: "high" | "ambiguous"): MirrorPairCandidate {
  return {
    out: leg(outId, from, -100),
    in: leg(outId + 1000, to, 100),
    gap_days: 0,
    within_business_day_window: true,
    month_precision: false,
    month_straddle: false,
    linked: false,
    out_candidate_count: 1,
    in_candidate_count: 1,
    out_alternatives: [],
    in_alternatives: [],
    confidence,
  };
}

function ccPair(outId: number, card: number, blocked: boolean): CcPaymentMirrorCandidateDto {
  return {
    out: { movement_id: outId, account_id: 1, account_name: "acct-1", occurred_on: "2020-01-01", amount_clp: -50, note: null },
    evidence: {
      cc_account_id: card,
      cc_account_name: `card-${card}`,
      statement_line_id: outId,
      statement_id: null,
      pago_iso: "2020-01-02",
      amount_clp: 50,
      label: "PAGO",
    },
    skew_days: 1,
    blocked,
    blocked_reason: blocked ? "waiting" : null,
  };
}

describe("buildMirrorPairsPanel", () => {
  it("splits pairs by confidence and groups each section by route in first-pair order", () => {
    const panel = buildMirrorPairsPanel(
      [pair(1, 1, 2, "high"), pair(2, 3, 1, "high"), pair(3, 1, 2, "ambiguous"), pair(4, 1, 2, "high")],
      [],
      []
    );
    expect(panel.high.count).toBe(3);
    expect(panel.high.routes.map((r) => [r.from.account_id, r.to.account_id])).toEqual([
      [1, 2],
      [3, 1],
    ]);
    expect(panel.high.routes[0]!.pairs.map((p) => p.out.movement_id)).toEqual([1, 4]);
    expect(panel.high.routes.map((r) => r.count)).toEqual([2, 1]);
    expect(panel.ambiguous.count).toBe(1);
    expect(panel.ambiguous.routes[0]!.to.account_name).toBe("acct-2");
  });

  it("routes card payments to the card and leaves blocked ones out", () => {
    const panel = buildMirrorPairsPanel([], [ccPair(1, 9, false), ccPair(2, 9, true), ccPair(3, 8, false)], []);
    expect(panel.cc_payments.count).toBe(2);
    expect(panel.cc_payments.routes.map((r) => [r.to.account_id, r.pairs.length])).toEqual([
      [9, 1],
      [8, 1],
    ]);
  });
});
