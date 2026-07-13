import { useState } from "react";
import { Modal } from "../ui/Modal";
import { Table } from "../ui/Table";
import { addCalendarMonths } from "../../calendarMonth";
import { formatClp } from "../../format";
import { expenseKindLabel, useTranslation } from "../../i18n";
import { useRealEstateUnlinkedPurchases } from "../../queries/hooks";
import { useAssignRealEstatePurchaseMutation } from "../../queries/mutations";

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

/** Gastos category slug for utility bills («Cuentas y servicios»). */
const BILLS_CATEGORY = "bills";

type Props = {
  place: { slug: string; label: string } | null;
  open: boolean;
  onClose: () => void;
};

/**
 * Purchase-first linking: pick unlinked gastos purchases and assign them to this place
 * as bills of the chosen kind — each bill row is created from the purchase itself.
 * Defaults scope the pool to the place's occupancy period and the «Cuentas y servicios»
 * category; multi-select assigns a whole run of months in one click.
 */
export function RealEstateAssignPurchaseModal({ place, open, onClose }: Props) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<string>("rent");
  const [onlyBills, setOnlyBills] = useState(true);
  const [billPreviousMonth, setBillPreviousMonth] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const { data, isLoading, error } = useRealEstateUnlinkedPurchases(
    {
      q: q.trim(),
      place: place?.slug,
      kind,
      category: onlyBills ? BILLS_CATEGORY : undefined,
    },
    open && place != null
  );
  const assignMutation = useAssignRealEstatePurchaseMutation();

  const err =
    error instanceof Error
      ? error.message
      : assignMutation.error instanceof Error
        ? assignMutation.error.message
        : null;

  const purchases = data?.purchases ?? [];

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const assignKeys = async (keys: string[]) => {
    if (!place || keys.length === 0) return;
    setBusy(true);
    try {
      for (const key of keys) {
        const purchase = purchases.find((p) => p.purchase_key === key);
        await assignMutation.mutateAsync({
          purchase_key: key,
          account_slug: place.slug,
          kind,
          bill_month:
            billPreviousMonth && purchase
              ? addCalendarMonths(purchase.purchase_month, -1)
              : undefined,
        });
      }
      setSelected(new Set());
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("expenses.realEstate.assignModalTitle")}
      subtitle={place?.label ?? null}
      closeAriaLabel={t("expenses.realEstate.linkModalClose")}
    >
      <div
        style={{
          display: "flex",
          gap: "0.75rem",
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: "0.75rem",
        }}
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
        <label className="radio-pill" style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
          <input
            type="checkbox"
            checked={onlyBills}
            onChange={(e) => setOnlyBills(e.target.checked)}
          />
          {t("expenses.realEstate.onlyBillsToggle")}
        </label>
        <label className="radio-pill" style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
          <input
            type="checkbox"
            checked={billPreviousMonth}
            onChange={(e) => setBillPreviousMonth(e.target.checked)}
          />
          {t("expenses.realEstate.billPreviousMonthToggle")}
        </label>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("expenses.realEstate.assignSearchPlaceholder")}
          style={{ flex: 1, minWidth: "10rem" }}
        />
        <button
          type="button"
          className="btn"
          disabled={busy || selected.size === 0}
          onClick={() => void assignKeys([...selected])}
        >
          {busy
            ? t("common.loading")
            : t("expenses.realEstate.assignSelected", { count: selected.size })}
        </button>
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
                <th />
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
              <td>
                <input
                  type="checkbox"
                  checked={selected.has(p.purchase_key)}
                  onChange={() => toggle(p.purchase_key)}
                />
              </td>
              <td>
                {p.merchant ?? "—"}
                {p.merchant_matches ? (
                  <span className="muted" style={{ marginLeft: "0.35rem", fontSize: "0.75rem" }}>
                    ({t("expenses.realEstate.merchantMatchHintKind")})
                  </span>
                ) : null}
              </td>
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
                  disabled={busy}
                  onClick={() => void assignKeys([p.purchase_key])}
                >
                  {t("expenses.realEstate.assignConfirm")}
                </button>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Modal>
  );
}
