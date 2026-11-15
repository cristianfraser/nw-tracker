import { db } from "./db.js";
import { fintualCertV2SeriesKeyFromImportNotes } from "./fintualCertV2.js";

/** A certificado identity string (`import:fintual|cert|key=…`) → its valor cuota series key; null for any other string. */
export function fundSeriesKeyFromImportNotes(importNotes: string): string | null {
  return fintualCertV2SeriesKeyFromImportNotes(importNotes);
}

/**
 * The account's fund series (`accounts.fund_series_key`, written by the account ensure), or null
 * when it is not modeled on one. The column is the state — no derivation from identity strings.
 */
export function fundSeriesKeyForAccount(accountId: number): string | null {
  const row = db
    .prepare(`SELECT fund_series_key FROM accounts WHERE id = ?`)
    .get(accountId) as { fund_series_key: string | null } | undefined;
  return row?.fund_series_key?.trim() || null;
}
