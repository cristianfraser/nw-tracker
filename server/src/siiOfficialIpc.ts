/**
 * The INE's official monthly IPC variation as the SII publishes it, per year, in
 * `https://www.sii.cl/valores_y_fechas/utm/utm<year>.htm` (table: Mes | UTM | UTA | IPC puntos |
 * variación mensual | acumulada | 12 meses; Chilean numbers, one decimal). Stored in
 * `ipc_official_monthly` (migration 196).
 *
 * Every variation is checked against the UF, which the Banco Central moves by exactly that
 * figure: from the 10th of the month after the IPC month to the 9th of the month after that, the
 * UF grows by the variation (rounded to one decimal, it matched every month 2015-2026). The
 * printed index is not checked against the variation — it restarts at each base change (2019-01,
 * 2024-01) and is rounded to two decimals while the INE derives the variation unrounded.
 */
import { db } from "./db.js";
import { parseChileanNumber } from "./chileanNumber.js";
import { fetchOut } from "./httpOut.js";

export type OfficialIpcMonth = { month: string; variationPct: number; indexPoints: number };

const MONTHS = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
];

function cellText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&aacute;/g, "á")
    .trim();
}

/**
 * The published months of one year's page, January onward. A month with no IPC yet ends the list;
 * a later month that has one, a missing month row, or an unparseable number throws.
 */
export function parseSiiUtmIpcPage(year: number, htmlText: string): OfficialIpcMonth[] {
  const body = htmlText.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "");
  const rows = new Map<string, string[]>();
  for (const tr of body.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [...tr.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) => cellText(m[1]!));
    if (cells.length > 0 && MONTHS.includes(cells[0]!)) {
      if (rows.has(cells[0]!)) throw new Error(`SII IPC ${year}: two rows for ${cells[0]}`);
      if (cells.length !== 7) throw new Error(`SII IPC ${year} ${cells[0]}: ${cells.length} cells, expected 7`);
      rows.set(cells[0]!, cells);
    }
  }
  const out: OfficialIpcMonth[] = [];
  let ended = false;
  MONTHS.forEach((name, i) => {
    const cells = rows.get(name);
    if (!cells) throw new Error(`SII IPC ${year}: no row for ${name}`);
    const [, , , points, variation] = cells;
    const month = `${year}-${String(i + 1).padStart(2, "0")}-01`;
    if (!points && !variation) {
      ended = true;
      return;
    }
    if (ended) throw new Error(`SII IPC ${year}: ${name} is published after an unpublished month`);
    if (!points || !variation) throw new Error(`SII IPC ${month}: index «${points}», variation «${variation}»`);
    out.push({ month, variationPct: parseChileanNumber(variation), indexPoints: parseChileanNumber(points) });
  });
  return out;
}

export async function fetchSiiOfficialIpcYear(year: number): Promise<OfficialIpcMonth[]> {
  const url = `https://www.sii.cl/valores_y_fechas/utm/utm${year}.htm`;
  const res = await fetchOut("sii", url, { headers: { "User-Agent": "nw-tracker-sii/1.0" } });
  if (!res.ok) throw new Error(`SII IPC ${year}: HTTP ${res.status}`);
  return parseSiiUtmIpcPage(year, await res.text());
}

/** First day (YYYY-MM-DD) of the month `offset` months after `month` (a first-of-month date). */
function monthPlus(month: string, offset: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + offset;
  return `${y + Math.floor(m / 12)}-${String((((m % 12) + 12) % 12) + 1).padStart(2, "0")}-01`;
}

/** The UF window a month's variation moves: the 9th of the next month to the 9th of the one after. */
export function ufWindowForIpcMonth(month: string): { from: string; to: string } {
  return { from: `${monthPlus(month, 1).slice(0, 8)}09`, to: `${monthPlus(month, 2).slice(0, 8)}09` };
}

/**
 * Checks each month against the UF (`ufOn(ymd)` → CLP per UF, or null when not stored). Throws on
 * a month whose UF growth, rounded to one decimal, differs; returns the months the UF cannot check
 * yet (its window not fully published) — only the two latest months may be among them.
 */
export function verifyOfficialIpcAgainstUf(
  months: readonly OfficialIpcMonth[],
  ufOn: (ymd: string) => number | null
): string[] {
  const unchecked: string[] = [];
  for (const m of months) {
    const w = ufWindowForIpcMonth(m.month);
    const a = ufOn(w.from);
    const b = ufOn(w.to);
    if (a == null || b == null) {
      unchecked.push(m.month);
      continue;
    }
    const growth = Math.round(((b / a - 1) * 100) * 10) / 10;
    if (Math.abs(growth - m.variationPct) > 1e-9) {
      throw new Error(
        `SII IPC ${m.month}: published variation ${m.variationPct}% but the UF grew ${growth}% from ${w.from} to ${w.to}`
      );
    }
  }
  const latest = [...months].map((m) => m.month).sort().slice(-2);
  const stale = unchecked.filter((m) => !latest.includes(m));
  if (stale.length > 0) throw new Error(`SII IPC: no UF to check ${stale.join(", ")} — backfill uf_daily`);
  return unchecked;
}

/**
 * Percentage variation of the official IPC from the end of `fromMonth` to the end of `toMonth`
 * (both first-of-month dates, from ≤ to): the monthly variations of the months after `fromMonth`
 * through `toMonth`, chained. For a crypto cost: from = the month before the purchase, to = the
 * month before the sale. Unrounded; throws when a month in between is not stored.
 */
export function officialIpcVariationPctBetween(
  fromMonth: string,
  toMonth: string,
  variationOf: (month: string) => number | null
): number {
  if (toMonth < fromMonth) throw new Error(`IPC variation: ${toMonth} is before ${fromMonth}`);
  let factor = 1;
  for (let m = monthPlus(fromMonth, 1); m <= toMonth; m = monthPlus(m, 1)) {
    const v = variationOf(m);
    if (v == null) throw new Error(`IPC variation: no official IPC for ${m}`);
    factor *= 1 + v / 100;
  }
  return (factor - 1) * 100;
}

export function loadOfficialIpcVariationLookup(): (month: string) => number | null {
  const rows = db.prepare(`SELECT month, variation_pct FROM ipc_official_monthly`).all() as {
    month: string;
    variation_pct: number;
  }[];
  const map = new Map(rows.map((r) => [r.month, r.variation_pct] as const));
  return (month) => map.get(month) ?? null;
}

function loadUfLookup(): (ymd: string) => number | null {
  const get = db.prepare(`SELECT clp_per_uf FROM uf_daily WHERE date = ?`);
  return (ymd) => (get.get(ymd) as { clp_per_uf: number } | undefined)?.clp_per_uf ?? null;
}

/**
 * Verifies `months` against the UF and upserts them in one transaction. A stored month whose
 * figures change throws (the SII does not revise a published month; a change means a parse
 * problem). Returns the months written for the first time and the ones the UF could not check yet.
 */
export function writeOfficialIpcMonths(
  months: readonly OfficialIpcMonth[],
  dryRun: boolean
): { added: number; ufUnchecked: string[] } {
  const ufUnchecked = verifyOfficialIpcAgainstUf(months, loadUfLookup());
  return db.transaction(() => {
    const get = db.prepare(`SELECT variation_pct, index_points FROM ipc_official_monthly WHERE month = ?`);
    const put = db.prepare(
      `INSERT INTO ipc_official_monthly (month, variation_pct, index_points) VALUES (?, ?, ?)
       ON CONFLICT(month) DO NOTHING`
    );
    let added = 0;
    for (const m of months) {
      const s = get.get(m.month) as { variation_pct: number; index_points: number } | undefined;
      if (s) {
        if (s.variation_pct !== m.variationPct || s.index_points !== m.indexPoints) {
          throw new Error(
            `SII IPC ${m.month}: stored ${s.variation_pct}% / ${s.index_points} but the page now says ${m.variationPct}% / ${m.indexPoints}`
          );
        }
        continue;
      }
      added++;
      if (!dryRun) put.run(m.month, m.variationPct, m.indexPoints);
    }
    return { added, ufUnchecked };
  })();
}
