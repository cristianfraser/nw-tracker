/**
 * Fetch AFP “valor cuota” from ¿Qué tal mi AFP? and upsert `fund_unit_daily`.
 * For long backfills (e.g. from 2018), use `backfillAfpUnoCuotaQuetalmiChunks` / `npm run afp:uno:backfill-quetalmiafp`.
 *
 * GET https://www.quetalmiafp.cl/api/Cuota/ObtenerCuotas
 * Headers: X-API-Key
 * Query: listaAFPs=UNO, listaFondos=A, fechaInicial, fechaFinal (dd/mm/yyyy)
 */

import { fetchOut } from "./httpOut.js";

export const AFP_UNO_CUOTA_SERIES_KEY = "afp_uno_cuota_a";

export function toDdMmYyyy(ymd: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return null;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

export function ymdFromDdMmYyyy(s: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

export type FundUnitRow = { day: string; unit_value_clp: number; note?: string | null };

/** Parse API / UI strings: `89607,97`, `89.607,97` (CLP), or plain `89607.97`. */
export function parseLocaleNumericString(raw: string): number | null {
  const s = raw.trim().replace(/\s/g, "");
  if (!s) return null;
  if (/^[-+]?(?:\d+)(?:\.\d+)?$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  if (/^[-+]?(?:\d+)(?:,\d+)?$/.test(s)) {
    const n = Number(s.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) {
    const normalized = s.replace(/\./g, "").replace(",", ".");
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
  }
  if (lastDot > lastComma) {
    const normalized = s.replace(/,/g, "");
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function pickNumber(o: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim()) {
      const n = parseLocaleNumericString(v);
      if (n != null && Number.isFinite(n)) return n;
    }
  }
  return null;
}

function pickDateStr(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) {
      const t = v.trim();
      const iso = /^(\d{4}-\d{2}-\d{2})/.exec(t);
      if (iso) return iso[1]!;
      const dm = ymdFromDdMmYyyy(t);
      if (dm) return dm;
    }
  }
  return null;
}

/** Keys that plausibly denote valor cuota in CLP (avoid generic `valor` / `cuota` — those often name other fields). */
const VALOR_CUOTA_KEYS = [
  "valorCuota",
  "ValorCuota",
  "valor_cuota",
  "valorCuotaCLP",
  "ValorCuotaCLP",
  "valorCuotaClp",
  "ValorCuotaClp",
  "valorCuotaPesos",
  "precioCuota",
  "PrecioCuota",
  "montoCuota",
];

function tryExtractFundUnitRow(o: Record<string, unknown>): FundUnitRow | null {
  const day =
    pickDateStr(o, ["fecha", "Fecha", "dia", "Dia", "day", "Day", "fechaValor", "fecha_valor"]) ??
    (typeof o.fecha === "string" ? ymdFromDdMmYyyy(o.fecha) : null);
  let unit = pickNumber(o, VALOR_CUOTA_KEYS);
  /** Quetalmi `ObtenerCuotas` rows: `{ afp, fondo, fecha, valor, valorUf }` — CLP is `valor` (not `valorCuota`). */
  if (
    unit == null &&
    typeof o.valor === "number" &&
    Number.isFinite(o.valor) &&
    o.valor > 0 &&
    (typeof o.afp === "string" || typeof o.fondo === "string")
  ) {
    unit = o.valor;
  }
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || unit == null || unit <= 0 || unit >= 1e9) return null;
  return { day, unit_value_clp: unit, note: "quetalmiafp:ObtenerCuotas" };
}

function mergeRowsByDay(candidates: FundUnitRow[]): FundUnitRow[] {
  const byDay = new Map<string, number[]>();
  for (const r of candidates) {
    const arr = byDay.get(r.day) ?? [];
    arr.push(r.unit_value_clp);
    byDay.set(r.day, arr);
  }
  const out: FundUnitRow[] = [];
  for (const [day, vals] of [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const rounded = vals.map((v) => Math.round(v * 100) / 100);
    const uniq = [...new Set(rounded)];
    if (uniq.length === 1) {
      out.push({ day, unit_value_clp: uniq[0]!, note: "quetalmiafp:ObtenerCuotas" });
      continue;
    }
    rounded.sort((a, b) => a - b);
    const mid = rounded[Math.floor(rounded.length / 2)]!;
    out.push({ day, unit_value_clp: mid, note: "quetalmiafp:ObtenerCuotas|dedup=median" });
  }
  return out;
}

/** Normalize heterogeneous API rows to `fund_unit_daily` rows. */
export function extractFundUnitRowsFromQuetalmiJson(body: unknown): FundUnitRow[] {
  const candidates: FundUnitRow[] = [];
  const seen = new WeakSet<object>();

  const walk = (node: unknown): void => {
    if (node == null) return;
    const t = typeof node;
    if (t === "number" || t === "string" || t === "boolean") return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (t !== "object") return;
    const o = node as Record<string, unknown>;
    if (seen.has(o)) return;
    seen.add(o);
    const row = tryExtractFundUnitRow(o);
    if (row) candidates.push(row);
    for (const v of Object.values(o)) walk(v);
  };

  walk(body);
  return mergeRowsByDay(candidates);
}

export async function fetchQuetalmiCuotas(params: {
  apiKey: string;
  listaAFPs: string;
  listaFondos: string;
  fechaInicialDdMmYyyy: string;
  fechaFinalDdMmYyyy: string;
}): Promise<unknown> {
  const u = new URL("https://www.quetalmiafp.cl/api/Cuota/ObtenerCuotas");
  u.searchParams.set("listaAFPs", params.listaAFPs);
  u.searchParams.set("listaFondos", params.listaFondos);
  u.searchParams.set("fechaInicial", params.fechaInicialDdMmYyyy);
  u.searchParams.set("fechaFinal", params.fechaFinalDdMmYyyy);
  const res = await fetchOut("quetalmiafp", u.toString(), {
    headers: {
      "X-API-Key": params.apiKey,
      Accept: "application/json",
      "User-Agent": "nw-tracker-afp-cuotas/1.0",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Quetalmi AFP HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Quetalmi AFP: response was not JSON (starts: ${text.slice(0, 120)}…)`);
  }
}
