/**
 * The cupo-gap proof of an annulled card purchase (`ccAnnulmentWriters.ts` holds the other writers):
 * the bank's cupo utilizado moved, since it last agreed with the app, by exactly one open-cycle
 * charge its listing no longer shows. Its own module because it reads the app's owed figure
 * (`ccOwedByCurrency`), which reaches the statement reconcile that imports the other writers.
 */
import { db } from "./db.js";
import { isHomeCurrency, roundToCurrency } from "./displayUnits.js";
import { ccOwedByCurrency, foreignOwedIn } from "./ccOwedByCurrency.js";
import type { CcOpenBucketLine } from "./ccFeedCuotaPurchases.js";
import { classifyUnlistedLines, planFeedMirror } from "./ccFeedMirror.js";
import type { CcListingLine } from "./ccWebPasteParse.js";
import { chileDayOf, coin, type Currency } from "./ccAnnulmentWriters.js";

// ── the cupo gap ──────────────────────────────────────────────────────────────────────────────────

export type CcCupoGapOutcome =
  | "annulled"
  | "restatement_removed"
  | "no_gap"
  | "no_reference"
  | "no_close"
  | "close_mismatch"
  | "no_candidate"
  | "ambiguous";

export type CcCupoGapReport = {
  currency: Currency;
  bank_used: number;
  app_owed: number;
  /** app − bank now (the cupo check's `diff`). */
  residual_now: number;
  /** The residual at the reference observation; null when there is none. */
  residual_ref: number | null;
  /** `ok`: the latest earlier observation the check found equal; `smallest`: the smallest |diff| of the recent ones. */
  reference: "ok" | "smallest" | null;
  /** residual_now − residual_ref: what the app counts that the bank stopped counting. */
  delta: number | null;
  candidates: number;
  outcome: CcCupoGapOutcome;
};

const selRecentVerdicts = db.prepare(
  `SELECT k.status, k.diff FROM cc_bank_cupo_checks k
   JOIN cc_bank_cupo_snapshots s ON s.id = k.snapshot_id
   JOIN cc_bank_cupo_captures c ON c.id = s.capture_id
   WHERE s.account_id = ? AND s.currency = ? AND c.observed_at < ? AND k.status IN ('ok', 'mismatch') AND k.diff IS NOT NULL
   ORDER BY c.observed_at DESC, s.id DESC LIMIT 40`
);

/**
 * The residual (app − bank, as the cupo check states it) to judge today's by. Proof by CHANGE: the
 * bank's identity (close + cuota remainder + listed rows = utilizado) holds exactly only when the
 * app models everything, and a card can carry a stable difference (BCI's cuota rounding, a few
 * pesos) — so what proves a drop is the residual moving by exactly one open charge. The reference
 * is the latest earlier observation the check judged equal (`ok`, diff 0); with none, the recent
 * verdict with the smallest |diff| (the latest among equals) — the most agreeing state on record.
 * No earlier verdict at all means no reference and no proof.
 */
export function cupoGapReference(
  accountId: number,
  currency: Currency,
  observedAt: string
): { residual: number; kind: "ok" | "smallest" } | null {
  const rows = selRecentVerdicts.all(accountId, currency, observedAt) as { status: string; diff: number }[];
  if (rows.length === 0) return null;
  const ok = rows.find((r) => r.status === "ok");
  if (ok) return { residual: ok.diff, kind: "ok" };
  let best = rows[0]!;
  for (const r of rows) if (Math.abs(r.diff) < Math.abs(best.diff)) best = r;
  return { residual: best.diff, kind: "smallest" };
}

/**
 * Judge one card and currency's cupo gap (read-only planner; call after the listing's lines are
 * written). When the app counts exactly one open-cycle charge more than it did when the bank last
 * agreed (see {@link cupoGapReference}) and exactly one charge the listing does not list has that
 * amount, that charge is what the bank dropped: `toAnnul` (a restated pending authorization — the
 * bank re-listed it under another name or amount — is `toRemove` instead, as the mirror treats
 * it). Zero or several candidates, or a gap no single line explains, change nothing and are reported.
 */
export function planCupoGap(
  accountId: number,
  opts: {
    currency: Currency;
    bankUsed: number;
    /** The session's observation time (an ISO instant): its Chile day frames the app's owed. */
    observedAt: string;
    /** The close the listing states for the card, if any: the app's must be the same. */
    feedCloseIso: string | null;
    feedLines: readonly CcListingLine[];
  }
): { report: CcCupoGapReport; toAnnul: CcOpenBucketLine | null; toRemove: CcOpenBucketLine | null } {
  const { currency } = opts;
  const owed = ccOwedByCurrency(accountId, chileDayOf(opts.observedAt));
  const appOwed = isHomeCurrency(currency) ? owed.clp.total : foreignOwedIn(owed, currency).total;
  const residualNow = roundToCurrency(appOwed - opts.bankUsed, currency) || 0;
  const report: CcCupoGapReport = {
    currency,
    bank_used: opts.bankUsed,
    app_owed: appOwed,
    residual_now: residualNow,
    residual_ref: null,
    reference: null,
    delta: null,
    candidates: 0,
    outcome: "no_gap",
  };
  const none = { report, toAnnul: null, toRemove: null };
  if (opts.feedCloseIso != null && owed.close_iso !== opts.feedCloseIso) return { ...none, report: { ...report, outcome: "close_mismatch" } };
  if (owed.close_iso == null) return { ...none, report: { ...report, outcome: "no_close" } };
  const ref = cupoGapReference(accountId, currency, opts.observedAt);
  if (!ref) return { ...none, report: { ...report, outcome: "no_reference" } };
  const delta = roundToCurrency(residualNow - ref.residual, currency) || 0;
  Object.assign(report, { residual_ref: ref.residual, reference: ref.kind, delta });
  if (delta <= 0) return none;

  const unlisted = planFeedMirror(accountId, { windowStartIso: owed.close_iso, currencies: new Set([currency]), feedLines: opts.feedLines });
  const matching = unlisted.filter((l) => {
    const amt = currency === "usd" ? l.amount_usd : l.amount_clp; // convention-ok: a listing bucket line carries the legacy peso/dollar view (cards/lineAmountSql.ts)
    return amt != null && coin(amt, currency) === coin(delta, currency);
  });
  report.candidates = matching.length;
  if (matching.length === 0) return { ...none, report: { ...report, outcome: "no_candidate" } };
  if (matching.length > 1) return { ...none, report: { ...report, outcome: "ambiguous" } };
  const only = matching[0]!;
  const kind = classifyUnlistedLines([only], opts.feedLines)[0]!.kind;
  if (kind === "dropped") return { report: { ...report, outcome: "annulled" }, toAnnul: only, toRemove: null };
  return { report: { ...report, outcome: "restatement_removed" }, toAnnul: null, toRemove: only };
}
