/**
 * Fetches official daily UF (CLP per 1 UF) from the SII HTML tables
 * (e.g. https://www.sii.cl/valores_y_fechas/uf/uf2026.htm) and writes `server/data/uf-sii-daily.csv`
 * (committed; sole source for `uf_daily` during `import:excel`).
 *
 * Usage (from repo root):
 *   npm run fetch-uf -w nw-tracker-server
 *   npm run fetch-uf -w nw-tracker-server -- --years 2024,2025,2026
 *
 * Re-run periodically for new calendar days / years.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveBundledUfSiiDailyCsvPath } from "../src/ufSiiDailyPath.js";
import { fetchSiiUfYear } from "../src/ufSiiSync.js";

function parseYearsArg(): number[] {
  const i = process.argv.indexOf("--years");
  if (i >= 0 && process.argv[i + 1]) {
    return process.argv[i + 1]!
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((y) => Number.isFinite(y) && y >= 1990 && y <= 2100);
  }
  const y = new Date().getUTCFullYear();
  return [y - 3, y - 2, y - 1, y].filter((v, idx, a) => a.indexOf(v) === idx).sort((a, b) => a - b);
}

async function main() {
  const years = parseYearsArg();
  if (years.length === 0) {
    console.error("No valid years. Use --years 2023,2024,2025,2026");
    process.exit(1);
  }
  const merged = new Map<string, number>();
  for (const year of years) {
    console.error(`fetching UF ${year}…`);
    const m = await fetchSiiUfYear(year);
    for (const [d, v] of m) merged.set(d, v);
    console.error(`  ${m.size} days`);
  }
  const dates = [...merged.keys()].sort();
  const lines = ["date;clp_per_uf", ...dates.map((d) => `${d};${merged.get(d)!}`)];
  const outPath = process.argv.includes("--stdout") ? null : resolveBundledUfSiiDailyCsvPath();
  const text = lines.join("\n") + "\n";
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, text, "utf8");
    console.error(`wrote ${dates.length} rows → ${outPath}`);
  } else {
    process.stdout.write(text);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
