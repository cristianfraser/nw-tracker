import { useState } from "react";
import { Modal } from "../ui/Modal";
import { Table } from "../ui/Table";
import { formatClp } from "../../format";
import { expenseApartmentLabel, expenseKindLabel, useTranslation } from "../../i18n";
import { useRealEstateUnlinkedPurchases } from "../../queries/hooks";
import { useAssignRealEstatePurchaseMutation } from "../../queries/mutations";
import type { ExpenseApartmentSlug } from "../../types";

/** Kinds a purchase can be assigned to (mirrors REAL_ESTATE_LINKABLE_KINDS server-side). */
const ASSIGNABLE_KINDS = [
  "rent",
  "gastos_comunes",
  "electricidad",
  "gas",
  "internet",
  "water",
  "contribuciones",
] as const;

type Props = {
  accountSlug: ExpenseApartmentSlug | null;
  open: boolean;
  onClose: () => void;
};

/**
 * Purchase-first linking: pick an unlinked gastos purchase and assign it to this place
 * as a bill of the chosen kind — the bill row is created from the purchase itself.
 * Stays open after each assign so runs of months (e.g. rents) can be linked in one go.
 */
export function RealEstateAssignPurchaseModal({ accountSlug, open, onClose }: Props) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<string>("rent");
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const { data, isLoading, error } = useRealEstateUnlinkedPurchases(q.trim(), open);
  const assignMutation = useAssignRealEstatePurchaseMutation();

  const err =
    error instanceof Error
      ? error.message
      : assignMutation.error instanceof Error
        ? assignMutation.error.message
        : null;

  const handleAssign = async (purchaseKey: string) => {
    if (!accountSlug) return;
    setPendingKey(purchaseKey);
    try {
      await assignMutation.mutateAsync({
        purchase_key: purchaseKey,
        account_slug: accountSlug,
        kind,
      });
    } finally {
      setPendingKey(null);
    }
  };

  const purchases = data?.purchases ?? [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("expenses.realEstate.assignModalTitle")}
      subtitle={accountSlug ? expenseApartmentLabel(accountSlug) : null}
      closeAriaLabel={t("expenses.realEstate.linkModalClose")}
    >
      <div
        style={{ display: "flex", gap: "0.75rem", alignItems: "center", marginBottom: "0.75rem" }}
      >
        <label style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
          <span className="label-inline">{t("expenses.realEstate.assignKindLabel")}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {ASSIGNABLE_KINDS.map((k) => (
              <option key={k} value={k}>
                {expenseKindLabel(k)}
              </option>
            ))}
          </select>
        </label>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("expenses.realEstate.assignSearchPlaceholder")}
          style={{ flex: 1 }}
        />
      </div>

      {isLoading ? (
        <p className="muted">{t("common.loading")}</p>
      ) : err ? (
        <p className="error">{err}</p>
      ) : purchases.length === 0 ? (
        <p className="muted">{t("expenses.realEstate.noUnlinkedPurchases")}</p>
      ) : (
        <Table
          tableStyle={{ fontSize: "0.85rem" }}
          header={
            <thead>
              <tr>
                <th>{t("expenses.realEstate.colLinkedMerchant")}</th>
                <th>{t("expenses.realEstate.colLinkedDate")}</th>
                <th>{t("expenses.realEstate.colLinkedOrigin")}</th>
                <th>{t("expenses.colAmount")}</th>
                <th />
              </tr>
            </thead>
          }
        >
          {purchases.map((p) => (
            <tr key={p.purchase_key}>
              <td>{p.merchant ?? "—"}</td>
              <td className="mono">{p.purchase_on ?? p.purchase_month}</td>
              <td className="muted" style={{ fontSize: "0.8rem" }}>
                {p.origin_label}
                {p.source === "checking"
                  ? ` · ${t("expenses.creditCard.sourceChecking")}`
                  : ` · ${t("expenses.creditCard.sourceCreditCard")}`}
              </td>
              <td className="mono">{formatClp(p.amount_clp)}</td>
              <td>
                <button
                  type="button"
                  className="btn"
                  disabled={pendingKey != null}
                  onClick={() => void handleAssign(p.purchase_key)}
                >
                  {pendingKey === p.purchase_key
                    ? t("common.loading")
                    : t("expenses.realEstate.assignConfirm")}
                </button>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Modal>
  );
}
