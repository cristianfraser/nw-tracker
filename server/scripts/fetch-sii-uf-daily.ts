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

const SII_UF_BASE = "https://www.sii.cl/valores_y_fechas/uf";

/** `mes_enero` … `mes_diciembre` → 1–12 */
const MES_ID_TO_MONTH: Record<string, number> = {
  mes_enero: 1,
  mes_febrero: 2,
  mes_marzo: 3,
  mes_abril: 4,
  mes_mayo: 5,
  mes_junio: 6,
  mes_julio: 7,
  mes_agosto: 8,
  mes_septiembre: 9,
  mes_octubre: 10,
  mes_noviembre: 11,
  mes_diciembre: 12,
};

/** Chilean thousands `.` and decimal `,` → number */
function parseChileanUfCell(raw: string): number | null {
  const t = raw.replace(/&nbsp;/gi, " ").trim();
  if (!t) return null;
  const n = Number(t.replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(n) || n < 1000 || n > 1e6) return null;
  return n;
}

/** Parse one year's `uf{year}.htm` body into YYYY-MM-DD → clp_per_uf */
export function parseSiiUfYearHtml(html: string, year: number): Map<string, number> {
  const out = new Map<string, number>();
  const chunks = html.split("<div class='meses' id='");
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const idEnd = chunk.indexOf("'>");
    if (idEnd < 0) continue;
    const id = chunk.slice(0, idEnd);
    if (id === "mes_all") continue;
    const month = MES_ID_TO_MONTH[id];
    if (!month) continue;
    const body = chunk.slice(idEnd + 2);
    const cellRe = /<strong>(\d+)<\/strong><\/th>\s*<td[^>]*>([^<]*)<\/td>/gi;
    let m: RegExpExecArray | null;
    while ((m = cellRe.exec(body)) !== null) {
      const day = parseInt(m[1]!, 10);
      const clp = parseChileanUfCell(m[2]!);
      if (clp == null || day < 1 || day > 31) continue;
      const d = new Date(Date.UTC(year, month - 1, day));
      if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) continue;
      const ymd = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      out.set(ymd, clp);
    }
  }
  return out;
}

async function fetchYear(year: number): Promise<Map<string, number>> {
  const url = `${SII_UF_BASE}/uf${year}.htm`;
  const res = await fetch(url, { headers: { "User-Agent": "nw-tracker-uf-fetch/1.0" } });
  if (!res.ok) throw new Error(`SII UF ${year}: HTTP ${res.status} ${url}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const html = new TextDecoder("iso-8859-1").decode(buf);
  return parseSiiUfYearHtml(html, year);
}

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
    const m = await fetchYear(year);
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
