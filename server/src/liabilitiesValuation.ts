import {
  deptoMortgageCloseClpBySnapshotDates,
  firstDeptoPropertyOwnershipYmd,
} from "./deptoDividendosLedger.js";
import { ufClpBySnapshotDatesAsc } from "./fxRates.js";
import { loadAllDeptoLedgers } from "./deptoLedgerFromMovements.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { dashboardBucketForAssetGroupSlug } from "./assetGroupTree.js";
import { listLiabilitiesTabAccountRows } from "./liabilityTabAccounts.js";
import { db } from "./db.js";
import { dbStateMemo } from "./dbStateMemo.js";
import { latestLiabilityValuationRowForSnapshot } from "./valuationLatest.js";
import { accountProfile, type QuantityKind } from "./accountProfile.js";

type LiabilityValuationRow = { account_id: number; category_slug: string; quantity: QuantityKind };

type AccountCategoryMeta = Map<
  number,
  { category_slug: string; group_slug: string; exclude_from_group_totals: boolean }
>;

/** Memoized as database state (`dbStateMemo.ts`): any write drops it. */
function accountCategoryMetaById(): AccountCategoryMeta {
  return dbStateMemo("liabilities_account_category_meta", null, buildAccountCategoryMeta);
}

function buildAccountCategoryMeta(): AccountCategoryMeta {
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
  return new Map(
    rows.map((r) => [
      r.id,
      {
        category_slug: accountBucketKindSlug(r.bucket_slug),
        group_slug: dashboardBucketForAssetGroupSlug(r.bucket_slug) ?? r.bucket_slug,
        exclude_from_group_totals: r.exclude_from_group_totals === 1,
      },
    ])
  );
}

/**
 * Each loan's depto ledger view: the first day its property was owned and its balance (UF × UF
 * día) on the dates asked. One entry per loan with ledger rows; a mortgage with none reads its
 * stored valuations (account-type dispatch, not a fallback).
 */
type LoanLedgerView = { firstMortgageYmd: string | null; closeByDate: Map<string, number> };

function loanLedgerViews(datesAsc: readonly string[]): Map<number, LoanLedgerView> {
  const out = new Map<number, LoanLedgerView>();
  const ufMap = datesAsc.length ? ufClpBySnapshotDatesAsc([...datesAsc]) : new Map<string, number>();
  for (const { loanAccountId, rows } of loadAllDeptoLedgers()) {
    if (loanAccountId == null || rows.length === 0) continue;
    const firstMortgageYmd = firstDeptoPropertyOwnershipYmd(rows);
    out.set(loanAccountId, {
      firstMortgageYmd,
      closeByDate:
        firstMortgageYmd != null && datesAsc.length
          ? deptoMortgageCloseClpBySnapshotDates([...datesAsc], rows, ufMap)
          : new Map(),
    });
  }
  return out;
}

/** Same membership as {@link listLiabilitiesTabAccountRows}. */
function liabilityAccountsForValuation(): LiabilityValuationRow[] {
  return listLiabilitiesTabAccountRows().map((r) => {
    const p = accountProfile(r.account_id);
    return { account_id: r.account_id, category_slug: p.kind, quantity: p.quantity.kind };
  });
}

function liabilityValuationClpAt(
  row: LiabilityValuationRow,
  asOfYmd: string,
  ctx: {
    meta: AccountCategoryMeta;
    loans: Map<number, LoanLedgerView>;
  }
): number | null {
  const m = ctx.meta.get(row.account_id);
  if (m?.exclude_from_group_totals) return null;
  let clp: number | null = null;
  const loan = row.quantity === "depto_loan" ? ctx.loans.get(row.account_id) : undefined;
  if (loan && loan.firstMortgageYmd != null && asOfYmd >= loan.firstMortgageYmd) {
    const fromSheet = loan.closeByDate.get(asOfYmd);
    if (fromSheet != null && Number.isFinite(fromSheet)) clp = fromSheet;
  }
  if (clp == null) {
    clp =
      latestLiabilityValuationRowForSnapshot(row.account_id, row.category_slug, asOfYmd)
        ?.value_clp ?? null;
  }
  return clp != null && Number.isFinite(clp) ? clp : null;
}

function liabilityValuationContext(asOfYmd: string) {
  // One case: a loan's depto movement ledger is authoritative whenever it has rows; mortgages
  // without depto movements use stored valuations — account-type dispatch, not a fallback.
  return {
    meta: accountCategoryMetaById(),
    loans: loanLedgerViews([asOfYmd]),
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
    if (clp == null) continue;
    if (r.quantity === "depto_loan") {
      if (clp > 0) out.mortgage_clp += clp;
    } else if (r.quantity === "card") {
      // Negative = a-favor credit balance — real negative debt; must sum so the Saldo
      // pasivos line equals Σ per-card chart lines at every date.
      if (clp !== 0) out.credit_card_clp += clp;
    }
  }
  return out;
}

/** Per-category pasivos for dashboard / breakdown (master-account series; depto mortgage from the movement ledger). */
export function liabilitiesBreakdownClpAsOf(
  asOfYmd: string
): { mortgage_clp: number; credit_card_clp: number } {
  const accounts = liabilityAccountsForValuation();
  const ctx = liabilityValuationContext(asOfYmd);
  return liabilityBreakdownForDate(accounts, asOfYmd, ctx);
}

export type LiabilitiesOnlyScope = "all" | "credit_card" | "mortgage";

/**
 * Explicit liabilities-only balance series for Pasivos views: mortgage (movement ledger)
 * + CC debt (billing balances) summed on their own — independent of the per-account chart
 * lines and of any net-worth/asset series.
 */
export function liabilitiesOnlyBalanceClpByDates(
  datesAsc: readonly string[],
  scope: LiabilitiesOnlyScope = "all"
): Map<string, number> {
  const out = new Map<string, number>();
  const breakdowns = liabilitiesBreakdownClpByDates(datesAsc);
  for (const d of datesAsc) {
    const b = breakdowns.get(d);
    if (!b) continue;
    const clp =
      scope === "credit_card"
        ? b.credit_card_clp
        : scope === "mortgage"
          ? b.mortgage_clp
          : b.mortgage_clp + b.credit_card_clp;
    if (Number.isFinite(clp)) out.set(d, clp);
  }
  return out;
}

/** Batch pasivos breakdown: one mortgage sheet load + UF map for all snapshot dates. */
export function liabilitiesBreakdownClpByDates(
  datesAsc: readonly string[]
): Map<string, { mortgage_clp: number; credit_card_clp: number }> {
  const out = new Map<string, { mortgage_clp: number; credit_card_clp: number }>();
  if (!datesAsc.length) return out;

  const accounts = liabilityAccountsForValuation();
  const ctx = { meta: accountCategoryMetaById(), loans: loanLedgerViews(datesAsc) };
  for (const d of datesAsc) out.set(d, liabilityBreakdownForDate(accounts, d, ctx));
  return out;
}
