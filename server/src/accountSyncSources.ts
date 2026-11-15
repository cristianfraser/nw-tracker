import { db } from "./db.js";
import { equityMarketKind, unknownEquityMarketKind } from "./equityQuote.js";
import { isFintualCertV2AccountNotes } from "./fintualCertV2.js";
import type { GlobalSyncSource } from "./globalSyncStale.js";
import { AFC_CIC_SERIES_KEY } from "./afcCicSeries.js";
import { AFP_UNO_CUOTA_SERIES_KEY } from "./afpUnoSeries.js";

export type AccountSyncSourceRow = {
  id: number;
  import_key: string | null;
  equity_ticker: string | null;
  fund_series_key: string | null;
};

/** A Fintual fund account: a certificado account, or any account declared on a Fintual series. */
function isFintualFundAccount(importKey: string | null, fundSeriesKey: string | null): boolean {
  if (isFintualCertV2AccountNotes(importKey)) return true;
  return fundSeriesKey?.trim().startsWith("fintual") ?? false;
}

/** Deterministic inference used only when (re)seeding `account_sync_sources`. */
export function inferSyncSourcesForAccount(row: AccountSyncSourceRow): GlobalSyncSource[] {
  const out: GlobalSyncSource[] = [];
  if (isFintualFundAccount(row.import_key, row.fund_series_key)) out.push("fintual");
  const seriesKey = row.fund_series_key?.trim();
  if (seriesKey === AFP_UNO_CUOTA_SERIES_KEY) out.push("afp_uno");
  if (seriesKey === AFC_CIC_SERIES_KEY) out.push("afc_cic");
  const ticker = row.equity_ticker?.trim();
  if (ticker) {
    const kind = equityMarketKind(ticker);
    if (kind === "nyse") out.push("stocks_nyse");
    else if (kind === "santiago") out.push("stocks_santiago");
    else if (kind === "london") out.push("stocks_london");
    else if (kind === "crypto24") out.push("crypto_eod");
    else unknownEquityMarketKind(kind);
  }
  return out;
}

const stmtSelectAccount = db.prepare(
  `SELECT id, import_key, equity_ticker, fund_series_key FROM accounts WHERE id = ?`
);

const stmtDeleteForAccount = db.prepare(`DELETE FROM account_sync_sources WHERE account_id = ?`);

const stmtInsert = db.prepare(
  `INSERT INTO account_sync_sources (account_id, sync_source) VALUES (?, ?)`
);

export function reseedAccountSyncSources(accountId: number): GlobalSyncSource[] {
  const row = stmtSelectAccount.get(accountId) as AccountSyncSourceRow | undefined;
  if (!row) throw new Error(`reseedAccountSyncSources: unknown account_id=${accountId}`);
  const sources = inferSyncSourcesForAccount(row);
  const tx = db.transaction(() => {
    stmtDeleteForAccount.run(accountId);
    for (const source of sources) stmtInsert.run(accountId, source);
  });
  tx();
  return sources;
}

/**
 * Backfill `account_sync_sources` when the table is empty but accounts exist (fresh
 * demo/imported DBs, or migration 109 having run before its hook existed). Called at
 * server boot and from the demo generator (db.ts cannot call it: this module imports db.ts).
 */
export function ensureAccountSyncSourcesSeeded(): void {
  const linkCount = db.prepare(`SELECT COUNT(*) AS c FROM account_sync_sources`).get() as { c: number };
  if (linkCount.c > 0) return;
  const accountCount = db.prepare(`SELECT COUNT(*) AS c FROM accounts`).get() as { c: number };
  if (accountCount.c === 0) return;
  const r = reseedAllAccountSyncSources();
  console.log(`account_sync_sources seed: accounts=${r.accounts} links=${r.links}`);
}

export function reseedAllAccountSyncSources(): { accounts: number; links: number } {
  const ids = db.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: number }[];
  let links = 0;
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM account_sync_sources`).run();
    for (const { id } of ids) {
      const row = stmtSelectAccount.get(id) as AccountSyncSourceRow;
      const sources = inferSyncSourcesForAccount(row);
      for (const source of sources) {
        stmtInsert.run(id, source);
        links += 1;
      }
    }
  });
  tx();
  return { accounts: ids.length, links };
}

export function syncSourcesForAccountId(accountId: number): GlobalSyncSource[] {
  return (
    db
      .prepare(
        `SELECT sync_source FROM account_sync_sources WHERE account_id = ? ORDER BY sync_source`
      )
      .all(accountId) as { sync_source: GlobalSyncSource }[]
  ).map((r) => r.sync_source);
}

export function accountIdsWithAnyStaleSyncSource(
  staleSources: readonly GlobalSyncSource[]
): Set<number> {
  if (staleSources.length === 0) return new Set();
  const placeholders = staleSources.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT DISTINCT account_id FROM account_sync_sources WHERE sync_source IN (${placeholders})`
    )
    .all(...staleSources) as { account_id: number }[];
  return new Set(rows.map((r) => r.account_id));
}

