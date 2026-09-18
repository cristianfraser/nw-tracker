/**
 * Fintual's OFFICIAL daily valor cuota per fund serie, from the public, unauthenticated
 * endpoint the fund pages on fintual.cl read (`GET /api/managed_funds/serie/share_price`
 * on `inversiones.fintual.com`, `[{ id, managed_fund_serie, date, value }]`, history since
 * each serie's inception, weekend/holiday days included).
 *
 * The endpoint publishes day D on D+1 — never on the evening of D — so it cannot serve the
 * evening write (`scripts/fintualRealAssetNav.ts` prices that from Fintual's own share count).
 * It is the next-day verifier and healer: every poll re-reads the last
 * `FINTUAL_PUBLIC_SERIE_VERIFY_WINDOW_DAYS`, fills days no poll wrote, replaces carry-forward
 * placeholders, and CORRECTS a stored bar that disagrees beyond `FINTUAL_PUBLIC_SERIE_TOLERANCE_REL`
 * — loudly, as a sync error, since a correction means the evening derivation was wrong. It also
 * keeps a series current whose goal is empty (no evening publish, e.g. Risky Norris serie A,
 * the RN proxy anchor).
 *
 * Serie ids come from the `FINTUAL_MANAGED_FUNDS` table in the public fund-page bundle and were
 * verified value-for-value against 20 months of stored bars on 2026-09-17: max deviation 6,4e-5
 * (weekend restatements), everything else exact to the 4th decimal.
 */
import { db } from "./db.js";
import { FINTUAL_CERT_V2_ACCOUNT_NAMES, fintualCertV2SeriesKeyFromImportNotes } from "./fintualCertV2.js";
import { isFintualCarryForwardFundUnitNote } from "./fintualFundUnitDaily.js";
import { formatSyncIndex, type SyncFieldChange, type SyncStepError } from "./syncRunLog.js";

export const FINTUAL_PUBLIC_SERIE_PRICE_URL =
  "https://inversiones.fintual.com/api/managed_funds/serie/share_price";

/** `fund_unit_daily.series_key` → public `managed_fund_serie` id. */
export const FINTUAL_PUBLIC_SERIE_BY_SERIES_KEY: Readonly<Record<string, number>> = {
  /** Very Conservative Streep, serie A. */
  fintual_cert_reserva2: 1,
  /** Risky Norris, serie APV — the fund both APV goals hold. */
  fintual_cert_apv_a: 7,
  fintual_cert_apv_b: 7,
  /** Risky Norris, serie A. */
  fintual_cert_risky_norris: 6,
};

/** Max |stored − official| ÷ official before a stored bar counts as wrong (noise tops at 6,4e-5). */
export const FINTUAL_PUBLIC_SERIE_TOLERANCE_REL = 1e-4;
/** How far back every poll re-verifies (covers a week of missed polls plus the publish lag). */
export const FINTUAL_PUBLIC_SERIE_VERIFY_WINDOW_DAYS = 14;
export const FINTUAL_PUBLIC_SERIE_NOTE_PREFIX = "fintual:public-serie:publish";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export type FintualPublicSeriePriceRow = { day: string; valueClp: number };

/** Parse the endpoint's JSON body; throws on any shape violation or a row of another serie. */
export function parseFintualPublicSeriePrices(body: unknown, serieId: number): FintualPublicSeriePriceRow[] {
  if (!Array.isArray(body)) {
    throw new Error(`Fintual public serie ${serieId}: expected an array, got ${JSON.stringify(body).slice(0, 200)}`);
  }
  const out: FintualPublicSeriePriceRow[] = [];
  const seen = new Set<string>();
  for (const item of body) {
    if (!item || typeof item !== "object") {
      throw new Error(`Fintual public serie ${serieId}: row is not an object`);
    }
    const o = item as Record<string, unknown>;
    const serie = Number(o.managed_fund_serie);
    if (serie !== serieId) {
      throw new Error(`Fintual public serie ${serieId}: row belongs to serie ${String(o.managed_fund_serie)}`);
    }
    const day = typeof o.date === "string" ? o.date : "";
    if (!YMD_RE.test(day)) throw new Error(`Fintual public serie ${serieId}: bad date ${String(o.date)}`);
    const value = typeof o.value === "number" ? o.value : Number(o.value);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Fintual public serie ${serieId}: bad value ${String(o.value)} on ${day}`);
    }
    if (seen.has(day)) throw new Error(`Fintual public serie ${serieId}: duplicate day ${day}`);
    seen.add(day);
    out.push({ day, valueClp: value });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

export async function fetchFintualPublicSeriePrices(
  serieId: number,
  fromYmd: string,
  toYmd: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number }
): Promise<Map<string, number>> {
  if (!YMD_RE.test(fromYmd) || !YMD_RE.test(toYmd)) {
    throw new Error(`Fintual public serie ${serieId}: bad window ${fromYmd}..${toYmd}`);
  }
  const url =
    `${FINTUAL_PUBLIC_SERIE_PRICE_URL}?fund_serie=${encodeURIComponent(String(serieId))}` +
    `&start_date=${fromYmd}&end_date=${toYmd}`;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const res = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": "nw-tracker/1.0 (+fintual official serie price)" },
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 20_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Fintual public serie ${serieId}: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Fintual public serie ${serieId}: non-JSON body ${text.slice(0, 200)}`);
  }
  return new Map(parseFintualPublicSeriePrices(body, serieId).map((r) => [r.day, r.valueClp]));
}

export type FintualSerieReconcileAction = "filled" | "carry_replaced" | "corrected";

export type FintualSerieReconcileRow = {
  day: string;
  storedClp: number | null;
  storedNote: string | null;
  officialClp: number;
  action: FintualSerieReconcileAction;
};

export type FintualSerieReconcileResult = {
  seriesKey: string;
  serieId: number;
  /** Official days looked at. */
  checked: number;
  /** Stored published bars within tolerance (left untouched). */
  agreed: number;
  rows: FintualSerieReconcileRow[];
};

const stmtGetBar = db.prepare(
  `SELECT unit_value_clp, COALESCE(note, '') AS note FROM fund_unit_daily WHERE series_key = ? AND day = ?`
);
const stmtUpsertBar = db.prepare(
  `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note) VALUES (?, ?, ?, ?)
   ON CONFLICT(series_key, day) DO UPDATE SET unit_value_clp = excluded.unit_value_clp, note = excluded.note`
);

/**
 * Bring one series in line with the official prices for the days they cover: fill absent
 * days, replace carry-forward placeholders, correct published bars beyond tolerance. Bars
 * within tolerance keep their value and provenance.
 */
export function reconcileFundUnitSeriesWithOfficialPrices(opts: {
  seriesKey: string;
  serieId: number;
  official: ReadonlyMap<string, number>;
  dryRun: boolean;
}): FintualSerieReconcileResult {
  const note = `${FINTUAL_PUBLIC_SERIE_NOTE_PREFIX}|serie=${opts.serieId}`;
  const rows: FintualSerieReconcileRow[] = [];
  let checked = 0;
  let agreed = 0;
  for (const day of [...opts.official.keys()].sort()) {
    const officialRaw = opts.official.get(day);
    if (officialRaw == null || !(officialRaw > 0)) continue;
    const officialClp = Math.round(officialRaw * 10000) / 10000;
    checked += 1;
    const existing = stmtGetBar.get(opts.seriesKey, day) as
      | { unit_value_clp: number; note: string }
      | undefined;
    let action: FintualSerieReconcileAction;
    if (!existing) {
      action = "filled";
    } else if (isFintualCarryForwardFundUnitNote(existing.note)) {
      action = "carry_replaced";
    } else {
      const rel = Math.abs(existing.unit_value_clp - officialClp) / officialClp;
      if (rel <= FINTUAL_PUBLIC_SERIE_TOLERANCE_REL) {
        agreed += 1;
        continue;
      }
      action = "corrected";
    }
    if (!opts.dryRun) stmtUpsertBar.run(opts.seriesKey, day, officialClp, note);
    rows.push({
      day,
      storedClp: existing?.unit_value_clp ?? null,
      storedNote: existing?.note ?? null,
      officialClp,
      action,
    });
  }
  return { seriesKey: opts.seriesKey, serieId: opts.serieId, checked, agreed, rows };
}

/** Fetch the official prices for `[fromYmd, toYmd]` and reconcile every mapped series. */
export async function verifyFintualSeriesAgainstOfficialPrices(opts: {
  fromYmd: string;
  toYmd: string;
  dryRun: boolean;
  seriesKeys?: readonly string[];
  fetchImpl?: typeof fetch;
}): Promise<FintualSerieReconcileResult[]> {
  const keys = opts.seriesKeys ?? Object.keys(FINTUAL_PUBLIC_SERIE_BY_SERIES_KEY);
  const officialBySerie = new Map<number, Map<string, number>>();
  const results: FintualSerieReconcileResult[] = [];
  for (const seriesKey of keys) {
    const serieId = FINTUAL_PUBLIC_SERIE_BY_SERIES_KEY[seriesKey];
    if (serieId == null) throw new Error(`Fintual public serie: no serie id mapped for ${seriesKey}`);
    let official = officialBySerie.get(serieId);
    if (!official) {
      official = await fetchFintualPublicSeriePrices(serieId, opts.fromYmd, opts.toYmd, {
        fetchImpl: opts.fetchImpl,
      });
      officialBySerie.set(serieId, official);
    }
    results.push(reconcileFundUnitSeriesWithOfficialPrices({ seriesKey, serieId, official, dryRun: opts.dryRun }));
  }
  return results;
}

const SERIES_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(FINTUAL_CERT_V2_ACCOUNT_NAMES).flatMap(([notes, name]) => {
    const key = fintualCertV2SeriesKeyFromImportNotes(notes);
    return key ? [[key, name]] : [];
  })
);

export function fintualSeriesLabel(seriesKey: string): string {
  return SERIES_LABELS[seriesKey] ?? seriesKey;
}

/** Sync-log change lines for every bar the verifier wrote (a relabelled equal carry is silent). */
export function fintualOfficialSerieSyncChanges(results: readonly FintualSerieReconcileResult[]): SyncFieldChange[] {
  const out: SyncFieldChange[] = [];
  for (const r of results) {
    for (const row of r.rows) {
      if (
        row.action === "carry_replaced" &&
        row.storedClp != null &&
        Math.abs(row.storedClp - row.officialClp) <= 0.00005
      ) {
        continue;
      }
      out.push({
        group: "fintual",
        label: `${fintualSeriesLabel(r.seriesKey)} (valor cuota oficial${row.action === "corrected" ? " · corregido" : ""})`,
        oldValue: row.storedClp != null ? formatSyncIndex(row.storedClp) : "—",
        newValue: formatSyncIndex(row.officialClp),
        oldDate: row.storedClp != null ? row.day : null,
        newDate: row.day,
      });
    }
  }
  return out;
}

/** A corrected published bar is an evening-derivation bug: surface each one as a step error. */
export function fintualOfficialSerieCorrectionErrors(results: readonly FintualSerieReconcileResult[]): SyncStepError[] {
  const out: SyncStepError[] = [];
  for (const r of results) {
    for (const row of r.rows) {
      if (row.action !== "corrected" || row.storedClp == null) continue;
      const relPct = ((row.storedClp - row.officialClp) / row.officialClp) * 100;
      out.push({
        step: "Fintual",
        message:
          `${fintualSeriesLabel(r.seriesKey)} ${row.day}: stored valor cuota ${formatSyncIndex(row.storedClp)}` +
          ` (${row.storedNote ?? "no note"}) corrected to the official ${formatSyncIndex(row.officialClp)}` +
          ` (${relPct >= 0 ? "+" : ""}${relPct.toFixed(3)}%)`,
      });
    }
  }
  return out;
}
