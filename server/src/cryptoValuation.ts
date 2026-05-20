import { monthEndsBetweenInclusive, monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { cryptoSheetMovementDeltas, type CryptoSheetMonthMovement } from "./cryptoSheetUnits.js";
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { equityCloseUsdEod, equitySessionYmdForTicker, resolveEquityQuote } from "./equityQuote.js";
import { fxMonthEndForBalanceUsd } from "./fxRates.js";

export const CRYPTO_IMPORT_NOTE_SQL = `note LIKE '%import:excel|cripto-sheet|%'`;

export type CryptoAsset = "BTC" | "ETH";

export function cryptoAssetFromCategorySlug(slug: string): CryptoAsset | null {
  if (slug === "bitcoin") return "BTC";
  if (slug === "eth") return "ETH";
  return null;
}

export function cryptoEquityTickerForCategorySlug(slug: string): "BTC-USD" | "ETH-USD" | null {
  const a = cryptoAssetFromCategorySlug(slug);
  if (a === "BTC") return "BTC-USD";
  if (a === "ETH") return "ETH-USD";
  return null;
}

function categorySlugForAccount(accountId: number): string | null {
  const r = db
    .prepare(`SELECT c.slug FROM accounts a JOIN categories c ON c.id = a.category_id WHERE a.id = ?`)
    .get(accountId) as { slug: string } | undefined;
  return r?.slug ?? null;
}

export function cryptoEquityTickerForAccount(accountId: number): "BTC-USD" | "ETH-USD" | null {
  const slug = categorySlugForAccount(accountId);
  return slug ? cryptoEquityTickerForCategorySlug(slug) : null;
}

const stmtHasCryptoLedger = db.prepare(
  `SELECT 1 FROM movements WHERE account_id = ? AND ${CRYPTO_IMPORT_NOTE_SQL} LIMIT 1`
);

export function accountUsesCryptoMtm(accountId: number): boolean {
  if (!cryptoEquityTickerForAccount(accountId)) return false;
  return stmtHasCryptoLedger.get(accountId) != null;
}

const coinFromNoteRe = /coin=([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/;

function parseCoinUnitsFromNote(note: string | null): number | null {
  const m = note?.match(coinFromNoteRe);
  if (!m) return null;
  const qty = Number(m[1]);
  return Number.isFinite(qty) ? Math.abs(qty) : null;
}

/** Net coin through `asOfYmd` from ledger notes (legacy rows without `units_delta`). */
export function netCryptoCoinFromLedgerNotes(
  accountId: number,
  asset: CryptoAsset,
  asOfYmd?: string
): number {
  const rows = db
    .prepare(
      `SELECT amount_clp, note, occurred_on FROM movements
       WHERE account_id = ? AND ${CRYPTO_IMPORT_NOTE_SQL} AND note LIKE ?
       ORDER BY occurred_on, id`
    )
    .all(accountId, `%cripto-sheet|${asset}|%`) as {
    amount_clp: number;
    note: string | null;
    occurred_on: string;
  }[];
  let sum = 0;
  for (const r of rows) {
    if (asOfYmd && r.occurred_on > asOfYmd) continue;
    const qty = parseCoinUnitsFromNote(r.note);
    if (qty == null) continue;
    const wdw = r.note?.includes("|wdw");
    sum += wdw ? -qty : qty;
  }
  return Number.isFinite(sum) ? sum : 0;
}

/**
 * Cumulative coin held through `asOfYmd` (Σ `movements.units_delta` on cripto-sheet rows; falls back to note parsing).
 */
export function cryptoCoinCumulativeThroughDate(
  accountId: number,
  asOfYmd: string,
  asset?: CryptoAsset
): number {
  const resolved =
    asset ?? cryptoAssetFromCategorySlug(categorySlugForAccount(accountId) ?? "") ?? null;
  if (!resolved) return 0;

  const row = db
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(units_delta, 0)), 0) AS u
       FROM movements
       WHERE account_id = ?
         AND ${CRYPTO_IMPORT_NOTE_SQL}
         AND note LIKE ?
         AND date(occurred_on) <= date(?)`
    )
    .get(accountId, `%cripto-sheet|${resolved}|%`, asOfYmd) as { u: number };

  const hasExplicit = db
    .prepare(
      `SELECT 1 FROM movements
       WHERE account_id = ? AND ${CRYPTO_IMPORT_NOTE_SQL} AND note LIKE ? AND units_delta IS NOT NULL
       LIMIT 1`
    )
    .get(accountId, `%cripto-sheet|${resolved}|%`);

  if (hasExplicit) return row?.u ?? 0;
  return netCryptoCoinFromLedgerNotes(accountId, resolved, asOfYmd);
}

/** CLP MTM: coin units through `asOfYmd` × USD price × FX. */
export function computeCryptoMtmClp(
  accountId: number,
  asOfYmd: string,
  priceUsd?: number | null
): number | null {
  const ticker = cryptoEquityTickerForAccount(accountId);
  if (!ticker) return null;
  const asset = ticker === "BTC-USD" ? "BTC" : "ETH";
  const units = cryptoCoinCumulativeThroughDate(accountId, asOfYmd, asset);
  if (!Number.isFinite(units) || units <= 1e-12) return 0;
  const closeUsd = priceUsd ?? equityCloseUsdEod(ticker, asOfYmd);
  if (closeUsd == null || !Number.isFinite(closeUsd)) return null;
  const fx = fxMonthEndForBalanceUsd(asOfYmd);
  if (!fx || fx.clp_per_usd <= 0) return null;
  const clp = units * closeUsd * fx.clp_per_usd;
  return Number.isFinite(clp) ? clp : null;
}

export async function computeCryptoMtmClpLive(
  accountId: number,
  asOfYmd?: string
): Promise<{ value_clp: number; as_of_date: string } | null> {
  const ticker = cryptoEquityTickerForAccount(accountId);
  if (!ticker) return null;
  const session = asOfYmd ?? equitySessionYmdForTicker(ticker);
  const quote = await resolveEquityQuote(ticker, session, { preferLive: true });
  if (!quote) return null;
  const clp = computeCryptoMtmClp(accountId, session, quote.price_usd);
  if (clp == null || !Number.isFinite(clp)) return null;
  return { value_clp: clp, as_of_date: quote.trade_date };
}

/**
 * Replay cripto-sheet legs in `occurred_on`/`id` order and set `units_delta` from cumulative vs flow rules
 * (see `cryptoSheetUnits.ts`). Replaces legacy row-wise ±`coin=` backfill, which double-counted cumulative cells.
 */
export function recalculateCryptoMovementUnitsFromLedger(accountId: number, asset: CryptoAsset): number {
  const rows = db
    .prepare(
      `SELECT id, note FROM movements
       WHERE account_id = ? AND ${CRYPTO_IMPORT_NOTE_SQL} AND note LIKE ?
       ORDER BY occurred_on, id`
    )
    .all(accountId, `%cripto-sheet|${asset}|%`) as { id: number; note: string | null }[];
  const legs: CryptoSheetMonthMovement[] = [];
  const ids: number[] = [];
  for (const r of rows) {
    const coin = parseCoinUnitsFromNote(r.note);
    if (coin == null) continue;
    const wdw = r.note?.includes("|wdw");
    legs.push(wdw ? { kind: "wdw", coin } : { kind: "dep", coin });
    ids.push(r.id);
  }
  if (legs.length === 0) return 0;
  const deltas = cryptoSheetMovementDeltas(legs);
  const upd = db.prepare(`UPDATE movements SET units_delta = ? WHERE id = ?`);
  for (let i = 0; i < ids.length; i++) {
    upd.run(deltas[i], ids[i]);
  }
  return ids.length;
}

/** @deprecated Use {@link recalculateCryptoMovementUnitsFromLedger}. */
export function backfillCryptoMovementUnitsFromNotes(accountId: number, asset: CryptoAsset): number {
  return recalculateCryptoMovementUnitsFromLedger(accountId, asset);
}

function snapshotDatesForCryptoAccount(accountId: number, equityTicker: "BTC-USD" | "ETH-USD"): string[] {
  const s = new Set<string>();
  const movDates = db
    .prepare(
      `SELECT occurred_on AS d FROM movements
       WHERE account_id = ? AND ${CRYPTO_IMPORT_NOTE_SQL}
       ORDER BY occurred_on`
    )
    .all(accountId) as { d: string }[];
  for (const r of movDates) {
    s.add(monthEndUtcYmd(monthKeyFromYmd(r.d)));
  }
  const bounds = db
    .prepare(`SELECT min(trade_date) AS a, max(trade_date) AS b FROM equity_daily WHERE ticker = ?`)
    .get(equityTicker) as { a: string | null; b: string | null } | undefined;
  if (bounds?.a && bounds?.b) {
    for (const me of monthEndsBetweenInclusive(bounds.a, bounds.b)) s.add(me);
  }
  const valDates = db
    .prepare(`SELECT as_of_date AS d FROM valuations WHERE account_id = ?`)
    .all(accountId) as { d: string }[];
  for (const r of valDates) s.add(r.d);
  const today = chileCalendarTodayYmd();
  s.add(today);
  return [...s].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
}

const upsertVal = db.prepare(`
  INSERT INTO valuations (account_id, as_of_date, value_clp, units_snapshot)
  VALUES (@account_id, @as_of_date, @value_clp, @units_snapshot)
  ON CONFLICT(account_id, as_of_date) DO UPDATE SET
    value_clp = excluded.value_clp,
    units_snapshot = excluded.units_snapshot
`);

export function applyCryptoValuationsFromCoinHoldings(opts: {
  btcAccountId?: number;
  ethAccountId?: number;
  dryRun?: boolean;
}): { btcRows: number; ethRows: number; btcUnitsBackfill: number; ethUnitsBackfill: number } {
  let btcRows = 0;
  let ethRows = 0;
  let btcUnitsBackfill = 0;
  let ethUnitsBackfill = 0;

  const applyOne = (accountId: number, asset: CryptoAsset, equityTicker: "BTC-USD" | "ETH-USD") => {
    const recalcN = recalculateCryptoMovementUnitsFromLedger(accountId, asset);
    if (asset === "BTC") btcUnitsBackfill = recalcN;
    else ethUnitsBackfill = recalcN;

    const dates = snapshotDatesForCryptoAccount(accountId, equityTicker);
    let rows = 0;
    for (const d of dates) {
      const units = cryptoCoinCumulativeThroughDate(accountId, d, asset);
      const value = computeCryptoMtmClp(accountId, d);
      if (value == null || !Number.isFinite(value)) continue;
      if (!opts.dryRun) {
        upsertVal.run({
          account_id: accountId,
          as_of_date: d,
          value_clp: Math.round(value * 100) / 100,
          units_snapshot: units,
        });
      }
      rows += 1;
    }
    return rows;
  };

  if (opts.btcAccountId != null) {
    btcRows = applyOne(opts.btcAccountId, "BTC", "BTC-USD");
  }
  if (opts.ethAccountId != null) {
    ethRows = applyOne(opts.ethAccountId, "ETH", "ETH-USD");
  }

  return { btcRows, ethRows, btcUnitsBackfill, ethUnitsBackfill };
}

/** Merge timeline keys with month-ends covered by `equity_daily` for crypto accounts. */
export function expandSnapshotDatesForCryptoMtm(baseDates: string[], accountIds: number[]): string[] {
  const s = new Set(baseDates);
  const seen = new Set<number>();
  for (const accountId of accountIds) {
    if (seen.has(accountId)) continue;
    seen.add(accountId);
    if (!accountUsesCryptoMtm(accountId)) continue;
    const ticker = cryptoEquityTickerForAccount(accountId);
    if (!ticker) continue;
    for (const d of snapshotDatesForCryptoAccount(accountId, ticker)) s.add(d);
  }
  return [...s].sort();
}
