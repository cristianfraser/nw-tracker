import { assertValuationCurrencyClp } from "./valuationValue.js";
import { accountKindSlugForAccountId } from "./accountBucket.js";
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { AFP_UNO_CUOTA_SERIES_KEY } from "./afpUnoSeries.js";
import { transferLegUnitsThroughDate } from "./movementTransfer.js";
import { cuotaLedgerSeriesKeyForAccount, isCuotaLedgerKindSlug } from "./cuotaLedgerAccounts.js";

/**
 * Cumulative AFP cuotas: Σ `movements.units_delta` on the account plus manual transfer legs.
 * The cuota ledger is cert-backed and reconciled (Σ equals the official AFP website total,
 * including the one small historical reconcile correction, itself a movement). A wrong sum
 * is data to fix in the ledger — no target snapping or note-filtered fallbacks.
 */
export function afpCuotasCumulativeThroughDate(accountId: number, asOfYmd: string): number {
  const manual = transferLegUnitsThroughDate(accountId, asOfYmd);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(units_delta, 0)), 0) AS u
       FROM movements
       WHERE account_id = ? AND date(occurred_on) <= date(?)`
    )
    .get(accountId, asOfYmd) as { u: number };
  return Math.round(((row?.u ?? 0) + manual) * 10000) / 10000;
}

export function latestFundUnitRowOnOrBefore(
  seriesKey: string,
  asOfYmd: string
): { day: string; unit_value_clp: number } | null {
  const r = db
    .prepare(
      `SELECT day, unit_value_clp FROM fund_unit_daily
       WHERE series_key = ? AND day <= ?
       ORDER BY day DESC LIMIT 1`
    )
    .get(seriesKey, asOfYmd) as { day: string; unit_value_clp: number } | undefined;
  const v = r?.unit_value_clp;
  if (v == null || !Number.isFinite(v) || v <= 0 || !r?.day) return null;
  return { day: r.day, unit_value_clp: v };
}

const AFP_CERT_FUND_UNIT_SCRATCH = "afp-cert:monto/cuotas_delta";

/**
 * Prefer a **quoted** valor cuota (the official series) over certificate scratch rows
 * (`monto/cuotas` per movement line can be wrong for display).
 */
export function latestAfpUnoFundUnitRowOnOrBeforeForDisplay(
  seriesKey: string,
  asOfYmd: string
): { day: string; unit_value_clp: number } | null {
  const rows = db
    .prepare(
      `SELECT day, unit_value_clp, COALESCE(note, '') AS note FROM fund_unit_daily
       WHERE series_key = ? AND day <= ?
       ORDER BY day DESC
       LIMIT 60`
    )
    .all(seriesKey, asOfYmd) as { day: string; unit_value_clp: number; note: string }[];
  for (const r of rows) {
    if (!r.note.includes(AFP_CERT_FUND_UNIT_SCRATCH)) {
      const v = r.unit_value_clp;
      if (v != null && Number.isFinite(v) && v > 0 && r.day) {
        return { day: r.day, unit_value_clp: v };
      }
    }
  }
  return latestFundUnitRowOnOrBefore(seriesKey, asOfYmd);
}

/** Prior reputable valor cuota strictly before `beforeDay` (skips cert scratch rows). */
export function priorAfpUnoFundUnitRowBeforeForDisplay(
  seriesKey: string,
  beforeDay: string
): { day: string; unit_value_clp: number } | null {
  const rows = db
    .prepare(
      `SELECT day, unit_value_clp, COALESCE(note, '') AS note FROM fund_unit_daily
       WHERE series_key = ? AND day < ?
       ORDER BY day DESC
       LIMIT 60`
    )
    .all(seriesKey, beforeDay) as { day: string; unit_value_clp: number; note: string }[];
  for (const r of rows) {
    if (!r.note.includes(AFP_CERT_FUND_UNIT_SCRATCH)) {
      const v = r.unit_value_clp;
      if (v != null && Number.isFinite(v) && v > 0 && r.day) {
        return { day: r.day, unit_value_clp: v };
      }
    }
  }
  return null;
}

export function latestFundUnitClpOnOrBefore(seriesKey: string, asOfYmd: string): number | null {
  return latestFundUnitRowOnOrBefore(seriesKey, asOfYmd)?.unit_value_clp ?? null;
}

export function revalueAfpAccountFromCuotas(opts: {
  accountId: number;
  seriesKey?: string;
  dryRun: boolean;
  /**
   * When true, only refresh `units_snapshot` from Σ cuotas; keep existing `value_clp` (e.g. Table 1-3 / Excel import).
   * Use when `fund_unit_daily` is for reference or you want sheet month-ends as SoT.
   */
  preserveExcelValues?: boolean;
}): { updated: number; skipped: number; lines: string[] } {
  const lines: string[] = [];
  let updated = 0;
  let skipped = 0;

  const kind = accountKindSlugForAccountId(opts.accountId);
  if (!isCuotaLedgerKindSlug(kind)) {
    throw new Error(`Account ${opts.accountId} is not a cuota-ledger kind (afp/afc; got ${kind ?? "missing"})`);
  }
  const seriesKeyAt = (ymd: string): string => {
    const key = opts.seriesKey ?? cuotaLedgerSeriesKeyForAccount(opts.accountId, kind!, ymd);
    if (!key) {
      throw new Error(`Account ${opts.accountId} (${kind}) has no fund_series_key — declare the series first`);
    }
    return key;
  };

  const vals = db
    .prepare(
      `SELECT as_of_date, value AS value_clp, currency, units_snapshot FROM valuations
       WHERE account_id = ? ORDER BY as_of_date ASC`
    )
    .all(opts.accountId) as { as_of_date: string; value_clp: number; currency: string; units_snapshot: number | null }[];
  for (const v of vals) assertValuationCurrencyClp(v.currency, "afpUnoValuation rebuild");

  const upsert = db.prepare(`
    INSERT INTO valuations (account_id, as_of_date, value, currency, units_snapshot)
    VALUES (@account_id, @as_of_date, @value_clp, 'clp', @units_snapshot)
    ON CONFLICT(account_id, as_of_date) DO UPDATE SET
      value = excluded.value,
      currency = excluded.currency,
      units_snapshot = excluded.units_snapshot
  `);

  const preserve = opts.preserveExcelValues === true;

  for (const v of vals) {
    const units = afpCuotasCumulativeThroughDate(opts.accountId, v.as_of_date);
    if (preserve) {
      lines.push(`${v.as_of_date}\tunits=${units.toFixed(4)}\tpreserve-value\tvalue_clp=${v.value_clp}`);
      if (!opts.dryRun) {
        upsert.run({
          account_id: opts.accountId,
          as_of_date: v.as_of_date,
          value_clp: v.value_clp,
          units_snapshot: units,
        });
      }
      updated += 1;
      continue;
    }

    const px = latestFundUnitClpOnOrBefore(seriesKeyAt(v.as_of_date), v.as_of_date);
    if (px == null || units <= 0) {
      lines.push(`${v.as_of_date}\tunits=${units.toFixed(4)}\tpx=—\tskip`);
      skipped += 1;
      continue;
    }
    const value_clp = Math.round(units * px * 100) / 100;
    lines.push(
      `${v.as_of_date}\tunits=${units.toFixed(4)}\tpx=${px.toFixed(2)}\tvalue=${value_clp}\tprev=${v.value_clp}`
    );
    if (!opts.dryRun) {
      upsert.run({
        account_id: opts.accountId,
        as_of_date: v.as_of_date,
        value_clp,
        units_snapshot: units,
      });
    }
    updated += 1;
  }

  return { updated, skipped, lines };
}

/** Mark-to-market AFP on Chile “today” (or `asOfYmd`) using latest valor cuota on or before that date. */
export function upsertAfpSpotValuation(opts: {
  accountId: number;
  asOfYmd?: string;
  seriesKey?: string;
  dryRun: boolean;
}): { as_of_date: string; value_clp: number; units: number; px: number } | null {
  const seriesKey = opts.seriesKey ?? AFP_UNO_CUOTA_SERIES_KEY;
  const asOf = opts.asOfYmd ?? chileCalendarTodayYmd();
  const px = latestFundUnitClpOnOrBefore(seriesKey, asOf);
  const units = afpCuotasCumulativeThroughDate(opts.accountId, asOf);
  if (px == null || units <= 0) return null;
  const value_clp = Math.round(units * px * 100) / 100;
  if (!opts.dryRun) {
    db.prepare(
      `INSERT INTO valuations (account_id, as_of_date, value, currency, units_snapshot)
       VALUES (?, ?, ?, 'clp', ?)
       ON CONFLICT(account_id, as_of_date) DO UPDATE SET
         value = excluded.value,
         currency = excluded.currency,
         units_snapshot = excluded.units_snapshot`
    ).run(opts.accountId, asOf, value_clp, units);
  }
  return { as_of_date: asOf, value_clp, units, px };
}

/**
 * Spot valuation at an explicit valor cuota (the display series' value shown on the day).
 */
export function upsertAfpSpotValuationWithExplicitPx(opts: {
  accountId: number;
  asOfYmd?: string;
  px: number;
  dryRun: boolean;
}): { as_of_date: string; value_clp: number; units: number; px: number } | null {
  const asOf = opts.asOfYmd ?? chileCalendarTodayYmd();
  const px = opts.px;
  if (!Number.isFinite(px) || px <= 0) return null;
  const units = afpCuotasCumulativeThroughDate(opts.accountId, asOf);
  if (units <= 0) return null;
  const value_clp = Math.round(units * px * 100) / 100;
  if (!opts.dryRun) {
    db.prepare(
      `INSERT INTO valuations (account_id, as_of_date, value, currency, units_snapshot)
       VALUES (?, ?, ?, 'clp', ?)
       ON CONFLICT(account_id, as_of_date) DO UPDATE SET
         value = excluded.value,
         currency = excluded.currency,
         units_snapshot = excluded.units_snapshot`
    ).run(opts.accountId, asOf, value_clp, units);
  }
  return { as_of_date: asOf, value_clp, units, px };
}
