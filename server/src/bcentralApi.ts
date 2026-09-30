/**
 * Banco Central de Chile — Base de Datos Estadísticos (BDE) REST API.
 * @see https://si3.bcentral.cl/estadisticas/Principal1/Web_Services/doc_es.htm
 *
 * Env: `BCENTRAL_EMAIL`, `BCENTRAL_PASSWORD` (repo-root `.env`).
 */
import { BCENTRAL_IPC_SERIES, BCENTRAL_SERIES } from "./bcentralSeries.js";
import { parseUsNumber } from "./chileanNumber.js";
import { nextIpcMonth, verifyIpcIndexAgainstVariation, type IpcIndexRow, type IpcObservation } from "./ipcSeries.js";
import { fetchOut } from "./httpOut.js";
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
    const res = await fetchOut("bcentral", url, {
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

/**
 * A plain-decimal series (the IPC analíticos print «68.13588542», «-0.0207»), read with the one
 * parser that style needs. Unlike {@link fetchBcentralSeries} nothing is skipped: an observation
 * that is not «OK», has no date, or does not parse throws.
 */
async function fetchBcentralPlainDecimalSeries(
  creds: BcentralCredentials,
  timeseries: string,
  firstdate: string,
  lastdate: string
): Promise<IpcObservation[]> {
  const url = buildUrl(creds, { function: "GetSeries", timeseries, firstdate, lastdate });
  const body = (await fetchBcentralJson(url)) as GetSeriesBody;
  const rows: IpcObservation[] = [];
  for (const obs of normalizeObs(body)) {
    const date = obs.indexDateString ? bcentralIndexDateToYmd(obs.indexDateString) : null;
    if (!date) throw new Error(`BCentral ${timeseries}: observation without a date (${JSON.stringify(obs)})`);
    if (obs.statusCode !== "OK" || obs.value == null) {
      throw new Error(`BCentral ${timeseries} ${date}: status ${obs.statusCode ?? "missing"}, value ${obs.value ?? "missing"}`);
    }
    rows.push({ date, value: parseUsNumber(obs.value) });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * IPC index rows from `fromMonthYmd` (a first-of-month date, included — the month the first
 * variation is measured from) through `lastdateYmd`, each month checked against the published
 * monthly variation ({@link verifyIpcIndexAgainstVariation}).
 */
export async function fetchIpcMonthsVerified(
  creds: BcentralCredentials,
  fromMonthYmd: string,
  lastdateYmd: string
): Promise<IpcIndexRow[]> {
  const index = await fetchBcentralPlainDecimalSeries(creds, BCENTRAL_IPC_SERIES.index, fromMonthYmd, lastdateYmd);
  if (index.length === 0 || index[0]!.date !== fromMonthYmd) {
    throw new Error(`BCentral IPC: no index for ${fromMonthYmd} (first returned: ${index[0]?.date ?? "none"})`);
  }
  // A monthly series returns the month a date falls in, so the variation starts at the next month.
  const variationFrom = nextIpcMonth(fromMonthYmd);
  const variation =
    index.length > 1
      ? await fetchBcentralPlainDecimalSeries(creds, BCENTRAL_IPC_SERIES.variation, variationFrom, lastdateYmd)
      : [];
  return verifyIpcIndexAgainstVariation(index, variation);
}
