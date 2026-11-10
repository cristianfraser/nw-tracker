/**
 * What offsets what inside one year: the code-169 pool (line 17's gains against the year's capital
 * losses, `chain.ts`' {@link CAPITAL_LOSS_POOL_CODES}) and the foreign share sales netted among
 * themselves (a loss offsets nothing else) — with the IGC at stake on what is left over.
 */
import { capitalLossPoolClp } from "./chain.js";
import type { ForeignShareYearResult } from "./foreignShares.js";
import type { F22Codes, F22LossOffset, F22OffsetBalance } from "./types.js";

export const EMPTY_OFFSET: F22OffsetBalance = { gainsClp: 0, lossesClp: 0, deductedClp: 0, unusedLossClp: 0, taxedGainClp: 0, taxEffectClp: null };

/** 304 for a draft input, once capped and finished as the draft is. */
export type F22TaxOf = (input: F22Codes) => number;

/** The year's code-169 pool, with what each source put in; `taxed`: whether the chain ran (else no tax effect). */
export function capitalLossOffset(input: {
  draftInput: F22Codes;
  draft: F22Codes;
  taxOf: F22TaxOf;
  taxed: boolean;
  cryptoGain: number;
  foreignGain: number;
  dividendsNetClp: number;
  declaredLossClp: number;
  fundLossClp: number;
  usdFx1032: number;
  usdFxLoss: number;
}): F22LossOffset {
  const { draftInput, draft, taxOf, taxed } = input;
  const gainsClp = capitalLossPoolClp(draftInput);
  const lossesClp = draftInput[169] ?? 0;
  const deductedClp = Math.min(gainsClp, lossesClp);
  const unusedLossClp = lossesClp - deductedClp;
  const taxedGainClp = gainsClp - deductedClp;
  let taxEffectClp: number | null = null;
  if (taxed && unusedLossClp > 0) {
    const withGain = { ...draftInput, 1032: (draftInput[1032] ?? 0) + unusedLossClp };
    taxEffectClp = taxOf({ ...withGain, 169: deductedClp }) - taxOf(withGain);
  } else if (taxed && taxedGainClp > 0) {
    taxEffectClp = draft[304]! - taxOf({ ...draftInput, 169: lossesClp + taxedGainClp });
  }
  return {
    parts: [
      { source: "crypto", gainClp: Math.max(0, input.cryptoGain), lossClp: Math.max(0, -input.cryptoGain) },
      { source: "foreign_shares", gainClp: input.foreignGain, lossClp: 0 },
      { source: "foreign_dividends", gainClp: Math.max(0, input.dividendsNetClp), lossClp: 0 },
      {
        source: "funds_interest",
        // 105 (an art. 107 fund's distributions) is fund income too.
        gainClp:
          Math.max(0, draftInput[155] ?? 0) + Math.max(0, draftInput[152] ?? 0) + Math.max(0, draftInput[105] ?? 0),
        lossClp: input.declaredLossClp + input.fundLossClp,
      },
      // Only the `igc_1032` route puts the dollars' exchange result in the pool; under 1901 it is apart.
      { source: "usd_fx", gainClp: input.usdFx1032, lossClp: input.usdFxLoss },
    ],
    gainsClp,
    lossesClp,
    deductedClp,
    unusedLossClp,
    taxedGainClp,
    taxEffectClp,
  };
}

/** The foreign share sales netted among themselves; `foreignResult` is their total under the default frame, rounded. */
export function foreignShareOffset(input: {
  foreignShares: ForeignShareYearResult;
  foreignResult: number;
  draftInput: F22Codes;
  draft: F22Codes;
  taxOf: F22TaxOf;
  taxed: boolean;
}): F22OffsetBalance {
  const { foreignShares, foreignResult, draftInput, draft, taxOf, taxed } = input;
  const mode = foreignShares.defaultMode;
  const foreignGainsClp = Math.round(foreignShares.disposals.reduce((s, x) => s + Math.max(0, x.resultClp[mode]), 0));
  const foreignLossesClp = foreignGainsClp - foreignResult;
  const foreignDeductedClp = Math.min(foreignGainsClp, foreignLossesClp);
  const foreignUnusedLossClp = foreignLossesClp - foreignDeductedClp;
  const foreignTaxedGainClp = foreignGainsClp - foreignDeductedClp;
  let foreignTaxEffectClp: number | null = null;
  if (taxed && foreignUnusedLossClp > 0) {
    foreignTaxEffectClp = taxOf({ ...draftInput, 1104: (draftInput[1104] ?? 0) + foreignUnusedLossClp }) - draft[304]!;
  } else if (taxed && foreignTaxedGainClp > 0) {
    foreignTaxEffectClp = draft[304]! - taxOf({ ...draftInput, 1104: (draftInput[1104] ?? 0) - foreignTaxedGainClp });
  }
  return {
    gainsClp: foreignGainsClp,
    lossesClp: foreignLossesClp,
    deductedClp: foreignDeductedClp,
    unusedLossClp: foreignUnusedLossClp,
    taxedGainClp: foreignTaxedGainClp,
    taxEffectClp: foreignTaxEffectClp,
  };
}
