import { accountBucketKindSlug } from "./accountBucket.js";
import { isSupersededSantanderCcMaster } from "./ccConsolidatedCards.js";
import { getCreditCardGroupBySlug, listCreditCardGroupMasterAccountIds } from "./creditCardTree.js";
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

/** Idempotent: one Pasivos leaf per CC master registered in `credit_card_group_items`. */
export function ensureCreditCardLiabilityViews(): number {
  const leaf = db
    .prepare(`SELECT id FROM asset_groups WHERE slug = 'liabilities__credit_card' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!leaf) return 0;

  const masters = db
    .prepare(
      `SELECT DISTINCT m.id, m.name, m.color_rgb, m.notes
       FROM accounts m
       JOIN credit_card_group_items i ON i.account_id = m.id AND i.item_kind = 'account'
       WHERE m.account_kind = 'master'
         AND m.notes LIKE 'credit_card_master|%'
       ORDER BY m.notes`
    )
    .all() as { id: number; name: string; color_rgb: string | null; notes: string | null }[];

  let created = 0;
  for (const m of masters) {
    if (isSupersededSantanderCcMaster(m.id)) continue;
    const exists = db
      .prepare(
        `SELECT 1 AS o FROM accounts WHERE source_account_id = ? AND account_kind = 'liability_view'`
      )
      .get(m.id) as { o: number } | undefined;
    if (exists) continue;
    db.prepare(
      `INSERT INTO accounts (asset_group_id, name, notes, account_kind, source_account_id, color_rgb)
       VALUES (?, ?, 'liability_view|credit_card', 'liability_view', ?, ?)`
    ).run(leaf.id, m.name, m.id, m.color_rgb);
    created++;
  }
  return created;
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

/** One `credit_card_groups` issuer page (e.g. Santander, BCI) — liability_view rows for that issuer only. */
export function listCreditCardIssuerTabAccountRows(issuerSlug: string): GroupTabAccountRow[] | null {
  if (!getCreditCardGroupBySlug(issuerSlug)) return null;
  ensureCreditCardLiabilityViews();
  const masterIds = listCreditCardGroupMasterAccountIds(issuerSlug);
  if (!masterIds.length) return [];

  const ph = masterIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT a.id AS account_id, a.name, g.slug AS bucket_slug,
              a.notes AS notes, a.exclude_from_group_totals AS exclude_from_group_totals,
              a.source_account_id AS source_account_id
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.account_kind = 'liability_view'
         AND a.source_account_id IN (${ph})
         AND (a.notes IS NULL OR a.notes != ?)
       ORDER BY a.id, a.name`
    )
    .all(...masterIds, NOTE_STOCKS_LEGACY) as (GroupTabAccountRow & { source_account_id: number })[];

  return rows.map(({ source_account_id: _src, ...row }) => row);
}

/** Pasivos tab: one liability_view row per operational debt (CC + mortgage). */
export function listLiabilitiesTabAccountRows(tabSubgroup?: string): GroupTabAccountRow[] {
  ensureCreditCardLiabilityViews();
  ensureMortgageLiabilityView();

  const rows = db
    .prepare(
      `SELECT a.id AS account_id, a.name, g.slug AS bucket_slug,
              a.notes AS notes, a.exclude_from_group_totals AS exclude_from_group_totals,
              a.source_account_id AS source_account_id
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE ${SQL_LIABILITY_LEAF_BUCKET}
         AND a.account_kind = 'liability_view'
         AND (a.notes IS NULL OR a.notes != ?)
       ORDER BY g.slug, a.id, a.name`
    )
    .all(NOTE_STOCKS_LEGACY) as (GroupTabAccountRow & { source_account_id: number | null })[];

  const perCard = santanderPerCardCreditCardMastersExist();
  let kept = rows;
  if (perCard) {
    const legacyMasterIds = legacyCombinedCreditCardMasterIds();
    kept = rows.filter((r) => {
      if (r.exclude_from_group_totals === 1) return false;
      const src = r.source_account_id;
      return src == null || !legacyMasterIds.has(src);
    });
  }

  if (tabSubgroup) {
    kept = kept.filter((r) => accountBucketKindSlug(r.bucket_slug) === tabSubgroup);
  }

  const seenSeries = new Set<number>();
  const out: GroupTabAccountRow[] = [];
  for (const r of kept) {
    const seriesId = r.account_id;
    if (seenSeries.has(seriesId)) continue;
    seenSeries.add(seriesId);
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
