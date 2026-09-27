import { parseNumberInput } from "./format";

/**
 * The currency symbol an amount keeps when copied from the flows table — «$1.xxx.xxx»,
 * «US$ xx,xx», «-$500»: an optional sign, `$` or `US$`, at most one space, then the number.
 */
const CURRENCY_PREFIX = /^(-?)(?:US\$|\$) ?(?=[\d.,])/;

function absAmount(value: number | null): number | undefined {
  return value == null ? undefined : Math.abs(value);
}

/**
 * A flows amount-filter field as the |amount| it matches — the server compares rounded absolute
 * legs, so a sign is dropped. The number is read by `parseNumberInput` like every form field;
 * the filter alone also takes that one currency prefix. An entry that still isn't a number
 * filters nothing and reports why, naming the whole entry.
 */
export function parseFlowsAmountFilter(raw: string): {
  value: number | undefined;
  error: string | null;
} {
  const parsed = parseNumberInput(raw);
  if (parsed.ok) return { value: absAmount(parsed.value), error: null };
  const text = raw.trim();
  const prefix = CURRENCY_PREFIX.exec(text);
  if (prefix) {
    const unprefixed = parseNumberInput(`${prefix[1]}${text.slice(prefix[0].length)}`);
    if (unprefixed.ok) return { value: absAmount(unprefixed.value), error: null };
  }
  return { value: undefined, error: parsed.message };
}
