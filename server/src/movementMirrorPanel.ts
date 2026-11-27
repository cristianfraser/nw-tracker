/** The /panel/mirror-pairs payload: candidates split into sections, each grouped by route. */
import type {
  CcPaymentMirrorCandidateDto,
  MirrorPairCandidate,
  MirrorPairSection,
  MirrorRouteAccount,
  MovementMirrorCandidatesResponse,
  RejectedMirrorPair,
} from "nw-tracker-contracts/dto/mirrors";

/**
 * Groups a section's pairs by route (from → to). Routes keep the order of their first pair and
 * each route keeps its pairs in the section's order, so the ranking the candidate list chose
 * (link-established first, then gap and amount) still reads top-down inside a route.
 */
export function mirrorPairSection<P>(
  pairs: P[],
  route: (p: P) => { from: MirrorRouteAccount; to: MirrorRouteAccount }
): MirrorPairSection<P> {
  const groups = new Map<string, MirrorPairSection<P>["routes"][number]>();
  for (const p of pairs) {
    const { from, to } = route(p);
    const key = `${from.account_id}|${to.account_id}`;
    const group = groups.get(key);
    if (group) {
      group.pairs.push(p);
      group.count = group.pairs.length;
    } else groups.set(key, { from, to, count: 1, pairs: [p] });
  }
  return { count: pairs.length, routes: [...groups.values()] };
}

const legRoute = (p: MirrorPairCandidate) => ({
  from: { account_id: p.out.account_id, account_name: p.out.account_name },
  to: { account_id: p.in.account_id, account_name: p.in.account_name },
});

const ccRoute = (p: CcPaymentMirrorCandidateDto) => ({
  from: { account_id: p.out.account_id, account_name: p.out.account_name },
  to: { account_id: p.evidence.cc_account_id, account_name: p.evidence.cc_account_name },
});

export function buildMirrorPairsPanel(
  pairs: MirrorPairCandidate[],
  ccPairs: CcPaymentMirrorCandidateDto[],
  rejected: RejectedMirrorPair[]
): MovementMirrorCandidatesResponse {
  return {
    high: mirrorPairSection(
      pairs.filter((p) => p.confidence === "high" && p.blocked_reason == null),
      legRoute
    ),
    ambiguous: mirrorPairSection(
      pairs.filter((p) => p.confidence === "ambiguous" && p.blocked_reason == null),
      legRoute
    ),
    // A pair whose legs carry conflicting assignments is shown apart with its reason: it converts
    // once the user removes one of the two.
    blocked: mirrorPairSection(
      pairs.filter((p) => p.blocked_reason != null),
      legRoute
    ),
    // A blocked card payment cannot be converted (its card still waits on evidence), so the panel
    // does not offer it.
    cc_payments: mirrorPairSection(
      ccPairs.filter((p) => !p.blocked),
      ccRoute
    ),
    rejected,
  };
}
