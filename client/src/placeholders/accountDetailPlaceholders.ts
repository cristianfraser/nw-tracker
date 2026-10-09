import { isCreditCardAccountNavNode } from "../portfolioNavFromApi";
import { resolveNavTreeLabel } from "../sidebarNavFromApi";
import type { AccountDetailBundleResponse, DashboardAccountRow, NavTreeNodeDto } from "../types";
import type { DisplayUnit } from "../queries/keys";
import { emptyAccountMonthlyPerfRows } from "./placeholderMonthRows";

/** What the client already knows about the account before its detail bundle arrives. */
export type AccountDetailPlaceholderSource = {
  /** The account's sidebar-nav node (`findNavTreeNodeByAccountId`). */
  navNode?: NavTreeNodeDto | null;
  /** The account's card row from the (cached) nav snapshot / nav-context. */
  dashRow?: Pick<DashboardAccountRow, "name" | "bucket_slug" | "category_slug"> | null;
};

/** Category the page assumes when nothing identifies the account yet: the generic investment frame. */
const UNKNOWN_CATEGORY_SLUG = "mutual_fund";

/**
 * Behaviour kind = last `__` segment of the leaf asset-group slug (mirrors the server's
 * `accountBucketKindSlug`), e.g. `retirement_afp_afc__afp` → `afp`, `cash_eqs__cuenta_corriente`
 * → `cuenta_corriente`.
 */
function kindFromBucketSlug(slug: string | null | undefined): string | null {
  if (!slug) return null;
  const i = slug.lastIndexOf("__");
  const kind = i >= 0 ? slug.slice(i + 2) : slug;
  return kind || null;
}

/**
 * The account's `summary.category_slug` before the bundle is in, so every category-keyed section
 * of the page (cartola, position, depto, USD cash, …) renders its own frame from first paint
 * instead of a fake category's. The card row carries the leaf asset-group slug; an account leaf
 * of the sidebar tree carries no kind (only its group does), except the liability leaves, which
 * name theirs through `asset_group_slug` / `api_subgroup`.
 */
export function placeholderCategorySlug(source?: AccountDetailPlaceholderSource): string {
  const row = source?.dashRow;
  const fromRow = row?.category_slug?.trim() || kindFromBucketSlug(row?.bucket_slug);
  if (fromRow) return fromRow;
  const node = source?.navNode;
  if (node) {
    if (node.kind_slug?.trim()) return node.kind_slug.trim();
    if (isCreditCardAccountNavNode(node)) return "credit_card";
    if (node.api_subgroup === "mortgage") return "mortgage";
  }
  return UNKNOWN_CATEGORY_SLUG;
}

export function emptyMortgageLedger(accountId: number): AccountDetailBundleResponse["mortgageLedger"] {
  return {
    account_id: accountId,
    has_sheet_rows: false,
    meta: null,
    rows: [],
    payment_scenarios: [],
  };
}

export function emptyCcLedger(accountId: number): AccountDetailBundleResponse["ccLedger"] {
  return {
    account_id: accountId,
    has_installment_ledger: false,
    has_imported_statements: false,
    meta: null,
    purchases: [],
    purchases_completed: [],
    months: [],
    totals: {
      total_remaining_principal_clp: 0,
      next_calendar_month_total_clp: null,
      next_calendar_month: null,
    },
  };
}

function emptyDepositInflows(accountId: number): AccountDetailBundleResponse["depositInflows"] {
  return {
    account_id: accountId,
    total_clp: 0,
    display_total_clp: 0,
    events: [],
    display_events: [],
    state_contribution_total_clp: 0,
    state_contribution_events: [],
  };
}

export function buildPlaceholderAccountDetailBundle(
  accountId: number,
  unit: DisplayUnit,
  source?: AccountDetailPlaceholderSource
): AccountDetailBundleResponse {
  const unitTs = unit === "usd" ? "usd" : "clp";
  const category_slug = placeholderCategorySlug(source);
  // Nothing identifies the account yet (first-ever visit): a blank title, not a made-up one.
  const name = source?.navNode ? resolveNavTreeLabel(source.navNode) : (source?.dashRow?.name ?? "");
  return {
    summary: {
      account_id: accountId,
      category_slug,
      group_slug: null,
      group_label: null,
      group_peer_count: null,
      deposits_clp: 0,
      latest_valuation_clp: null,
      latest_valuation_date: null,
      position: null,
    },
    ts: {
      unit: unitTs,
      account_id: accountId,
      name,
      accounts: { lines: [], points: [] },
      granularity: "monthly",
    },
    depositInflows: emptyDepositInflows(accountId),
    mortgageLedger: emptyMortgageLedger(accountId),
    ccLedger: emptyCcLedger(accountId),
    invNavAccounts: { accounts: [] },
    checkingCartolaMonths: null,
    monthly_performance: {
      account_id: accountId,
      category_slug,
      monthly: emptyAccountMonthlyPerfRows(accountId, unitTs),
    },
    period_returns: null,
    dashboard_account_row: null,
  };
}
