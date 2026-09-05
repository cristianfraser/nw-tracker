import { accountBucketKindSlug } from "./accountBucket.js";
import { isSupersededSantanderCcMaster } from "./ccConsolidatedCards.js";
import {
  getCreditCardGroupBySlug,
  listCreditCardGroupMasterAccountIds,
} from "./creditCardTree.js";
import { db } from "./db.js";
import { NOTE_STOCKS_LEGACY } from "./brokerageAcciones.js";
import type { GroupTabAccountRow } from "./groupMonthlyPerfConsolidation.js";

/** CC masters in `credit_card_group_items` — single id for Gastos and Pasivos. */
function listCreditCardPasivosTabAccountRows(): GroupTabAccountRow[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT m.id AS account_id, m.name, g.slug AS bucket_slug,
              m.notes AS notes, m.import_key, m.exclude_from_group_totals AS exclude_from_group_totals
       FROM accounts m
       JOIN credit_card_group_items i ON i.account_id = m.id AND i.item_kind = 'account'
       JOIN asset_groups g ON g.id = m.asset_group_id
       WHERE m.import_key LIKE 'credit_card_master|%'
         AND (m.import_key IS NULL OR m.import_key != ?)
       ORDER BY m.id, m.name`
    )
    .all(NOTE_STOCKS_LEGACY) as GroupTabAccountRow[];

  return rows.filter((r) => !isSupersededSantanderCcMaster(r.account_id));
}

/** One `credit_card_groups` issuer page (e.g. Santander, BCI) — master rows for that issuer. */
export function listCreditCardIssuerTabAccountRows(issuerSlug: string): GroupTabAccountRow[] | null {
  if (!getCreditCardGroupBySlug(issuerSlug)) return null;
  const masterIds = listCreditCardGroupMasterAccountIds(issuerSlug);
  if (!masterIds.length) return [];

  const ph = masterIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT a.id AS account_id, a.name, g.slug AS bucket_slug,
              a.notes AS notes, a.import_key, a.exclude_from_group_totals AS exclude_from_group_totals
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id IN (${ph})
         AND (a.import_key IS NULL OR a.import_key != ?)
       ORDER BY a.id, a.name`
    )
    .all(...masterIds, NOTE_STOCKS_LEGACY) as GroupTabAccountRow[];
}

/** Pasivos tab: CC masters + mortgage masters (liability_view rows were retired, migration 175). */
export function listLiabilitiesTabAccountRows(tabSubgroup?: string): GroupTabAccountRow[] {
  const ccRows = listCreditCardPasivosTabAccountRows();

  const mortgageRows = db
    .prepare(
      `SELECT a.id AS account_id, a.name, g.slug AS bucket_slug,
              a.notes AS notes, a.import_key, a.exclude_from_group_totals AS exclude_from_group_totals
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE (g.slug = 'mortgage' OR g.slug LIKE '%__mortgage')
         AND (a.import_key IS NULL OR a.import_key != ?)
       ORDER BY g.slug, a.id, a.name`
    )
    .all(NOTE_STOCKS_LEGACY) as GroupTabAccountRow[];

  let kept = [...ccRows, ...mortgageRows];

  // Non-CC liability accounts excluded from totals stay off the tab. (The legacy combined
  // worldmember filter died with the excel importer and its account.)
  kept = kept.filter(
    (r) =>
      accountBucketKindSlug(r.bucket_slug) === "credit_card" || r.exclude_from_group_totals !== 1
  );

  if (tabSubgroup) {
    kept = kept.filter((r) => accountBucketKindSlug(r.bucket_slug) === tabSubgroup);
  }

  const seenSeries = new Set<number>();
  const out: GroupTabAccountRow[] = [];
  for (const r of kept) {
    if (seenSeries.has(r.account_id)) continue;
    seenSeries.add(r.account_id);
    out.push({
      account_id: r.account_id,
      name: r.name,
      bucket_slug: r.bucket_slug,
      notes: r.notes,
      import_key: r.import_key ?? null,
      exclude_from_group_totals: r.exclude_from_group_totals,
    });
  }
  return out;
}
