/** Trailing simple moving average; first `window - 1` points get `null`. */
export function appendTrailingMovingAverage(
  points: Record<string, string | number | null>[],
  sourceKey: string,
  targetKey: string,
  window = 3
): Record<string, string | number | null>[] {
  if (window < 1) return points;
  return points.map((row, i) => {
    if (i < window - 1) {
      return { ...row, [targetKey]: null };
    }
    let sum = 0;
    for (let j = i - (window - 1); j <= i; j++) {
      const v = points[j]![sourceKey];
      sum += typeof v === "number" && Number.isFinite(v) ? v : 0;
    }
    return { ...row, [targetKey]: sum / window };
  });
}
