import { HeadingLink } from "../ui/HeadingLink";
import { useTranslation } from "../../i18n";
import { useLatestExpenses } from "../../queries/hooks";
import type { LatestExpensesResponse } from "../../types";
import { hasSchemaVersion, persistedPayload, usePersistedPayload } from "../../queries/persistedPayloadCache";
import { PageGridTile } from "../layout/PageGridTile";
import { dashboardTileOrder } from "../../dashboardLayout";
import { CreditCardExpenseLinesTable } from "../credit-card/CreditCardExpenseLinesTable";
import { queryLoadError } from "../../queries/pageShapeReady";

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

const LATEST_EXPENSES = persistedPayload(
  "latest_expenses",
  (v): v is LatestExpensesResponse => hasSchemaVersion(v, "latest_expenses") && isLatestExpenses(v)
);

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
  const { value: data } = usePersistedPayload(LATEST_EXPENSES, [], query.data);
  const loadError = queryLoadError(query);

  return (
    <PageGridTile id="latest-expenses" order={dashboardTileOrder("latest-expenses")}>
      <h2>
        <HeadingLink to="/flows/expenses">{t("dashboard.latestExpenses.title")}</HeadingLink>
      </h2>
      {loadError ? (
        <p className="error">
          {loadError instanceof Error ? loadError.message : t("common.loadFailedTables")}
        </p>
      ) : (
        <CreditCardExpenseLinesTable
          lines={data?.lines ?? []}
          categories={data?.categories ?? []}
          bigGroups={data?.big_groups ?? []}
          showBigGroupControls
          enableCheckingNotes
          hideHeader
          emptyLabel={t("dashboard.latestExpenses.empty")}
          loading={data == null}
        />
      )}
    </PageGridTile>
  );
}
