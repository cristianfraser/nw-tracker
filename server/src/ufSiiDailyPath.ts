import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Committed daily UF (CLP per 1 UF) from the SII “valores y fechas” tables.
 * Refresh with `npm run fetch-uf -w nw-tracker-server` (writes this path).
 */
export function resolveBundledUfSiiDailyCsvPath(): string {
  return path.resolve(__dirname, "..", "data", "uf-sii-daily.csv");
}
