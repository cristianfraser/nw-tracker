export type FxConversionWarningCode =
  | "buy_rate_missing"
  | "sell_rate_missing"
  | "usd_reference_clp";

export type FxConversionWarning = {
  code: FxConversionWarningCode;
  date: string;
  context?: string;
};

const active: FxConversionWarning[] = [];

export function clearFxConversionWarnings(): void {
  active.length = 0;
}

export function recordFxConversionWarning(w: FxConversionWarning): void {
  const key = `${w.code}|${w.date}|${w.context ?? ""}`;
  if (active.some((x) => `${x.code}|${x.date}|${x.context ?? ""}` === key)) return;
  active.push(w);
}

export function takeFxConversionWarnings(): FxConversionWarning[] {
  return [...active];
}
