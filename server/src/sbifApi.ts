/**
 * CMF [SBIF API v3](https://api.sbif.cl) — UF, dólar observado, euro (daily), UTM / IPC (monthly).
 * Env: `SBIF_APIKEY` (repo-root `.env`, loaded by callers).
 */

export const SBIF_RECURSOS_BASE = "https://api.sbif.cl/api-sbifv3/recursos_api";

/** Chilean number: thousands `.`, decimal `,` */
export function parseSbifNumber(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t.replace(/\./g, "").replace(/,/g, "."));
  return Number.isFinite(n) ? n : null;
}

type FechaValor = { fecha: string; valor: string };

function collectFechaValorLeaves(obj: unknown, out: FechaValor[]): void {
  if (obj == null) return;
  if (Array.isArray(obj)) {
    for (const x of obj) collectFechaValorLeaves(x, out);
    return;
  }
  if (typeof obj !== "object") return;
  const o = obj as Record<string, unknown>;
  if (typeof o.Fecha === "string" && typeof o.Valor === "string") {
    out.push({ fecha: o.Fecha, valor: o.Valor });
    return;
  }
  for (const k of Object.keys(o)) collectFechaValorLeaves(o[k], out);
}

function dedupeByDate(rows: { date: string; value: number }[]): { date: string; value: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.date, r.value);
  return [...m.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchSbifJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "nw-tracker-sbif/1.0" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`SBIF HTTP ${res.status}: ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`SBIF JSON parse error: ${text.slice(0, 200)}`);
  }
}

/** Dólar observado (CLP per USD) for dates strictly after `lastYmd`. */
export async function fetchDolarAfterDate(
  lastYmd: string,
  apiKey: string
): Promise<{ date: string; clpPerUsd: number }[]> {
  const [y, mo, d] = lastYmd.split("-").map((x) => parseInt(x, 10));
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) {
    throw new Error(`Invalid lastYmd: ${lastYmd}`);
  }
  const url = `${SBIF_RECURSOS_BASE}/dolar/posteriores/${y}/${String(mo).padStart(2, "0")}/dias/${String(d).padStart(2, "0")}?apikey=${encodeURIComponent(apiKey)}&formato=json`;
  const body = await fetchSbifJson(url);
  const leaves: FechaValor[] = [];
  collectFechaValorLeaves(body, leaves);
  const rows: { date: string; value: number }[] = [];
  for (const { fecha, valor } of leaves) {
    const v = parseSbifNumber(valor);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || v == null || v <= 0) continue;
    rows.push({ date: fecha, value: v });
  }
  return dedupeByDate(rows).map((r) => ({ date: r.date, clpPerUsd: r.value }));
}

/** Euro observado (CLP per EUR) for dates strictly after `lastYmd`. */
export async function fetchEuroAfterDate(
  lastYmd: string,
  apiKey: string
): Promise<{ date: string; clpPerEur: number }[]> {
  const [y, mo, d] = lastYmd.split("-").map((x) => parseInt(x, 10));
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) {
    throw new Error(`Invalid lastYmd: ${lastYmd}`);
  }
  const url = `${SBIF_RECURSOS_BASE}/euro/posteriores/${y}/${String(mo).padStart(2, "0")}/dias/${String(d).padStart(2, "0")}?apikey=${encodeURIComponent(apiKey)}&formato=json`;
  const body = await fetchSbifJson(url);
  const leaves: FechaValor[] = [];
  collectFechaValorLeaves(body, leaves);
  const rows: { date: string; value: number }[] = [];
  for (const { fecha, valor } of leaves) {
    const v = parseSbifNumber(valor);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || v == null || v <= 0) continue;
    rows.push({ date: fecha, value: v });
  }
  return dedupeByDate(rows).map((r) => ({ date: r.date, clpPerEur: r.value }));
}

/** UF for calendar dates strictly after `lastYmd` (use last row in `uf_daily`). */
export async function fetchUfAfterDate(lastYmd: string, apiKey: string): Promise<{ date: string; clpPerUf: number }[]> {
  const [y, mo, d] = lastYmd.split("-").map((x) => parseInt(x, 10));
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) {
    throw new Error(`Invalid lastYmd: ${lastYmd}`);
  }
  const url = `${SBIF_RECURSOS_BASE}/uf/posteriores/${y}/${String(mo).padStart(2, "0")}/dias/${String(d).padStart(2, "0")}?apikey=${encodeURIComponent(apiKey)}&formato=json`;
  const body = await fetchSbifJson(url);
  const leaves: FechaValor[] = [];
  collectFechaValorLeaves(body, leaves);
  const rows: { date: string; value: number }[] = [];
  for (const { fecha, valor } of leaves) {
    const v = parseSbifNumber(valor);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || v == null || v <= 0) continue;
    rows.push({ date: fecha, value: v });
  }
  return dedupeByDate(rows).map((r) => ({ date: r.date, clpPerUf: r.value }));
}

/** UTM months strictly after `lastMonthStartYmd` (first day of month, `utm_daily` convention). */
export async function fetchUtmAfterMonth(lastMonthY: number, lastMonthM: number, apiKey: string): Promise<{ date: string; utmClp: number }[]> {
  const url = `${SBIF_RECURSOS_BASE}/utm/posteriores/${lastMonthY}/${String(lastMonthM).padStart(2, "0")}?apikey=${encodeURIComponent(apiKey)}&formato=json`;
  const body = await fetchSbifJson(url);
  const leaves: FechaValor[] = [];
  collectFechaValorLeaves(body, leaves);
  const rows: { date: string; value: number }[] = [];
  for (const { fecha, valor } of leaves) {
    const v = parseSbifNumber(valor);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || v == null || v <= 0) continue;
    rows.push({ date: fecha, value: v });
  }
  return dedupeByDate(rows).map((r) => ({ date: r.date, utmClp: r.value }));
}

/**
 * IPC monthly from SBIF. Values must look like INE **index levels** (typically ≫ 10); if the API returns
 * month-over-month % instead, rows are skipped with a warning.
 */
export async function fetchIpcAfterMonth(
  lastMonthY: number,
  lastMonthM: number,
  apiKey: string
): Promise<{ date: string; ipcIndex: number }[]> {
  const url = `${SBIF_RECURSOS_BASE}/ipc/posteriores/${lastMonthY}/${String(lastMonthM).padStart(2, "0")}?apikey=${encodeURIComponent(apiKey)}&formato=json`;
  const body = await fetchSbifJson(url);
  const leaves: FechaValor[] = [];
  collectFechaValorLeaves(body, leaves);
  const rows: { date: string; value: number }[] = [];
  for (const { fecha, valor } of leaves) {
    const v = parseSbifNumber(valor);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || v == null || v <= 0) continue;
    rows.push({ date: fecha, value: v });
  }
  const deduped = dedupeByDate(rows);
  if (deduped.length && Math.max(...deduped.map((r) => r.value)) < 15) {
    console.warn(
      "sbif: IPC values look like % variation, not index level — skipping ipc_daily upsert (use cfraser/ipc-index.csv for INE index)."
    );
    return [];
  }
  return deduped.map((r) => ({ date: r.date, ipcIndex: r.value }));
}

/** One calendar year of daily dólar observado (backfill / catch-up). */
export async function fetchDolarYear(
  year: number,
  apiKey: string
): Promise<{ date: string; clpPerUsd: number }[]> {
  const url = `${SBIF_RECURSOS_BASE}/dolar/${year}?apikey=${encodeURIComponent(apiKey)}&formato=json`;
  const body = await fetchSbifJson(url);
  const leaves: FechaValor[] = [];
  collectFechaValorLeaves(body, leaves);
  const rows: { date: string; value: number }[] = [];
  for (const { fecha, valor } of leaves) {
    const v = parseSbifNumber(valor);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || v == null || v <= 0) continue;
    rows.push({ date: fecha, value: v });
  }
  return dedupeByDate(rows).map((r) => ({ date: r.date, clpPerUsd: r.value }));
}

/** One calendar year of daily euro observado (backfill / catch-up). */
export async function fetchEuroYear(
  year: number,
  apiKey: string
): Promise<{ date: string; clpPerEur: number }[]> {
  const url = `${SBIF_RECURSOS_BASE}/euro/${year}?apikey=${encodeURIComponent(apiKey)}&formato=json`;
  const body = await fetchSbifJson(url);
  const leaves: FechaValor[] = [];
  collectFechaValorLeaves(body, leaves);
  const rows: { date: string; value: number }[] = [];
  for (const { fecha, valor } of leaves) {
    const v = parseSbifNumber(valor);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || v == null || v <= 0) continue;
    rows.push({ date: fecha, value: v });
  }
  return dedupeByDate(rows).map((r) => ({ date: r.date, clpPerEur: r.value }));
}

/** One calendar year of daily UF (backfill / catch-up). */
export async function fetchUfYear(year: number, apiKey: string): Promise<{ date: string; clpPerUf: number }[]> {
  const url = `${SBIF_RECURSOS_BASE}/uf/${year}?apikey=${encodeURIComponent(apiKey)}&formato=json`;
  const body = await fetchSbifJson(url);
  const leaves: FechaValor[] = [];
  collectFechaValorLeaves(body, leaves);
  const rows: { date: string; value: number }[] = [];
  for (const { fecha, valor } of leaves) {
    const v = parseSbifNumber(valor);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || v == null || v <= 0) continue;
    rows.push({ date: fecha, value: v });
  }
  return dedupeByDate(rows).map((r) => ({ date: r.date, clpPerUf: r.value }));
}

export async function fetchUtmYear(year: number, apiKey: string): Promise<{ date: string; utmClp: number }[]> {
  const url = `${SBIF_RECURSOS_BASE}/utm/${year}?apikey=${encodeURIComponent(apiKey)}&formato=json`;
  const body = await fetchSbifJson(url);
  const leaves: FechaValor[] = [];
  collectFechaValorLeaves(body, leaves);
  const rows: { date: string; value: number }[] = [];
  for (const { fecha, valor } of leaves) {
    const v = parseSbifNumber(valor);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || v == null || v <= 0) continue;
    rows.push({ date: fecha, value: v });
  }
  return dedupeByDate(rows).map((r) => ({ date: r.date, utmClp: r.value }));
}

export async function fetchIpcYear(year: number, apiKey: string): Promise<{ date: string; ipcIndex: number }[]> {
  const url = `${SBIF_RECURSOS_BASE}/ipc/${year}?apikey=${encodeURIComponent(apiKey)}&formato=json`;
  const body = await fetchSbifJson(url);
  const leaves: FechaValor[] = [];
  collectFechaValorLeaves(body, leaves);
  const rows: { date: string; value: number }[] = [];
  for (const { fecha, valor } of leaves) {
    const v = parseSbifNumber(valor);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || v == null || v <= 0) continue;
    rows.push({ date: fecha, value: v });
  }
  const deduped = dedupeByDate(rows);
  if (deduped.length && Math.max(...deduped.map((r) => r.value)) < 15) {
    console.warn(`sbif: IPC year ${year} values look like % not index — skipping`);
    return [];
  }
  return deduped.map((r) => ({ date: r.date, ipcIndex: r.value }));
}
