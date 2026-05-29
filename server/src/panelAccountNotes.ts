import { db } from "./db.js";

/** Stable import key for accounts created from Panel → Accounts. */
export function buildPanelAccountNotes(ticker: string, categoryKey: string): string {
  const t = ticker.trim().toUpperCase();
  const key = categoryKey.trim().toLowerCase();
  return `import:panel|ticker=${t}|key=${key}`;
}

export function parsePanelAccountNotes(
  notes: string | null | undefined
): { ticker: string; key: string } | null {
  if (!notes?.trim()) return null;
  const m = /^import:panel\|ticker=([^|]+)\|key=([^|]+)$/.exec(notes.trim());
  if (!m) return null;
  const ticker = m[1]!.trim().toUpperCase();
  const key = m[2]!.trim().toLowerCase();
  if (!ticker || !key) return null;
  return { ticker, key };
}

/** NYSE EOD sync: built-in SPY/VEA plus panel-created equity tickers. */
export function listNyseEquityTickersForEodSync(): string[] {
  const rows = db
    .prepare(`SELECT notes FROM accounts WHERE notes LIKE 'import:panel|ticker=%'`)
    .all() as { notes: string }[];
  const extra = rows
    .map((r) => parsePanelAccountNotes(r.notes)?.ticker)
    .filter((t): t is string => Boolean(t));
  return [...new Set(["SPY", "VEA", ...extra])];
}
