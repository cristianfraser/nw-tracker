import { db } from "./db.js";
import { fintualCertV2SeriesKeyFromImportNotes } from "./fintualCertV2.js";

/** `import:excel|key=…` or `import:fintual|cert|key=…` identity string → rates chart series key. */
export function fundSeriesKeyFromImportNotes(importNotes: string): string | null {
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
