export function filterPointsThroughAsOfDate<T extends { as_of_date: string }>(
  rows: readonly T[],
  maxAsOfDate: string | null | undefined
): T[] {
  if (!maxAsOfDate) return [...rows];
  return rows.filter((r) => r.as_of_date.localeCompare(maxAsOfDate) <= 0);
}

/** When perf rows include a live today row newer than chart tail-clip, keep it visible. */
export function resolveMonthlyPerfClipEndDate(
  valuationTailClipEndDate: string | null | undefined,
  rowsNewestFirst: readonly { as_of_date: string }[]
): string | null | undefined {
  const latestPerfDate = rowsNewestFirst[0]?.as_of_date;
  if (
    valuationTailClipEndDate &&
    latestPerfDate &&
    latestPerfDate.localeCompare(valuationTailClipEndDate) > 0
  ) {
    return latestPerfDate;
  }
  return valuationTailClipEndDate;
}
