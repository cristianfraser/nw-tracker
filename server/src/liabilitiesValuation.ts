import {
  deptoMortgageCloseClpBySnapshotDates,
  firstDeptoPropertyOwnershipYmd,
  loadDeptoDividendosSheetLedgerFromDb,
  type DeptoMortgageSheetRow,
} from "./deptoDividendosLedger.js";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import { ufClpBySnapshotDatesAsc } from "./fxRates.js";
import { resolveOperationalAccountId } from "./accountSource.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { dashboardBucketForAssetGroupSlug } from "./assetGroupTree.js";
import { NOTE_STOCKS_LEGACY } from "./brokerageAcciones.js";
import { ensureCreditCardLiabilityViews, ensureMortgageLiabilityView } from "./liabilityTabAccounts.js";
import { db } from "./db.js";
import { latestLiabilityValuationRowForSnapshot } from "./valuationLatest.js";

type LiabilityValuationRow = { account_id: number; category_slug: string };

type AccountCategoryMeta = Map<
  number,
  { category_slug: string; group_slug: string; exclude_from_group_totals: boolean }
>;

let accountCategoryMetaCache: AccountCategoryMeta | null = null;

function accountCategoryMetaById(): AccountCategoryMeta {
  if (accountCategoryMetaCache) return accountCategoryMetaCache;
  const rows = db
    .prepare(
      `SELECT a.id, g.slug AS bucket_slug,
              a.exclude_from_group_totals AS exclude_from_group_totals
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id`
    )
    .all() as {
    id: number;
    bucket_slug: string;
    exclude_from_group_totals: number;
  }[];
  accountCategoryMetaCache = new Map(
    rows.map((r) => [
      r.id,
      {
        category_slug: accountBucketKindSlug(r.bucket_slug),
        group_slug: dashboardBucketForAssetGroupSlug(r.bucket_slug) ?? r.bucket_slug,
        exclude_from_group_totals: r.exclude_from_group_totals === 1,
      },
    ])
  );
  return accountCategoryMetaCache;
}

let mortgageLedgerForOverview: DeptoMortgageSheetRow[] | null = null;

function mortgageLedgerForLiabilitiesOverview(): DeptoMortgageSheetRow[] {
  if (mortgageLedgerForOverview == null) {
    mortgageLedgerForOverview = loadDeptoDividendosSheetLedgerFromDb();
  }
  return mortgageLedgerForOverview;
}

function santanderPerCardCreditCardMastersExist(): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS o FROM accounts WHERE notes LIKE 'credit_card_master|santander|%' LIMIT 1`
    )
    .get() as { o: number } | undefined;
  return row != null;
}

/** Same membership as {@link listLiabilitiesTabAccountRows} — liability_view only, one series per debt. */
function liabilityAccountsForValuation(): LiabilityValuationRow[] {
  ensureCreditCardLiabilityViews();
  ensureMortgageLiabilityView();
  const rows = db
    .prepare(
      `SELECT a.id AS account_id, g.slug AS bucket_slug,
              a.exclude_from_group_totals AS exclude_from_group_totals,
              a.source_account_id AS source_account_id
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE (
           g.slug IN ('mortgage', 'credit_card', 'other_debt')
           OR g.slug LIKE '%__mortgage'
           OR g.slug LIKE '%__credit_card'
           OR g.slug LIKE '%__other_debt'
         )
         AND a.account_kind = 'liability_view'
         AND (a.notes IS NULL OR a.notes != ?)
       ORDER BY g.slug, a.id, a.name`
    )
    .all(NOTE_STOCKS_LEGACY) as (LiabilityValuationRow & {
    exclude_from_group_totals: number;
    source_account_id: number | null;
  })[];

  let kept = rows;
  if (santanderPerCardCreditCardMastersExist()) {
    const legacyMasterIds = new Set(
      (
        db
          .prepare(`SELECT id FROM accounts WHERE notes = 'import:excel|key=credit_card'`)
          .all() as { id: number }[]
      ).map((r) => r.id)
    );
    kept = rows.filter((r) => {
      if (r.exclude_from_group_totals === 1) return false;
      const src = r.source_account_id;
      return src == null || !legacyMasterIds.has(src);
    });
  }

  const seenSeries = new Set<number>();
  const out: LiabilityValuationRow[] = [];
  for (const r of kept) {
    const seriesId = resolveOperationalAccountId(r.account_id);
    if (seenSeries.has(seriesId)) continue;
    seenSeries.add(seriesId);
    out.push({ account_id: r.account_id, category_slug: accountBucketKindSlug(r.bucket_slug) });
  }
  return out;
}

function liabilityValuationClpAt(
  row: LiabilityValuationRow,
  asOfYmd: string,
  ctx: {
    meta: AccountCategoryMeta;
    useSheet: boolean;
    firstMortgageYmd: string | null;
    mortgageClose: Map<string, number>;
  }
): number | null {
  const m = ctx.meta.get(row.account_id);
  if (m?.exclude_from_group_totals) return null;
  let clp: number | null = null;
  if (
    ctx.useSheet &&
    row.category_slug === "mortgage" &&
    ctx.firstMortgageYmd != null &&
    asOfYmd >= ctx.firstMortgageYmd
  ) {
    const fromSheet = ctx.mortgageClose.get(asOfYmd);
    if (fromSheet != null && Number.isFinite(fromSheet)) clp = fromSheet;
  }
  if (clp == null) {
    clp =
      latestLiabilityValuationRowForSnapshot(row.account_id, row.category_slug, asOfYmd)
        ?.value_clp ?? null;
  }
  return clp != null && Number.isFinite(clp) ? clp : null;
}

function liabilityValuationContext(opts?: { mortgageFromDeptoSheet?: boolean }, asOfYmd?: string) {
  const useSheet = opts?.mortgageFromDeptoSheet === true;
  const ledger = useSheet ? mortgageLedgerForLiabilitiesOverview() : [];
  const firstMortgageYmd = useSheet ? firstDeptoPropertyOwnershipYmd(ledger) : null;
  const mortgageClose =
    useSheet &&
    ledger.length > 0 &&
    firstMortgageYmd != null &&
    asOfYmd != null &&
    asOfYmd >= firstMortgageYmd
      ? deptoMortgageCloseClpBySnapshotDates([asOfYmd], ledger, ufClpBySnapshotDatesAsc([asOfYmd]))
      : new Map<string, number>();
  return {
    meta: accountCategoryMetaById(),
    useSheet,
    firstMortgageYmd,
    mortgageClose,
  };
}

/** Per-category pasivos for dashboard / breakdown (liability_view series, sheet mortgage when opted in). */
export function liabilitiesBreakdownClpAsOf(
  asOfYmd: string,
  opts?: { mortgageFromDeptoSheet?: boolean }
): { mortgage_clp: number; credit_card_clp: number } {
  const ctx = liabilityValuationContext(opts, asOfYmd);
  const out = { mortgage_clp: 0, credit_card_clp: 0 };
  for (const r of liabilityAccountsForValuation()) {
    const clp = liabilityValuationClpAt(r, asOfYmd, ctx);
    if (clp == null || clp <= 0) continue;
    if (r.category_slug === "mortgage") out.mortgage_clp += clp;
    else if (r.category_slug === "credit_card") out.credit_card_clp += clp;
  }
  return out;
}
