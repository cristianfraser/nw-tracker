import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { ExpensesByApartmentChart } from "../components/charts/ExpensesByApartmentChart";
import { RealEstateAddPlaceModal } from "../components/real-estate/RealEstateAddPlaceModal";
import { RealEstateAssignPurchaseModal } from "../components/real-estate/RealEstateAssignPurchaseModal";
import { RealEstateExpenseLinkModal } from "../components/real-estate/RealEstateExpenseLinkModal";
import { Table } from "../components/ui/Table";
import type { DashboardChartGranularity } from "../dashboardTimeseriesYearly";
import { formatClp, formatGroupedDecimalTrimmed } from "../format";
import { expenseKindLabel, useTranslation } from "../i18n";
import { useRealEstateExpenses } from "../queries/hooks";
import {
  useDeleteRealEstateExpenseEntryMutation,
  useUnmatchRealEstateExpenseMutation,
  useUpdateRealEstateConsumptionMutation,
} from "../queries/mutations";
import type { ExpenseApartmentSlug, RealEstateBillSlot } from "../types";

/** Kinds where a kWh / m³ reading makes sense (edit affordance shown). */
const CONSUMPTION_KINDS = new Set(["electricidad", "gas", "kwh"]);

function formatAmountCell(slot: RealEstateBillSlot): string {
  if (slot.kind === "kwh") {
    return slot.kwh != null ? formatGroupedDecimalTrimmed(slot.kwh) : "—";
  }
  if (slot.display_amount_clp <= 0 && slot.expected_amount_clp <= 0) return "—";
  if (slot.link) return formatClp(slot.link.amount_clp);
  return formatClp(slot.expected_amount_clp);
}

function consumptionLabel(slot: RealEstateBillSlot): string | null {
  if (slot.kind === "kwh") return null; // the reading IS the amount cell
  const parts: string[] = [];
  if (slot.kwh != null) parts.push(`${formatGroupedDecimalTrimmed(slot.kwh)} kWh`);
  if (slot.m3 != null) parts.push(`${formatGroupedDecimalTrimmed(slot.m3)} m³`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function linkedPurchaseLabel(slot: RealEstateBillSlot, t: (key: string) => string): string {
  if (slot.expense_entry_id == null) return t("expenses.realEstate.fromLedgerHint");
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
  const [assignPlace, setAssignPlace] = useState<{ slug: string; label: string } | null>(null);
  const [addPlaceOpen, setAddPlaceOpen] = useState(false);
  const [editing, setEditing] = useState<{ id: number; kwh: string; m3: string } | null>(null);
  const { data, error } = useRealEstateExpenses();
  const unmatchMutation = useUnmatchRealEstateExpenseMutation();
  const consumptionMutation = useUpdateRealEstateConsumptionMutation();
  const deleteEntryMutation = useDeleteRealEstateExpenseEntryMutation();
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;

  const saveConsumption = async () => {
    if (!editing) return;
    const parse = (s: string): number | null => {
      const trimmed = s.trim();
      if (!trimmed) return null;
      const n = Number(trimmed.replace(",", "."));
      return Number.isFinite(n) ? n : null;
    };
    await consumptionMutation.mutateAsync({
      expense_entry_id: editing.id,
      kwh: parse(editing.kwh),
      m3: parse(editing.m3),
    });
    setEditing(null);
  };

  const chartPoints = useMemo(() => {
    if (!data) return [];
    return granularity === "yearly" ? data.chart_yearly : data.chart_monthly;
  }, [data, granularity]);

  const places = useMemo(() => data?.places ?? [], [data]);

  const accountFilter = useMemo((): ExpenseApartmentSlug[] | undefined => {
    if (accountSlug && places.some((p) => p.slug === accountSlug)) {
      return [accountSlug];
    }
    return undefined; // index view: all places
  }, [accountSlug, places]);

  const sections = useMemo(() => {
    if (!data) return [];
    const accounts = places
      .map((p) => data.by_account[p.slug])
      .filter((a) => a != null && a.slots.length > 0);
    const filtered = accountSlug
      ? accounts.filter((a) => a.account_slug === accountSlug)
      : accounts;
    if (accountSlug && filtered.length === 0 && data.by_account[accountSlug]) {
      return [data.by_account[accountSlug]!];
    }
    return filtered;
  }, [data, accountSlug, places]);

  if (err) {
    return <p className="error">{err}</p>;
  }

  if (!data) {
    return <p className="muted">{t("common.loading")}</p>;
  }

  const titleSuffix =
    accountSlug != null ? (data.by_account[accountSlug]?.label ?? accountSlug) : null;

  const groupTotal = accountSlug
    ? (data.by_account[accountSlug]?.total_clp ?? 0)
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
          places={places}
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
          {!accountSlug ? (
            <button
              type="button"
              className="btn"
              style={{ marginLeft: "0.75rem", fontSize: "0.8rem" }}
              onClick={() => setAddPlaceOpen(true)}
            >
              {t("expenses.realEstate.addPlaceAction")}
            </button>
          ) : null}
        </h3>
        {sections.map((acc) => (
          <div key={acc.account_slug} style={{ marginBottom: "1.25rem" }}>
            <h4 style={{ fontSize: "1rem", marginBottom: "0.35rem" }}>
              {acc.label}
              <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
                {formatClp(acc.total_clp)}
              </span>
              <button
                type="button"
                className="btn"
                style={{ marginLeft: "0.75rem", fontSize: "0.8rem" }}
                onClick={() => setAssignPlace({ slug: acc.account_slug, label: acc.label })}
              >
                {t("expenses.realEstate.assignAction")}
              </button>
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
                  <tr key={slot.expense_entry_id ?? `${slot.kind}|${slot.spent_on}`}>
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
                      {editing != null && editing.id === slot.expense_entry_id ? (
                        <span
                          style={{
                            display: "flex",
                            gap: "0.35rem",
                            alignItems: "center",
                            marginTop: "0.25rem",
                          }}
                        >
                          <input
                            type="text"
                            inputMode="decimal"
                            value={editing.kwh}
                            placeholder="kWh"
                            style={{ width: "5rem" }}
                            onChange={(e) => setEditing({ ...editing, kwh: e.target.value })}
                          />
                          <input
                            type="text"
                            inputMode="decimal"
                            value={editing.m3}
                            placeholder="m³"
                            style={{ width: "5rem" }}
                            onChange={(e) => setEditing({ ...editing, m3: e.target.value })}
                          />
                          <button
                            type="button"
                            className="btn"
                            disabled={consumptionMutation.isPending}
                            onClick={() => void saveConsumption()}
                          >
                            {t("common.save")}
                          </button>
                          <button type="button" className="btn" onClick={() => setEditing(null)}>
                            {t("common.cancel")}
                          </button>
                        </span>
                      ) : (
                        consumptionLabel(slot) && (
                          <span className="muted" style={{ display: "block", fontSize: "0.75rem" }}>
                            {consumptionLabel(slot)}
                          </span>
                        )
                      )}
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
                      {slot.expense_entry_id == null ? (
                        "—"
                      ) : (
                        <span style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
                          {slot.can_link ? (
                            slot.link ? (
                              <button
                                type="button"
                                className="btn"
                                disabled={unmatchMutation.isPending}
                                onClick={() =>
                                  void unmatchMutation.mutateAsync(slot.expense_entry_id!)
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
                          ) : null}
                          {CONSUMPTION_KINDS.has(slot.kind) ? (
                            <button
                              type="button"
                              className="btn"
                              onClick={() =>
                                setEditing({
                                  id: slot.expense_entry_id!,
                                  kwh: slot.kwh != null ? String(slot.kwh) : "",
                                  m3: slot.m3 != null ? String(slot.m3) : "",
                                })
                              }
                            >
                              {t("expenses.realEstate.consumptionEditAction")}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="btn"
                            disabled={deleteEntryMutation.isPending}
                            onClick={() => {
                              if (window.confirm(t("expenses.realEstate.deleteEntryConfirm"))) {
                                void deleteEntryMutation.mutateAsync(slot.expense_entry_id!);
                              }
                            }}
                          >
                            {t("expenses.realEstate.deleteEntryAction")}
                          </button>
                        </span>
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
      <RealEstateAssignPurchaseModal
        place={assignPlace}
        open={assignPlace != null}
        onClose={() => setAssignPlace(null)}
      />
      <RealEstateAddPlaceModal open={addPlaceOpen} onClose={() => setAddPlaceOpen(false)} />
    </>
  );
}
