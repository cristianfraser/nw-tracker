/**
 * Banco Central de Chile — Base de Datos Estadísticos (BDE) REST API.
 * @see https://si3.bcentral.cl/estadisticas/Principal1/Web_Services/doc_es.htm
 *
 * Env: `BCENTRAL_EMAIL`, `BCENTRAL_PASSWORD` (repo-root `.env`).
 */
import { BCENTRAL_SERIES } from "./bcentralSeries.js";
import {
  acquireSbifRequestSlot,
  recordSbifRequestFailure,
  recordSbifRequestSuccess,
} from "./sbifApiGate.js";

export const BCENTRAL_WS_BASE = "https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx";

export type BcentralCredentials = {
  email: string;
  password: string;
};

export function loadBcentralCredentials(): BcentralCredentials | null {
  const email = process.env.BCENTRAL_EMAIL?.trim();
  const password = process.env.BCENTRAL_PASSWORD?.trim();
  if (!email || !password) return null;
  return { email, password };
}

export function isBcentralConfigured(): boolean {
  return loadBcentralCredentials() != null;
}

type BcentralObs = {
  indexDateString?: string;
  value?: string;
  statusCode?: string;
};

type GetSeriesBody = {
  Codigo?: number;
  Descripcion?: string;
  Series?: { Obs?: BcentralObs | BcentralObs[] };
  SeriesInfos?: unknown;
};

export type BcentralSeriesInfo = {
  seriesId: string;
  frequencyCode: string;
  spanishTitle: string;
};

/**
 * BCentral observation values: usually Chilean (`1.234,56`), but USD/EUR sometimes arrive
 * with a dot decimal (`899.68`). Treating that dot as thousands inflates ~900 → ~90000.
 */
export function parseBcentralNumber(raw: string): number | null {
  const t = raw.trim();
  if (!t || /^neun$/i.test(t)) return null;

  if (t.includes(",")) {
    const n = Number(t.replace(/\./g, "").replace(/,/g, "."));
    return Number.isFinite(n) ? n : null;
  }

  if (t.includes(".")) {
    const parts = t.split(".");
    if (parts.length === 2 && parts[1] != null && parts[1].length <= 2) {
      const n = Number(t);
      return Number.isFinite(n) ? n : null;
    }
    const n = Number(t.replace(/\./g, ""));
    return Number.isFinite(n) ? n : null;
  }

  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** BDE `indexDateString` (DD-MM-YYYY) → ISO YYYY-MM-DD. */
export function bcentralIndexDateToYmd(indexDateString: string): string | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(indexDateString.trim());
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function addCalendarDaysIso(ymd: string, delta: number): string {
  const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!p) return ymd;
  const t = Date.UTC(Number(p[1]), Number(p[2]) - 1, Number(p[3]) + delta, 12, 0, 0, 0);
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function buildUrl(creds: BcentralCredentials, params: Record<string, string>): string {
  const u = new URL(BCENTRAL_WS_BASE);
  u.searchParams.set("user", creds.email);
  u.searchParams.set("pass", creds.password);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

export async function fetchBcentralJson(url: string): Promise<unknown> {
  await acquireSbifRequestSlot();
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "nw-tracker-bcentral/1.0" },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`BCentral HTTP ${res.status}: ${text.slice(0, 500)}`);
    try {
      const body = JSON.parse(text) as unknown;
      recordSbifRequestSuccess();
      return body;
    } catch {
      throw new Error(`BCentral JSON parse error: ${text.slice(0, 200)}`);
    }
  } catch (e) {
    recordSbifRequestFailure(e);
    throw e;
  }
}

export function isBcentralNoDataError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    msg.includes("no hay datos") ||
    msg.includes("sin observaciones") ||
    msg.includes("codigo\":1") ||
    msg.includes("series not found")
  );
}

function normalizeObs(body: GetSeriesBody): BcentralObs[] {
  const codigo = body.Codigo;
  if (codigo != null && codigo !== 0) {
    throw new Error(`BCentral GetSeries error ${codigo}: ${body.Descripcion ?? "unknown"}`);
  }
  const raw = body.Series?.Obs;
  if (raw == null) return [];
  return Array.isArray(raw) ? raw : [raw];
}

export async function fetchBcentralSeries(
  creds: BcentralCredentials,
  timeseries: string,
  firstdate: string,
  lastdate: string
): Promise<{ date: string; value: number }[]> {
  const url = buildUrl(creds, {
    function: "GetSeries",
    timeseries,
    firstdate,
    lastdate,
  });
  const body = (await fetchBcentralJson(url)) as GetSeriesBody;
  const rows: { date: string; value: number }[] = [];
  for (const obs of normalizeObs(body)) {
    if (obs.statusCode && obs.statusCode !== "OK") continue;
    const date = obs.indexDateString ? bcentralIndexDateToYmd(obs.indexDateString) : null;
    const v = obs.value != null ? parseBcentralNumber(obs.value) : null;
    if (!date || v == null || v <= 0) continue;
    rows.push({ date, value: v });
  }
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.date, r.value);
  return [...m.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchBcentralSearchSeries(
  creds: BcentralCredentials,
  frequency: "DAILY" | "MONTHLY" | "QUARTERLY" | "ANNUAL"
): Promise<BcentralSeriesInfo[]> {
  const url = buildUrl(creds, { function: "SearchSeries", frequency });
  const body = (await fetchBcentralJson(url)) as {
    Codigo?: number;
    Descripcion?: string;
    SeriesInfos?: Array<{
      seriesId?: string;
      frequencyCode?: string;
      spanishTitle?: string;
    }>;
  };
  if (body.Codigo != null && body.Codigo !== 0) {
    throw new Error(`BCentral SearchSeries error ${body.Codigo}: ${body.Descripcion ?? "unknown"}`);
  }
  const infos = body.SeriesInfos ?? [];
  return infos
    .filter((x) => typeof x.seriesId === "string" && x.seriesId.length > 0)
    .map((x) => ({
      seriesId: x.seriesId!,
      frequencyCode: String(x.frequencyCode ?? ""),
      spanishTitle: String(x.spanishTitle ?? ""),
    }));
}

async function fetchSeriesAfterYmd(
  creds: BcentralCredentials,
  timeseries: string,
  lastYmd: string,
  lastdateYmd: string
): Promise<{ date: string; value: number }[]> {
  const firstdate = addCalendarDaysIso(lastYmd, 1);
  if (firstdate.localeCompare(lastdateYmd) > 0) return [];
  return fetchBcentralSeries(creds, timeseries, firstdate, lastdateYmd);
}

export async function fetchDolarAfterDate(
  lastYmd: string,
  creds: BcentralCredentials,
  lastdateYmd?: string
): Promise<{ date: string; clpPerUsd: number }[]> {
  const end = lastdateYmd ?? lastYmd.slice(0, 4) + "-12-31";
  const rows = await fetchSeriesAfterYmd(creds, BCENTRAL_SERIES.usd, lastYmd, end);
  return rows.map((r) => ({ date: r.date, clpPerUsd: r.value }));
}

export async function fetchEuroAfterDate(
  lastYmd: string,
  creds: BcentralCredentials,
  lastdateYmd?: string
): Promise<{ date: string; clpPerEur: number }[]> {
  const end = lastdateYmd ?? lastYmd.slice(0, 4) + "-12-31";
  const rows = await fetchSeriesAfterYmd(creds, BCENTRAL_SERIES.eur, lastYmd, end);
  return rows.map((r) => ({ date: r.date, clpPerEur: r.value }));
}

export async function fetchUfAfterDate(
  lastYmd: string,
  creds: BcentralCredentials,
  lastdateYmd?: string
): Promise<{ date: string; clpPerUf: number }[]> {
  const end = lastdateYmd ?? lastYmd.slice(0, 4) + "-12-31";
  const rows = await fetchSeriesAfterYmd(creds, BCENTRAL_SERIES.uf, lastYmd, end);
  return rows.map((r) => ({ date: r.date, clpPerUf: r.value }));
}

export async function fetchUtmAfterMonth(
  lastMonthY: number,
  lastMonthM: number,
  creds: BcentralCredentials,
  lastdateYmd?: string
): Promise<{ date: string; utmClp: number }[]> {
  const anchor = `${lastMonthY}-${String(lastMonthM).padStart(2, "0")}-01`;
  const end = lastdateYmd ?? `${lastMonthY + 1}-12-31`;
  const rows = await fetchSeriesAfterYmd(creds, BCENTRAL_SERIES.utm, anchor, end);
  return rows.map((r) => ({ date: r.date, utmClp: r.value }));
}

export async function fetchIpcAfterMonth(
  lastMonthY: number,
  lastMonthM: number,
  creds: BcentralCredentials,
  lastdateYmd?: string
): Promise<{ date: string; ipcIndex: number }[]> {
  const anchor = `${lastMonthY}-${String(lastMonthM).padStart(2, "0")}-01`;
  const end = lastdateYmd ?? `${lastMonthY + 1}-12-31`;
  const rows = await fetchSeriesAfterYmd(creds, BCENTRAL_SERIES.ipc, anchor, end);
  const deduped = rows;
  if (deduped.length && Math.max(...deduped.map((r) => r.value)) < 15) {
    console.warn(
      "bcentral: IPC values look like % variation, not index level — skipping ipc_daily upsert (use cfraser/ipc-index.csv for INE index)."
    );
    return [];
  }
  return deduped.map((r) => ({ date: r.date, ipcIndex: r.value }));
}

export async function fetchDolarYear(
  year: number,
  creds: BcentralCredentials
): Promise<{ date: string; clpPerUsd: number }[]> {
  const rows = await fetchBcentralSeries(creds, BCENTRAL_SERIES.usd, `${year}-01-01`, `${year}-12-31`);
  return rows.map((r) => ({ date: r.date, clpPerUsd: r.value }));
}

export async function fetchEuroYear(
  year: number,
  creds: BcentralCredentials
): Promise<{ date: string; clpPerEur: number }[]> {
  const rows = await fetchBcentralSeries(creds, BCENTRAL_SERIES.eur, `${year}-01-01`, `${year}-12-31`);
  return rows.map((r) => ({ date: r.date, clpPerEur: r.value }));
}

export async function fetchUfYear(
  year: number,
  creds: BcentralCredentials
): Promise<{ date: string; clpPerUf: number }[]> {
  const rows = await fetchBcentralSeries(creds, BCENTRAL_SERIES.uf, `${year}-01-01`, `${year}-12-31`);
  return rows.map((r) => ({ date: r.date, clpPerUf: r.value }));
}

export async function fetchUtmYear(
  year: number,
  creds: BcentralCredentials
): Promise<{ date: string; utmClp: number }[]> {
  const rows = await fetchBcentralSeries(creds, BCENTRAL_SERIES.utm, `${year}-01-01`, `${year}-12-31`);
  return rows.map((r) => ({ date: r.date, utmClp: r.value }));
}

export async function fetchIpcYear(
  year: number,
  creds: BcentralCredentials
): Promise<{ date: string; ipcIndex: number }[]> {
  const rows = await fetchBcentralSeries(creds, BCENTRAL_SERIES.ipc, `${year}-01-01`, `${year}-12-31`);
  if (rows.length && Math.max(...rows.map((r) => r.value)) < 15) {
    console.warn(`bcentral: IPC year ${year} values look like % not index — skipping`);
    return [];
  }
  return rows.map((r) => ({ date: r.date, ipcIndex: r.value }));
}
