import { DefaultZIndexes } from "recharts";

/**
 * Layer for guides that sit under every series (the zero line, the current-period marker). Recharts 3
 * paints by layer, not by JSX order, and draws reference lines in the line layer, over the bars.
 * Apart from `chartLayout.ts` because it reads Recharts at runtime, and `chartLayout.ts` is imported
 * by eager UI (the chart empty state); only chart components, in the lazy charts chunk, import this.
 */
export const UNDER_SERIES_Z_INDEX = DefaultZIndexes.area - 1;
