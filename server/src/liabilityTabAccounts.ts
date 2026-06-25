import { accountBucketKindSlug } from "./accountBucket.js";
import { isSupersededSantanderCcMaster } from "./ccConsolidatedCards.js";
import {
  getCreditCardGroupBySlug,
  listCreditCardGroupMasterAccountIds,
} from "./creditCardTree.js";
import { db } from "./db.js";
import { NOTE_STOCKS_LEGACY } from "./brokerageAcciones.js";
import type { GroupTabAccountRow } from "./groupMonthlyPerfConsolidation.js";

/** Legacy flat slugs and post-074 composite leaf buckets (`liabilities__mortgage`, …). */
export const SQL_LIABILITY_LEAF_BUCKET = `(
  g.slug IN ('mortgage', 'credit_card', 'other_debt')
  OR g.slug LIKE '%__mortgage'
  OR g.slug LIKE '%__credit_card'
  OR g.slug LIKE '%__other_debt'
)`;

function santanderPerCardCreditCardMastersExist(): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS o FROM accounts WHERE notes LIKE 'credit_card_master|santander|%' LIMIT 1`
    )
    .get() as { o: number } | undefined;
  return row != null;
}

function legacyCombinedCreditCardMasterIds(): Set<number> {
  return new Set(
    (
      db
        .prepare(`SELECT id FROM accounts WHERE notes = 'import:excel|key=credit_card'`)
        .all() as { id: number }[]
    ).map((r) => r.id)
  );
}

/** CC masters in `credit_card_group_items` — single id for Gastos and Pasivos. */
function listCreditCardPasivosTabAccountRows(): GroupTabAccountRow[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT m.id AS account_id, m.name, g.slug AS bucket_slug,
              m.notes AS notes, m.exclude_from_group_totals AS exclude_from_group_totals
       FROM accounts m
       JOIN credit_card_group_items i ON i.account_id = m.id AND i.item_kind = 'account'
       JOIN asset_groups g ON g.id = m.asset_group_id
       WHERE m.account_kind = 'master'
         AND m.notes LIKE 'credit_card_master|%'
         AND (m.notes IS NULL OR m.notes != ?)
       ORDER BY m.id, m.name`
    )
    .all(NOTE_STOCKS_LEGACY) as GroupTabAccountRow[];

  return rows.filter((r) => !isSupersededSantanderCcMaster(r.account_id));
}

/** @deprecated CC liability_view rows removed; kept as no-op for callers. */
export function ensureCreditCardLiabilityViews(): number {
  return 0;
}

/** Idempotent: Pasivos hipoteca leaf for the Excel mortgage master (if present). */
export function ensureMortgageLiabilityView(): number {
  const leaf = db
    .prepare(`SELECT id FROM asset_groups WHERE slug = 'liabilities__mortgage' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!leaf) return 0;

  const master = db
    .prepare(
      `SELECT id, name, color_rgb FROM accounts
       WHERE notes = 'import:excel|key=mortgage' AND account_kind = 'master'
       ORDER BY id LIMIT 1`
    )
    .get() as { id: number; name: string; color_rgb: string | null } | undefined;
  if (!master) return 0;

  const exists = db
    .prepare(
      `SELECT 1 AS o FROM accounts WHERE source_account_id = ? AND account_kind = 'liability_view'`
    )
    .get(master.id) as { o: number } | undefined;
  if (exists) return 0;

  db.prepare(
    `INSERT INTO accounts (asset_group_id, name, notes, account_kind, source_account_id, color_rgb)
     VALUES (?, ?, 'liability_view|mortgage', 'liability_view', ?, ?)`
  ).run(leaf.id, master.name, master.id, master.color_rgb);
  return 1;
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
              a.notes AS notes, a.exclude_from_group_totals AS exclude_from_group_totals
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id IN (${ph})
         AND (a.notes IS NULL OR a.notes != ?)
       ORDER BY a.id, a.name`
    )
    .all(...masterIds, NOTE_STOCKS_LEGACY) as GroupTabAccountRow[];
}

/** Pasivos tab: CC masters + mortgage liability_view rows. */
export function listLiabilitiesTabAccountRows(tabSubgroup?: string): GroupTabAccountRow[] {
  ensureMortgageLiabilityView();

  const ccRows = listCreditCardPasivosTabAccountRows();

  const mortgageRows = db
    .prepare(
      `SELECT a.id AS account_id, a.name, g.slug AS bucket_slug,
              a.notes AS notes, a.exclude_from_group_totals AS exclude_from_group_totals,
              a.source_account_id AS source_account_id
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE (g.slug = 'mortgage' OR g.slug LIKE '%__mortgage')
         AND a.account_kind = 'liability_view'
         AND (a.notes IS NULL OR a.notes != ?)
       ORDER BY g.slug, a.id, a.name`
    )
    .all(NOTE_STOCKS_LEGACY) as (GroupTabAccountRow & { source_account_id: number | null })[];

  let kept = [...ccRows, ...mortgageRows.map(({ source_account_id: _src, ...row }) => row)];

  const perCard = santanderPerCardCreditCardMastersExist();
  if (perCard) {
    const legacyMasterIds = legacyCombinedCreditCardMasterIds();
    kept = kept.filter((r) => {
      const isCc = accountBucketKindSlug(r.bucket_slug) === "credit_card";
      if (isCc) return true;
      if (r.exclude_from_group_totals === 1) return false;
      const src = (
        db.prepare(`SELECT source_account_id FROM accounts WHERE id = ?`).get(r.account_id) as
          | { source_account_id: number | null }
          | undefined
      )?.source_account_id;
      return src == null || !legacyMasterIds.has(src);
    });
  }

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
      exclude_from_group_totals: r.exclude_from_group_totals,
    });
  }
  return out;
}
