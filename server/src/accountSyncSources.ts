import { db } from "./db.js";
import { equityMarketKind } from "./equityQuote.js";
import {
  fintualCertV2SeriesKeyFromImportNotes,
  isFintualCertV2AccountNotes,
} from "./fintualCertV2.js";
import type { GlobalSyncSource } from "./globalSyncStale.js";

export type AccountSyncSourceRow = {
  id: number;
  notes: string | null;
  equity_ticker: string | null;
  fund_series_key: string | null;
};

function fundSeriesKeyFromImportNotes(importNotes: string): string | null {
  const v2 = fintualCertV2SeriesKeyFromImportNotes(importNotes);
  if (v2) return v2;
  const key = importNotes.match(/import:excel\|key=([\w_]+)/)?.[1];
  if (!key) return null;
  switch (key) {
    case "fintual_rn":
      return "fintual_risky_norris";
    case "apv_a":
      return "fintual_risky_norris_apv";
    default:
      return null;
  }
}

function resolvedFundSeriesKey(notes: string | null, fundSeriesKey: string | null): string | null {
  const col = fundSeriesKey?.trim();
  if (col) return col;
  if (notes) return fundSeriesKeyFromImportNotes(notes);
  return null;
}

function isFintualFundAccount(notes: string | null, fundSeriesKey: string | null): boolean {
  if (isFintualCertV2AccountNotes(notes)) return true;
  const key = resolvedFundSeriesKey(notes, fundSeriesKey);
  return key != null && key.startsWith("fintual");
}

/** Deterministic inference used only when (re)seeding `account_sync_sources`. */
export function inferSyncSourcesForAccount(row: AccountSyncSourceRow): GlobalSyncSource[] {
  const out: GlobalSyncSource[] = [];
  if (isFintualFundAccount(row.notes, row.fund_series_key)) out.push("fintual");
  if (row.notes === "import:excel|key=afp") out.push("afp_uno");
  const ticker = row.equity_ticker?.trim();
  if (ticker) {
    const kind = equityMarketKind(ticker);
    if (kind === "nyse") out.push("stocks_nyse");
    else if (kind === "crypto24") out.push("crypto_eod");
  }
  return out;
}

const stmtSelectAccount = db.prepare(
  `SELECT id, notes, equity_ticker, fund_series_key FROM accounts WHERE id = ?`
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

export function isAccountSyncStale(
  accountId: number,
  staleSources: readonly GlobalSyncSource[]
): boolean {
  const sources = syncSourcesForAccountId(accountId);
  if (sources.length === 0) return false;
  const staleSet = new Set(staleSources);
  return sources.some((source) => staleSet.has(source));
}
