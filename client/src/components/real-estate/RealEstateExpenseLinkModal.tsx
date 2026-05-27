import { useState } from "react";
import { Modal } from "../ui/Modal";
import { Table } from "../ui/Table";
import { formatClp } from "../../format";
import { expenseKindLabel, useTranslation } from "../../i18n";
import { useRealEstateLinkCandidates } from "../../queries/hooks";
import { useLinkRealEstateExpenseMutation } from "../../queries/mutations";
import type { RealEstateBillSlot } from "../../types";

type Props = {
  slot: RealEstateBillSlot | null;
  open: boolean;
  onClose: () => void;
};

export function RealEstateExpenseLinkModal({ slot, open, onClose }: Props) {
  const { t } = useTranslation();
  const entryId = slot?.expense_entry_id ?? null;
  const { data, isLoading, error } = useRealEstateLinkCandidates(entryId, open);
  const linkMutation = useLinkRealEstateExpenseMutation();
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const err =
    error instanceof Error ? error.message : linkMutation.error instanceof Error
      ? linkMutation.error.message
      : null;

  const handleLink = async (purchaseKey: string) => {
    if (!slot) return;
    setPendingKey(purchaseKey);
    try {
      await linkMutation.mutateAsync({
        expense_entry_id: slot.expense_entry_id,
        purchase_key: purchaseKey,
      });
      onClose();
    } finally {
      setPendingKey(null);
    }
  };

  const candidates = data?.candidates ?? [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("expenses.realEstate.linkModalTitle")}
      subtitle={
        slot ? (
          <>
            {expenseKindLabel(slot.kind)} · {slot.bill_month} ·{" "}
            <span className="mono">{formatClp(slot.expected_amount_clp)}</span>
          </>
        ) : null
      }
      closeAriaLabel={t("expenses.realEstate.linkModalClose")}
    >
      {isLoading ? (
        <p className="muted">{t("common.loading")}</p>
      ) : err ? (
        <p className="error">{err}</p>
      ) : candidates.length === 0 ? (
        <p className="muted">{t("expenses.realEstate.noCandidates")}</p>
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
            {candidates.map((c) => (
              <tr key={c.purchase_key}>
                <td>
                  {c.merchant ?? "—"}
                  {c.merchant_matches ? (
                    <span className="muted" style={{ marginLeft: "0.35rem", fontSize: "0.75rem" }}>
                      ({t("expenses.realEstate.merchantMatchHint")})
                    </span>
                  ) : null}
                </td>
                <td className="mono">
                  {c.purchase_on ?? "—"}
                  {c.purchase_month_offset <= 2 ? (
                    <span className="muted" style={{ marginLeft: "0.35rem", fontSize: "0.75rem" }}>
                      (
                      {c.purchase_month_offset === 0
                        ? t("expenses.realEstate.paymentMonthOffsetSame")
                        : t("expenses.realEstate.paymentMonthOffsetLater", {
                            months: c.purchase_month_offset,
                          })}
                      )
                    </span>
                  ) : null}
                </td>
                <td className="muted" style={{ fontSize: "0.8rem" }}>
                  {c.origin_label}
                  {c.source === "checking"
                    ? ` · ${t("expenses.creditCard.sourceChecking")}`
                    : ` · ${t("expenses.creditCard.sourceCreditCard")}`}
                </td>
                <td className="mono">{formatClp(c.amount_clp)}</td>
                <td>
                  <button
                    type="button"
                    className="btn"
                    disabled={pendingKey != null}
                    onClick={() => void handleLink(c.purchase_key)}
                  >
                    {pendingKey === c.purchase_key
                      ? t("common.loading")
                      : t("expenses.realEstate.linkAction")}
                  </button>
                </td>
              </tr>
            ))}
        </Table>
      )}
    </Modal>
  );
}
