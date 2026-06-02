import { db } from "./db.js";
import { fintualCertV2SeriesKeyFromImportNotes } from "./fintualCertV2.js";

/** `import:excel|key=…` or `import:fintual|cert|key=…` → rates chart series key (fallback when column unset). */
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

export function fundSeriesKeyForAccount(accountId: number): string | null {
  const row = db
    .prepare(`SELECT fund_series_key, notes FROM accounts WHERE id = ?`)
    .get(accountId) as { fund_series_key: string | null; notes: string | null } | undefined;
  if (!row) return null;
  const col = row.fund_series_key?.trim();
  if (col) return col;
  return fundSeriesKeyFromImportNotes(row.notes ?? "");
}
