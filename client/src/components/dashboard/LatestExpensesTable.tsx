import { Link } from "react-router-dom";
import { ccExpenseCategoryPathLabel } from "../../ccExpenseCategories";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { formatClp, formatUsdFine } from "../../format";
import { useTranslation } from "../../i18n";
import { useLatestExpenses } from "../../queries/hooks";
import type { LatestExpenseRow } from "../../types";
import { PageGridTile } from "../layout/PageGridTile";
import { dashboardTileOrder } from "../../dashboardLayout";
import { Loadable } from "../ui/Loadable";
import styles from "./LatestExpenses.module.css";
import flowsStyles from "./DashboardFlowsSummary.module.css";

const LATEST_EXPENSES_LIMIT = 15;

function formatAmount(amount: number, unit: "clp" | "usd"): string {
  return unit === "usd" ? formatUsdFine(amount) : formatClp(amount);
}

function categoryLabel(row: LatestExpenseRow): string {
  return ccExpenseCategoryPathLabel({ slug: row.category_slug, parent_slug: row.category_parent_slug });
}

/**
 * Home «Últimos gastos»: the newest expense lines across every source (card, checking, manual,
 * payroll), as the server lists them (`GET /api/dashboard/latest-expenses`), with a link to the
 * Expenses page. One compact entry per expense (merchant and amount, then date · category ·
 * origin), in the type scale of the «Flujos» cards; the same rendering at every width.
 */
export function LatestExpensesTable() {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const query = useLatestExpenses(displayUnit, LATEST_EXPENSES_LIMIT);
  const rows = query.data?.rows ?? [];
  const unit = query.data?.unit ?? displayUnit;
  const loading = query.isPending;

  const description = (row: LatestExpenseRow): string => {
    const name = row.merchant ?? "—";
    return row.installments != null
      ? `${name} · ${t("dashboard.latestExpenses.installments", { count: row.installments })}`
      : name;
  };
  const amountCell = (row: LatestExpenseRow): string =>
    row.amount < 0
      ? `${formatAmount(row.amount, unit)} · ${t("dashboard.latestExpenses.refund")}`
      : formatAmount(row.amount, unit);

  return (
    <PageGridTile id="latest-expenses" order={dashboardTileOrder("latest-expenses")}>
      <div className="chart-panel-title-row">
        <h2>{t("dashboard.latestExpenses.title")}</h2>
        <Link to="/flows/expenses" className={flowsStyles.link}>
          {t("dashboard.latestExpenses.viewAll")}
        </Link>
      </div>
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
                    <span className={styles.merchant} title={description(row)}>
                      {description(row)}
                    </span>
                    <span className={`mono ${styles.amount}`}>{amountCell(row)}</span>
                  </div>
                  <div className={styles.meta}>
                    <span className="mono">{row.date}</span> · {categoryLabel(row)} · {row.origin_label}
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
