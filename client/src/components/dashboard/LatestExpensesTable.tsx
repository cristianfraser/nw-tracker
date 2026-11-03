import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { useLatestExpenses } from "../../queries/hooks";
import type { LatestExpensesResponse } from "../../types";
import { usePanelCache } from "../../queries/panelCache";
import { PageGridTile } from "../layout/PageGridTile";
import { dashboardTileOrder } from "../../dashboardLayout";
import { CreditCardExpenseLinesTable } from "../credit-card/CreditCardExpenseLinesTable";

const LATEST_EXPENSES_LIMIT = 15;

/** A stored «Últimos gastos» entry the panel can draw. */
function isLatestExpenses(v: unknown): v is LatestExpensesResponse {
  if (v == null || typeof v !== "object") return false;
  const { lines, categories, big_groups } = v as Record<string, unknown>;
  return (
    Array.isArray(lines) &&
    Array.isArray(categories) &&
    Array.isArray(big_groups) &&
    lines.every((l) => l != null && typeof l.purchase_key === "string" && Number.isFinite(l.amount_clp))
  );
}

/**
 * Home «Últimos gastos»: the newest expense lines across every source (card, checking, manual,
 * payroll), as the server lists them (`GET /api/dashboard/latest-expenses`), drawn with the
 * Expenses page's own row (`CreditCardExpenseLinesTable`: category and big-group pills, note,
 * linked details), its title linking to the Expenses page.
 */
export function LatestExpensesTable() {
  const { t } = useTranslation();
  const query = useLatestExpenses(LATEST_EXPENSES_LIMIT);
  // Until live data is here, the last stored one.
  const { value: data } = usePanelCache("latest-expenses-v2", query.data, isLatestExpenses);

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
        <CreditCardExpenseLinesTable
          lines={data?.lines ?? []}
          categories={data?.categories ?? []}
          bigGroups={data?.big_groups ?? []}
          showBigGroupControls
          enableCheckingNotes
          emptyLabel={t("dashboard.latestExpenses.empty")}
          loading={data == null}
        />
      )}
    </PageGridTile>
  );
}
