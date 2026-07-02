import {
  deptoMortgageCloseClpBySnapshotDates,
  firstDeptoPropertyOwnershipYmd,
  type DeptoMortgageSheetRow,
} from "./deptoDividendosLedger.js";
import { ufClpBySnapshotDatesAsc } from "./fxRates.js";
import { loadDeptoLedgerFromMovements } from "./deptoLedgerFromMovements.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { dashboardBucketForAssetGroupSlug } from "./assetGroupTree.js";
import { listLiabilitiesTabAccountRows } from "./liabilityTabAccounts.js";
import { db } from "./db.js";
import { latestLiabilityValuationRowForSnapshot } from "./valuationLatest.js";

type LiabilityValuationRow = { account_id: number; category_slug: string };

type AccountCategoryMeta = Map<
  number,
  { category_slug: string; group_slug: string; exclude_from_group_totals: boolean }
>;

let accountCategoryMetaCache: AccountCategoryMeta | null = null;

export function clearAccountCategoryMetaCache(): void {
  accountCategoryMetaCache = null;
}

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

// No module-level cache: the movement ledger is ~30 rows and a stale cache leaks
// across requests (and across test files in the single vitest fork).
function mortgageLedgerForLiabilitiesOverview(): DeptoMortgageSheetRow[] {
  return loadDeptoLedgerFromMovements();
}

/** Same membership as {@link listLiabilitiesTabAccountRows}. */
function liabilityAccountsForValuation(): LiabilityValuationRow[] {
  return listLiabilitiesTabAccountRows().map((r) => ({
    account_id: r.account_id,
    category_slug: accountBucketKindSlug(r.bucket_slug),
  }));
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

function liabilityValuationContext(asOfYmd?: string) {
  // One case: the depto movement ledger is authoritative whenever it has rows; mortgages
  // without depto movements use stored valuations — account-type dispatch, not a fallback.
  const ledger = mortgageLedgerForLiabilitiesOverview();
  const useSheet = ledger.length > 0;
  const firstMortgageYmd = useSheet ? firstDeptoPropertyOwnershipYmd(ledger) : null;
  const mortgageClose =
    useSheet &&
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

function liabilityBreakdownForDate(
  accounts: LiabilityValuationRow[],
  asOfYmd: string,
  ctx: ReturnType<typeof liabilityValuationContext>
): { mortgage_clp: number; credit_card_clp: number } {
  const out = { mortgage_clp: 0, credit_card_clp: 0 };
  for (const r of accounts) {
    const clp = liabilityValuationClpAt(r, asOfYmd, ctx);
    if (clp == null || clp <= 0) continue;
    if (r.category_slug === "mortgage") out.mortgage_clp += clp;
    else if (r.category_slug === "credit_card") out.credit_card_clp += clp;
  }
  return out;
}

/** Per-category pasivos for dashboard / breakdown (liability_view series; depto mortgage from the movement ledger). */
export function liabilitiesBreakdownClpAsOf(
  asOfYmd: string
): { mortgage_clp: number; credit_card_clp: number } {
  const accounts = liabilityAccountsForValuation();
  const ctx = liabilityValuationContext(asOfYmd);
  return liabilityBreakdownForDate(accounts, asOfYmd, ctx);
}

/** Batch pasivos breakdown: one mortgage sheet load + UF map for all snapshot dates. */
export function liabilitiesBreakdownClpByDates(
  datesAsc: readonly string[]
): Map<string, { mortgage_clp: number; credit_card_clp: number }> {
  const out = new Map<string, { mortgage_clp: number; credit_card_clp: number }>();
  if (!datesAsc.length) return out;

  const accounts = liabilityAccountsForValuation();
  const ledger = mortgageLedgerForLiabilitiesOverview();
  const useSheet = ledger.length > 0;
  const firstMortgageYmd = useSheet ? firstDeptoPropertyOwnershipYmd(ledger) : null;
  const mortgageCloseByDate =
    useSheet && ledger.length > 0 && firstMortgageYmd != null
      ? deptoMortgageCloseClpBySnapshotDates([...datesAsc], ledger, ufClpBySnapshotDatesAsc([...datesAsc]))
      : new Map<string, number>();
  const meta = accountCategoryMetaById();

  for (const d of datesAsc) {
    const mortgageClose =
      useSheet &&
      firstMortgageYmd != null &&
      d >= firstMortgageYmd
        ? new Map<string, number>([[d, mortgageCloseByDate.get(d) ?? Number.NaN]])
        : new Map<string, number>();
    const ctx = { meta, useSheet, firstMortgageYmd, mortgageClose };
    out.set(d, liabilityBreakdownForDate(accounts, d, ctx));
  }
  return out;
}
