import { Link } from "react-router-dom";
import { ccExpenseCategoryPathLabel } from "../../ccExpenseCategories";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { formatClp, formatUsdFine } from "../../format";
import { useTranslation } from "../../i18n";
import { useLatestExpenses } from "../../queries/hooks";
import type { LatestExpenseRow } from "../../types";
import { Loadable } from "../ui/Loadable";
import { Table } from "../ui/Table";
import { TableMobileCard, TableMobileCardRow, TableMobileCardSection } from "../ui/TableMobileCard";

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
 * Expenses page. Desktop columns and the mobile card show the same fields.
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

  const header = (
    <thead>
      <tr>
        <th className="desktop-only">{t("dashboard.latestExpenses.colDate")}</th>
        <th className="desktop-only">{t("dashboard.latestExpenses.colMerchant")}</th>
        <th className="desktop-only">{t("dashboard.latestExpenses.colCategory")}</th>
        <th className="desktop-only">{t("dashboard.latestExpenses.colOrigin")}</th>
        <th className="desktop-only">{t("dashboard.latestExpenses.colAmount")}</th>
        <th className="mobile-only" aria-hidden="true" />
      </tr>
    </thead>
  );

  return (
    <section style={{ marginTop: "2rem" }}>
      <div className="chart-panel-title-row">
        <h2 style={{ margin: 0 }}>{t("dashboard.latestExpenses.title")}</h2>
        <Link to="/flows/expenses">{t("dashboard.latestExpenses.viewAll")}</Link>
      </div>
      {query.isError ? (
        <p className="error">
          {query.error instanceof Error ? query.error.message : t("common.loadFailedTables")}
        </p>
      ) : (
        <Loadable loading={loading}>
          <Table header={header} tableClassName="table--parallel-mobile">
            {rows.length === 0 && loading ? null : rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  {t("dashboard.latestExpenses.empty")}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.key}>
                  <td className="desktop-only mono">{row.date}</td>
                  <td className="desktop-only">{description(row)}</td>
                  <td className="desktop-only">{categoryLabel(row)}</td>
                  <td className="desktop-only muted">{row.origin_label}</td>
                  <td className="desktop-only mono">{amountCell(row)}</td>
                  <td className="mobile-only">
                    <TableMobileCard title={description(row)}>
                      <TableMobileCardSection>
                        <TableMobileCardRow label={t("dashboard.latestExpenses.colDate")} value={row.date} />
                        <TableMobileCardRow
                          label={t("dashboard.latestExpenses.colCategory")}
                          value={categoryLabel(row)}
                        />
                        <TableMobileCardRow
                          label={t("dashboard.latestExpenses.colOrigin")}
                          value={row.origin_label}
                        />
                        <TableMobileCardRow
                          label={t("dashboard.latestExpenses.colAmount")}
                          value={amountCell(row)}
                        />
                      </TableMobileCardSection>
                    </TableMobileCard>
                  </td>
                </tr>
              ))
            )}
          </Table>
        </Loadable>
      )}
    </section>
  );
}
