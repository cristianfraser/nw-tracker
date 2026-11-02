import { Link } from "react-router-dom";
import { ccExpenseCategoryPathLabel } from "../../ccExpenseCategories";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { formatClp, formatUsdFine } from "../../format";
import { useTranslation } from "../../i18n";
import { useLatestExpenses } from "../../queries/hooks";
import type { LatestExpenseRow, LatestExpensesResponse } from "../../types";
import { usePanelCache } from "../../queries/panelCache";
import { PageGridTile } from "../layout/PageGridTile";
import { dashboardTileOrder } from "../../dashboardLayout";
import { Loadable } from "../ui/Loadable";
import { ExpenseVendorLabel } from "../credit-card/ExpenseVendorLabel";
import styles from "./LatestExpenses.module.css";

const LATEST_EXPENSES_LIMIT = 15;

/** A stored «Últimos gastos» entry the panel can draw. */
function isLatestExpenses(v: unknown): v is LatestExpensesResponse {
  if (v == null || typeof v !== "object") return false;
  const { rows, unit } = v as { rows?: unknown; unit?: unknown };
  return (
    (unit === "clp" || unit === "usd") &&
    Array.isArray(rows) &&
    rows.every((r) => r != null && typeof r.key === "string" && typeof r.date === "string" && Number.isFinite(r.amount))
  );
}

function formatAmount(amount: number, unit: "clp" | "usd"): string {
  return unit === "usd" ? formatUsdFine(amount) : formatClp(amount);
}

function categoryLabel(row: LatestExpenseRow): string {
  return ccExpenseCategoryPathLabel({ slug: row.category_slug, parent_slug: row.category_parent_slug });
}

/**
 * Home «Últimos gastos»: the newest expense lines across every source (card, checking, manual,
 * payroll), as the server lists them (`GET /api/dashboard/latest-expenses`), its title linking to
 * the Expenses page. One compact entry per expense (merchant and amount, then date · category ·
 * origin), in the type scale of the «Flujos» cards; the same rendering at every width.
 */
export function LatestExpensesTable() {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const query = useLatestExpenses(displayUnit, LATEST_EXPENSES_LIMIT);
  // A held payload of the other unit is never stored; until live data is here, the last stored one.
  const { value: data } = usePanelCache(
    `latest-expenses-v1|${displayUnit}`,
    query.isPlaceholderData ? null : query.data,
    isLatestExpenses
  );
  const rows = data?.rows ?? [];
  const unit = data?.unit ?? displayUnit;
  const loading = data == null;

  const amountCell = (row: LatestExpenseRow): string =>
    row.amount < 0
      ? `${formatAmount(row.amount, unit)} · ${t("dashboard.latestExpenses.refund")}`
      : formatAmount(row.amount, unit);

  return (
    <PageGridTile id="latest-expenses" order={dashboardTileOrder("latest-expenses")}>
      <h2>
        <Link to="/flows/expenses">{t("dashboard.latestExpenses.title")}</Link>
      </h2>
      {query.isError ? (
        <p className="error">
          {query.error instanceof Error ? query.error.message : t("common.loadFailedTables")}
        </p>
      ) : (
        <Loadable loading={loading}>
          {rows.length === 0 && !loading ? (
            <p className={`muted ${styles.list}`}>{t("dashboard.latestExpenses.empty")}</p>
          ) : (
            <ul className={styles.list}>
              {rows.map((row) => (
                <li key={row.key} className={styles.item}>
                  <div className={styles.main}>
                    <ExpenseVendorLabel source={row} note={row.purchase_notes} className={styles.merchant} />
                    <span className={`mono ${styles.amount}`}>{amountCell(row)}</span>
                  </div>
                  <div className={styles.meta}>
                    <span className="mono">{row.date}</span> · {categoryLabel(row)} · {row.origin_label}
                    {row.installments != null
                      ? ` · ${t("dashboard.latestExpenses.installments", { count: row.installments })}`
                      : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Loadable>
      )}
    </PageGridTile>
  );
}
