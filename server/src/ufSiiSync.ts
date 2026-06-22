/** Official daily UF from SII HTML tables (valores y fechas). */

const SII_UF_BASE = "https://www.sii.cl/valores_y_fechas/uf";

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

function parseChileanUfCell(raw: string): number | null {
  const t = raw.replace(/&nbsp;/gi, " ").trim();
  if (!t) return null;
  const n = Number(t.replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(n) || n < 1000 || n > 1e6) return null;
  return n;
}

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
      if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
        continue;
      }
      const ymd = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      out.set(ymd, clp);
    }
  }
  return out;
}

async function fetchSiiUfYear(year: number): Promise<Map<string, number>> {
  const url = `${SII_UF_BASE}/uf${year}.htm`;
  const res = await fetch(url, { headers: { "User-Agent": "nw-tracker-uf-fetch/1.0" } });
  if (!res.ok) throw new Error(`SII UF ${year}: HTTP ${res.status} ${url}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const html = new TextDecoder("iso-8859-1").decode(buf);
  return parseSiiUfYearHtml(html, year);
}

/** SII rows with `date` strictly after `lastYmd` and on/before `endYmd`. */
export async function fetchSiiUfAfterDate(
  lastYmd: string,
  endYmd: string
): Promise<{ date: string; clpPerUf: number }[]> {
  const y0 = Number(lastYmd.slice(0, 4));
  const y1 = Number(endYmd.slice(0, 4));
  if (!Number.isFinite(y0) || !Number.isFinite(y1)) {
    throw new Error(`fetchSiiUfAfterDate: invalid range ${lastYmd}..${endYmd}`);
  }
  const merged = new Map<string, number>();
  for (let y = y0; y <= y1; y++) {
    const yearMap = await fetchSiiUfYear(y);
    for (const [d, v] of yearMap) merged.set(d, v);
  }
  const out: { date: string; clpPerUf: number }[] = [];
  for (const [date, clpPerUf] of merged) {
    if (date <= lastYmd || date > endYmd) continue;
    out.push({ date, clpPerUf });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}
