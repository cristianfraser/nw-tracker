/**
 * Standard normal CDF (`phi`) and its inverse (`phiInv`) without dependencies, for the
 * lognormal wealth-distribution model (/wealth-percentile).
 *
 * `phi` uses the Numerical Recipes rational-Chebyshev erfc approximation (fractional
 * error < 1.2e-7); `phiInv` uses Acklam's algorithm (relative error < 1.2e-9). Both are
 * far more precise than the databook inputs they are combined with.
 */

/** Complementary error function, |fractional error| < 1.2e-7 (Numerical Recipes 6.2). */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + z / 2);
  const ans =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))
    );
  return x >= 0 ? ans : 2 - ans;
}

/** Standard normal CDF Φ(z). */
export function phi(z: number): number {
  if (!Number.isFinite(z)) throw new Error(`phi: z must be finite, got ${z}`);
  return 0.5 * erfc(-z / Math.SQRT2);
}

const ACKLAM_A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
  -3.066479806614716e1, 2.506628277459239,
] as const;
const ACKLAM_B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
  -1.328068155288572e1,
] as const;
const ACKLAM_C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
  4.374664141464968, 2.938163982698783,
] as const;
const ACKLAM_D = [
  7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416,
] as const;
const ACKLAM_P_LOW = 0.02425;

/** Inverse standard normal CDF Φ⁻¹(p), p ∈ (0, 1). */
export function phiInv(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error(`phiInv: p must be in (0, 1), got ${p}`);
  const [a0, a1, a2, a3, a4, a5] = ACKLAM_A;
  const [b0, b1, b2, b3, b4] = ACKLAM_B;
  const [c0, c1, c2, c3, c4, c5] = ACKLAM_C;
  const [d0, d1, d2, d3] = ACKLAM_D;
  if (p < ACKLAM_P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) /
      ((((d0 * q + d1) * q + d2) * q + d3) * q + 1)
    );
  }
  if (p > 1 - ACKLAM_P_LOW) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) /
      ((((d0 * q + d1) * q + d2) * q + d3) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a0 * r + a1) * r + a2) * r + a3) * r + a4) * r + a5) * q) /
    (((((b0 * r + b1) * r + b2) * r + b3) * r + b4) * r + 1)
  );
}
