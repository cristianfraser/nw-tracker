/** Stable import key for accounts created from Panel → Accounts. */
export function buildPanelAccountNotes(ticker: string, categoryKey: string): string {
  const t = ticker.trim().toUpperCase();
  const key = categoryKey.trim().toLowerCase();
  return `import:panel|ticker=${t}|key=${key}`;
}

/** Ledger cash accounts created from Panel (no equity ticker); `kind` is `clp` or `usd`. */
export function buildPanelCashAccountNotes(kind: "clp" | "usd", categoryKey: string): string {
  const key = categoryKey.trim().toLowerCase();
  return `import:panel|kind=${kind}|key=${key}`;
}

/** USD cash accounts created from Panel (no equity ticker). */
export function buildPanelUsdCashAccountNotes(categoryKey: string): string {
  return buildPanelCashAccountNotes("usd", categoryKey);
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

export function parsePanelUsdCashAccountNotes(
  notes: string | null | undefined
): { key: string } | null {
  if (!notes?.trim()) return null;
  const m = /^import:panel\|kind=usd\|key=([^|]+)$/.exec(notes.trim());
  if (!m) return null;
  const key = m[1]!.trim().toLowerCase();
  if (!key) return null;
  return { key };
}
