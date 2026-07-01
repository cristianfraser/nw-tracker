import { Link } from "react-router-dom";
import { useFlowsDepositsReconciliation } from "../queries/hooks";
import { Table } from "../components/ui/Table";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { useTranslation, depositFlowCategoryLabel } from "../i18n";
import { formatFlowMoney } from "../flowsDisplay";
import type {
  DepositReconciliationRow,
  DepositReconciliationStatus,
  DepositRedemptionRow,
  DepositRedemptionStatus,
} from "../types";

const STATUS_ORDER: DepositReconciliationStatus[] = [
  "unlinked_checking_present",
  "unlinked_no_checking_source",
  "resolved_internal_transfer",
  "resolved_family_funded",
  "linked_synthetic",
  "linked",
];

function statusSectionKey(status: DepositReconciliationStatus): string {
  switch (status) {
    case "linked":
      return "depositsReconciliation.sectionLinked";
    case "linked_synthetic":
      return "depositsReconciliation.sectionLinkedSynthetic";
    case "resolved_family_funded":
      return "depositsReconciliation.sectionResolvedFamilyFunded";
    case "resolved_internal_transfer":
      return "depositsReconciliation.sectionResolvedInternalTransfer";
    case "unlinked_no_checking_source":
      return "depositsReconciliation.sectionNoCheckingSource";
    case "unlinked_checking_present":
      return "depositsReconciliation.sectionNeedsAttention";
  }
}

function statusEmptyKey(status: DepositReconciliationStatus): string {
  switch (status) {
    case "linked":
      return "depositsReconciliation.emptyLinked";
    case "linked_synthetic":
      return "depositsReconciliation.emptyLinkedSynthetic";
    case "resolved_family_funded":
      return "depositsReconciliation.emptyResolvedFamilyFunded";
    case "resolved_internal_transfer":
      return "depositsReconciliation.emptyResolvedInternalTransfer";
    case "unlinked_no_checking_source":
      return "depositsReconciliation.emptyNoCheckingSource";
    case "unlinked_checking_present":
      return "depositsReconciliation.emptyNeedsAttention";
  }
}

function ReconciliationSection({
  status,
  rows,
  totalClp,
  totalUsd,
}: {
  status: DepositReconciliationStatus;
  rows: DepositReconciliationRow[];
  totalClp: number;
  totalUsd: number | null;
}) {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const total = displayUnit === "usd" ? (totalUsd ?? 0) : totalClp;

  return (
    <section style={{ marginBottom: "1.5rem" }}>
      <h3 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>
        {t(statusSectionKey(status))}
        <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
          {formatFlowMoney(total, displayUnit)}
        </span>
      </h3>
      <Table
        tableStyle={{ fontSize: "0.85rem" }}
        collapsedVisibleRows={20}
        showMoreLabel={t("notifications.showMore")}
        showLessLabel={t("table.showLess")}
        header={
          <thead>
            <tr>
              <th>{t("depositsReconciliation.colDate")}</th>
              <th>{t("depositsReconciliation.colCategory")}</th>
              <th>{t("depositsReconciliation.colAccount")}</th>
              <th>{t("depositsReconciliation.colAmount")}</th>
            </tr>
          </thead>
        }
      >
        {rows.length === 0 ? (
          <tr>
            <td colSpan={4} className="muted">
              {t(statusEmptyKey(status))}
            </td>
          </tr>
        ) : (
          rows.map((r) => {
            const amount = displayUnit === "usd" ? (r.amount_usd ?? 0) : r.amount_clp;
            return (
              <tr key={r.movement_id}>
                <td className="mono">{r.occurred_on}</td>
                <td>{depositFlowCategoryLabel(r.category)}</td>
                <td>
                  <Link to={`/account/${r.account_id}`}>{r.account_name}</Link>
                </td>
                <td className="mono">{formatFlowMoney(amount, displayUnit)}</td>
              </tr>
            );
          })
        )}
      </Table>
    </section>
  );
}

const REDEMPTION_STATUS_ORDER: DepositRedemptionStatus[] = [
  "unlinked_checking_present",
  "unlinked_no_checking_source",
  "resolved_internal_transfer",
  "linked",
];

function redemptionSectionKey(status: DepositRedemptionStatus): string {
  switch (status) {
    case "linked":
      return "depositsReconciliation.redemptionSectionLinked";
    case "resolved_internal_transfer":
      return "depositsReconciliation.sectionResolvedInternalTransfer";
    case "unlinked_no_checking_source":
      return "depositsReconciliation.redemptionSectionNoCheckingSource";
    case "unlinked_checking_present":
      return "depositsReconciliation.redemptionSectionNeedsAttention";
  }
}

function redemptionEmptyKey(status: DepositRedemptionStatus): string {
  switch (status) {
    case "linked":
      return "depositsReconciliation.redemptionEmptyLinked";
    case "resolved_internal_transfer":
      return "depositsReconciliation.emptyResolvedInternalTransfer";
    case "unlinked_no_checking_source":
      return "depositsReconciliation.redemptionEmptyNoCheckingSource";
    case "unlinked_checking_present":
      return "depositsReconciliation.redemptionEmptyNeedsAttention";
  }
}

function RedemptionSection({
  status,
  rows,
  totalClp,
  totalUsd,
}: {
  status: DepositRedemptionStatus;
  rows: DepositRedemptionRow[];
  totalClp: number;
  totalUsd: number | null;
}) {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const total = displayUnit === "usd" ? (totalUsd ?? 0) : totalClp;

  return (
    <section style={{ marginBottom: "1.5rem" }}>
      <h3 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>
        {t(redemptionSectionKey(status))}
        <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
          {formatFlowMoney(total, displayUnit)}
        </span>
      </h3>
      <Table
        tableStyle={{ fontSize: "0.85rem" }}
        collapsedVisibleRows={20}
        showMoreLabel={t("notifications.showMore")}
        showLessLabel={t("table.showLess")}
        header={
          <thead>
            <tr>
              <th>{t("depositsReconciliation.colDate")}</th>
              <th>{t("depositsReconciliation.colCategory")}</th>
              <th>{t("depositsReconciliation.colAccount")}</th>
              <th>{t("depositsReconciliation.colAmount")}</th>
            </tr>
          </thead>
        }
      >
        {rows.length === 0 ? (
          <tr>
            <td colSpan={4} className="muted">
              {t(redemptionEmptyKey(status))}
            </td>
          </tr>
        ) : (
          rows.map((r, idx) => {
            const amount = displayUnit === "usd" ? (r.amount_usd ?? 0) : r.amount_clp;
            return (
              <tr key={`${r.account_id}-${r.occurred_on}-${idx}`}>
                <td className="mono">{r.occurred_on}</td>
                <td>{depositFlowCategoryLabel(r.category)}</td>
                <td>
                  <Link to={`/account/${r.account_id}`}>{r.account_name}</Link>
                </td>
                <td className="mono">{formatFlowMoney(amount, displayUnit)}</td>
              </tr>
            );
          })
        )}
      </Table>
    </section>
  );
}

export function DepositsReconciliationPage() {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const { data, error } = useFlowsDepositsReconciliation();
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;

  if (err) {
    return <p className="error">{err}</p>;
  }

  if (!data) {
    return <p className="muted">{t("common.loading")}</p>;
  }

  const rowsByStatus = new Map<DepositReconciliationStatus, DepositReconciliationRow[]>();
  for (const r of data.rows) {
    const arr = rowsByStatus.get(r.status) ?? [];
    arr.push(r);
    rowsByStatus.set(r.status, arr);
  }

  const redemptionsByStatus = new Map<DepositRedemptionStatus, DepositRedemptionRow[]>();
  for (const r of data.redemptions) {
    const arr = redemptionsByStatus.get(r.status) ?? [];
    arr.push(r);
    redemptionsByStatus.set(r.status, arr);
  }

  return (
    <>
      <h2 className="flow-section-title">{t("depositsReconciliation.title")}</h2>
      <p className="muted" style={{ maxWidth: "52rem", marginBottom: "1.25rem" }}>
        {t("depositsReconciliation.intro")}
      </p>

      {STATUS_ORDER.map((status) => {
        const rows = rowsByStatus.get(status) ?? [];
        const totals = data.by_status[status];
        return (
          <ReconciliationSection
            key={status}
            status={status}
            rows={rows}
            totalClp={totals.total_clp}
            totalUsd={totals.total_usd}
          />
        );
      })}

      <section style={{ marginBottom: "1.5rem" }}>
        <h3 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>
          {t("depositsReconciliation.byMonth")}
        </h3>
        <Table
          tableStyle={{ fontSize: "0.85rem" }}
          collapsedVisibleRows={24}
          showMoreLabel={t("notifications.showMore")}
          showLessLabel={t("table.showLess")}
          header={
            <thead>
              <tr>
                <th>{t("depositsReconciliation.colMonth")}</th>
                <th>{t("depositsReconciliation.colLinked")}</th>
                <th>{t("depositsReconciliation.colLinkedSynthetic")}</th>
                <th>{t("depositsReconciliation.colResolvedFamilyFunded")}</th>
                <th>{t("depositsReconciliation.colResolvedInternalTransfer")}</th>
                <th>{t("depositsReconciliation.colNoChecking")}</th>
                <th>{t("depositsReconciliation.colUnlinked")}</th>
                <th>{t("depositsReconciliation.colTotal")}</th>
              </tr>
            </thead>
          }
        >
          {data.by_month.map((pt) => (
            <tr key={pt.month}>
              <td className="mono">{pt.month}</td>
              <td className="mono">{formatFlowMoney(pt.linked_clp, displayUnit)}</td>
              <td className="mono">{formatFlowMoney(pt.linked_synthetic_clp, displayUnit)}</td>
              <td className="mono">{formatFlowMoney(pt.resolved_family_funded_clp, displayUnit)}</td>
              <td className="mono">{formatFlowMoney(pt.resolved_internal_transfer_clp, displayUnit)}</td>
              <td className="mono">{formatFlowMoney(pt.unlinked_no_checking_source_clp, displayUnit)}</td>
              <td className="mono">{formatFlowMoney(pt.unlinked_checking_present_clp, displayUnit)}</td>
              <td className="mono">{formatFlowMoney(pt.total_clp, displayUnit)}</td>
            </tr>
          ))}
        </Table>
      </section>

      <h2 className="flow-section-title" style={{ marginTop: "2rem" }}>
        {t("depositsReconciliation.redemptionsTitle")}
      </h2>
      <p className="muted" style={{ maxWidth: "52rem", marginBottom: "1.25rem" }}>
        {t("depositsReconciliation.redemptionsIntro")}
      </p>
      {REDEMPTION_STATUS_ORDER.map((status) => {
        const rows = redemptionsByStatus.get(status) ?? [];
        const totals = data.redemptions_by_status[status];
        return (
          <RedemptionSection
            key={status}
            status={status}
            rows={rows}
            totalClp={totals.total_clp}
            totalUsd={totals.total_usd}
          />
        );
      })}
    </>
  );
}
