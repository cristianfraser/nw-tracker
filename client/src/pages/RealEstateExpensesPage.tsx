import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { ExpensesByApartmentChart } from "../components/charts/ExpensesByApartmentChart";
import { RealEstateExpenseLinkModal } from "../components/real-estate/RealEstateExpenseLinkModal";
import { Table } from "../components/ui/Table";
import type { DashboardChartGranularity } from "../dashboardTimeseriesYearly";
import { formatClp } from "../format";
import { expenseApartmentLabel, expenseKindLabel, useTranslation } from "../i18n";
import { useRealEstateExpenses } from "../queries/hooks";
import { useUnmatchRealEstateExpenseMutation } from "../queries/mutations";
import type { ExpenseApartmentSlug, RealEstateBillSlot } from "../types";

const ACCOUNT_ORDER: ExpenseApartmentSlug[] = ["el_vergel", "lastarria", "suecia"];

function formatAmountCell(slot: RealEstateBillSlot): string {
  if (slot.kind === "kwh") return slot.note?.includes("kwh=") ? slot.note.split("kwh=")[1]?.split("|")[0] ?? "—" : "—";
  if (slot.display_amount_clp <= 0 && slot.expected_amount_clp <= 0) return "—";
  if (slot.link) return formatClp(slot.link.amount_clp);
  return formatClp(slot.expected_amount_clp);
}

function linkedPurchaseLabel(slot: RealEstateBillSlot, t: (key: string) => string): string {
  if (!slot.link) return t("expenses.realEstate.unlinked");
  const parts = [
    slot.link.merchant ?? "—",
    slot.link.purchase_on ?? "",
    slot.link.origin_label,
    slot.link.source === "checking"
      ? t("expenses.creditCard.sourceChecking")
      : t("expenses.creditCard.sourceCreditCard"),
  ].filter(Boolean);
  return parts.join(" · ");
}

/** Gastos de arriendo / departamento (`/flows/expenses/real_estate`). */
export function RealEstateExpensesPage() {
  const { t } = useTranslation();
  const { accountSlug } = useParams<{ accountSlug?: string }>();
  const [granularity, setGranularity] = useState<DashboardChartGranularity>("monthly");
  const [linkSlot, setLinkSlot] = useState<RealEstateBillSlot | null>(null);
  const { data, error } = useRealEstateExpenses();
  const unmatchMutation = useUnmatchRealEstateExpenseMutation();
  const err = error instanceof Error ? error.message : error ? "Failed to load" : null;

  const chartPoints = useMemo(() => {
    if (!data) return [];
    return granularity === "yearly" ? data.chart_yearly : data.chart_monthly;
  }, [data, granularity]);

  const accountFilter = useMemo((): ExpenseApartmentSlug[] | undefined => {
    if (accountSlug && ACCOUNT_ORDER.includes(accountSlug as ExpenseApartmentSlug)) {
      return [accountSlug as ExpenseApartmentSlug];
    }
    return ["lastarria", "suecia"];
  }, [accountSlug]);

  const sections = useMemo(() => {
    if (!data) return [];
    const accounts = ACCOUNT_ORDER.map((slug) => data.by_account[slug]).filter(
      (a) => a != null && a.slots.length > 0
    );
    const filtered = accountSlug
      ? accounts.filter((a) => a.account_slug === accountSlug)
      : accounts;
    if (accountSlug && filtered.length === 0 && data.by_account[accountSlug as ExpenseApartmentSlug]) {
      return [data.by_account[accountSlug as ExpenseApartmentSlug]!];
    }
    return filtered;
  }, [data, accountSlug]);

  if (err) {
    return <p className="error">{err}</p>;
  }

  if (!data) {
    return <p className="muted">{t("common.loading")}</p>;
  }

  const titleSuffix =
    accountSlug != null ? expenseApartmentLabel(accountSlug as ExpenseApartmentSlug) : null;

  const groupTotal = accountSlug
    ? (data.by_account[accountSlug as ExpenseApartmentSlug]?.total_clp ?? 0)
    : data.total_clp;

  return (
    <>
      <h2 className="flow-section-title">
        {t("sidebar.flowsExpensesRealEstate")}
        {titleSuffix ? ` — ${titleSuffix}` : ""}
      </h2>
      <p className="muted" style={{ maxWidth: "52rem", marginBottom: "0.75rem" }}>
        {t("expenses.realEstateIntro")}
      </p>

      <div className="chart-controls" style={{ marginBottom: "0.75rem" }}>
        <span className="label-inline">{t("expenses.chartGranularityLabel")}</span>
        <label className="radio-pill">
          <input
            type="radio"
            name="expenses-granularity"
            checked={granularity === "monthly"}
            onChange={() => setGranularity("monthly")}
          />
          {t("dashboard.monthly")}
        </label>
        <label className="radio-pill">
          <input
            type="radio"
            name="expenses-granularity"
            checked={granularity === "yearly"}
            onChange={() => setGranularity("yearly")}
          />
          {t("dashboard.yearly")}
        </label>
      </div>

      <div
        className="chart-grid chart-grid--full-line chart-grid--full-width-stack"
        style={{ marginBottom: "1.5rem" }}
      >
        <ExpensesByApartmentChart
          title={t("expenses.chartTitle")}
          points={chartPoints}
          xAxisGranularity={granularity === "yearly" ? "year" : "month"}
          accountFilter={accountFilter}
        />
      </div>

      <section style={{ marginBottom: "1.75rem" }}>
        <h3 style={{ fontSize: "1.1rem", marginBottom: "0.75rem" }}>
          {t("expenses.groups.real_estate")}
          <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
            {formatClp(groupTotal)}
          </span>
        </h3>
        {sections.map((acc) => (
          <div key={acc.account_slug} style={{ marginBottom: "1.25rem" }}>
            <h4 style={{ fontSize: "1rem", marginBottom: "0.35rem" }}>
              {expenseApartmentLabel(acc.account_slug)}
              <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
                {formatClp(acc.total_clp)}
              </span>
            </h4>
            <Table
              tableStyle={{ fontSize: "0.85rem" }}
              header={
                <thead>
                  <tr>
                    <th>{t("expenses.colDate")}</th>
                    <th>{t("expenses.colKind")}</th>
                    <th>{t("expenses.colAmount")}</th>
                    <th>{t("expenses.realEstate.colLinkedPurchase")}</th>
                    <th>{t("expenses.realEstate.colActions")}</th>
                  </tr>
                </thead>
              }
            >
              {acc.slots.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    {t("expenses.emptyAccount")}
                  </td>
                </tr>
              ) : (
                acc.slots.map((slot) => (
                  <tr key={slot.expense_entry_id}>
                    <td className="mono">{slot.bill_month}</td>
                    <td>{expenseKindLabel(slot.kind)}</td>
                    <td className="mono">
                      {formatAmountCell(slot)}
                      {slot.link &&
                      slot.expected_amount_clp > 0 &&
                      slot.link.amount_clp !== slot.expected_amount_clp ? (
                        <span className="muted" style={{ display: "block", fontSize: "0.75rem" }}>
                          {t("expenses.realEstate.expectedHint", {
                            amount: formatClp(slot.expected_amount_clp),
                          })}
                        </span>
                      ) : null}
                    </td>
                    <td
                      className={slot.link ? undefined : "muted"}
                      style={{ fontSize: slot.link ? "0.85rem" : undefined }}
                    >
                      {slot.kind === "kwh" ? "—" : linkedPurchaseLabel(slot, t)}
                      {slot.link ? (
                        <span className="muted" style={{ display: "block", fontSize: "0.75rem" }}>
                          {slot.link.link_source === "auto"
                            ? t("expenses.realEstate.linkSourceAuto")
                            : t("expenses.realEstate.linkSourceManual")}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {slot.can_link ? (
                        slot.link ? (
                          <button
                            type="button"
                            className="btn"
                            disabled={unmatchMutation.isPending}
                            onClick={() =>
                              void unmatchMutation.mutateAsync(slot.expense_entry_id)
                            }
                          >
                            {t("expenses.realEstate.unlinkAction")}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn"
                            onClick={() => setLinkSlot(slot)}
                          >
                            {t("expenses.realEstate.linkAction")}
                          </button>
                        )
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))
              )}
            </Table>
          </div>
        ))}
        {sections.length === 0 ? (
          <p className="muted">{t("expenses.emptyAccount")}</p>
        ) : null}
      </section>

      <RealEstateExpenseLinkModal
        slot={linkSlot}
        open={linkSlot != null}
        onClose={() => setLinkSlot(null)}
      />
    </>
  );
}
