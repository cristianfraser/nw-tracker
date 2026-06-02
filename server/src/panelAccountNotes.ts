/** Stable import key for accounts created from Panel → Accounts. */
export function buildPanelAccountNotes(ticker: string, categoryKey: string): string {
  const t = ticker.trim().toUpperCase();
  const key = categoryKey.trim().toLowerCase();
  return `import:panel|ticker=${t}|key=${key}`;
}

/** Parse panel provenance notes (dedupe on create only — ticker lives in `accounts.equity_ticker`). */
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
