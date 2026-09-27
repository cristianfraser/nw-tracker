import { parseNumberInput } from "./format";

/** The currency symbol the flows table prints: `$` or `US$`, at most one space, then the number. */
const CURRENCY_PREFIX = /^(?:US\$|\$) ?(?=[\d.,])/;

/**
 * The number in an amount as the flows table prints it — «$1.xxx.xxx», «US$ xx,xx», a negative
 * leg in accounting parentheses «($500)», or typed with a minus «-$500» — as signed text for
 * `parseNumberInput`; null when the entry isn't in that form.
 */
function tableAmountNumber(text: string): string | null {
  const parenthesized = /^\((.*)\)$/.exec(text);
  const negative = parenthesized != null || text.startsWith("-");
  const body = parenthesized ? parenthesized[1] : negative ? text.slice(1) : text;
  const prefix = CURRENCY_PREFIX.exec(body);
  return prefix ? `${negative ? "-" : ""}${body.slice(prefix[0].length)}` : null;
}

function absAmount(value: number | null): number | undefined {
  return value == null ? undefined : Math.abs(value);
}

/**
 * A flows amount-filter field as the |amount| it matches — the server compares rounded absolute
 * legs, so a sign is dropped. The number is read by `parseNumberInput` like every form field;
 * the filter alone also takes an amount copied from the flows table, currency symbol and
 * accounting parentheses included. An entry that still isn't a number filters nothing and
 * reports why, naming the whole entry.
 */
export function parseFlowsAmountFilter(raw: string): {
  value: number | undefined;
  error: string | null;
} {
  const parsed = parseNumberInput(raw);
  if (parsed.ok) return { value: absAmount(parsed.value), error: null };
  const number = tableAmountNumber(raw.trim());
  if (number != null) {
    const fromTable = parseNumberInput(number);
    if (fromTable.ok) return { value: absAmount(fromTable.value), error: null };
  }
  return { value: undefined, error: parsed.message };
}
