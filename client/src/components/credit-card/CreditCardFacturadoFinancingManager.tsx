import { useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import type { FlowCcExpenseLineRow } from "../../types";
import { formatClp } from "../../format";
import { formatYearMonthLabelEs } from "../../format";
import { Modal } from "../ui/Modal";
import {
  useCcFacturadoFinancingLinks,
  useDeleteCcFacturadoFinancingLinkMutation,
  useUpsertCcFacturadoFinancingLinkMutation,
} from "../../queries/hooks";

type FinancingCandidate = {
  key: string; // `${account_id}|${purchase_key}`
  account_id: number;
  purchase_key: string;
  merchant: string;
  amount_clp: number;
  purchase_month: string;
  origin_label: string;
};

/**
 * Tooling to declare a facturado paid in cuotas via one or more installment purchases.
 * Drives the expenses-tab projection (see server ccFacturadoFinancingProjectionLines.ts).
 */
export function CreditCardFacturadoFinancingManager({
  lines,
}: {
  lines: readonly FlowCcExpenseLineRow[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [financedAccountId, setFinancedAccountId] = useState<number | "">("");
  const [financedMonth, setFinancedMonth] = useState("");
  const [selectedFinancing, setSelectedFinancing] = useState<Set<string>>(new Set());

  const links = useCcFacturadoFinancingLinks();
  const upsert = useUpsertCcFacturadoFinancingLinkMutation();
  const del = useDeleteCcFacturadoFinancingLinkMutation();

  /** Accounts that have plain purchases (candidate financed facturados). */
  const financedAccounts = useMemo(() => {
    const byId = new Map<number, string>();
    for (const ln of lines) {
      if (ln.line_role === "purchase" && !byId.has(ln.account_id)) {
        byId.set(ln.account_id, ln.origin_label);
      }
    }
    return [...byId.entries()].map(([account_id, label]) => ({ account_id, label }));
  }, [lines]);

  const monthsForAccount = useMemo(() => {
    if (financedAccountId === "") return [];
    const set = new Set<string>();
    for (const ln of lines) {
      if (ln.line_role === "purchase" && ln.account_id === financedAccountId && ln.amount_clp > 0) {
        set.add(ln.billing_month);
      }
    }
    return [...set].sort().reverse();
  }, [lines, financedAccountId]);

  /** Installment purchases (candidate financing legs). */
  const financingCandidates = useMemo<FinancingCandidate[]>(() => {
    return lines
      .filter((ln) => ln.line_role === "installment_purchase_total")
      .map((ln) => ({
        key: `${ln.account_id}|${ln.purchase_key}`,
        account_id: ln.account_id,
        purchase_key: ln.purchase_key,
        merchant: ln.merchant ?? "",
        amount_clp: ln.amount_clp,
        purchase_month: ln.purchase_month,
        origin_label: ln.origin_label,
      }))
      .sort((a, b) => b.purchase_month.localeCompare(a.purchase_month));
  }, [lines]);

  const toggleFinancing = (key: string) => {
    setSelectedFinancing((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const canSave =
    financedAccountId !== "" && financedMonth !== "" && selectedFinancing.size > 0 && !upsert.isPending;

  const save = () => {
    if (financedAccountId === "" || financedMonth === "" || selectedFinancing.size === 0) return;
    const financing = [...selectedFinancing].map((k) => {
      const [accId, ...rest] = k.split("|");
      return { account_id: Number(accId), purchase_key: rest.join("|") };
    });
    upsert.mutate(
      {
        financed_account_id: financedAccountId,
        financed_billing_month: financedMonth,
        financing,
      },
      {
        onSuccess: () => {
          setFinancedAccountId("");
          setFinancedMonth("");
          setSelectedFinancing(new Set());
        },
      }
    );
  };

  const accountLabel = (accountId: number) =>
    financedAccounts.find((a) => a.account_id === accountId)?.label ?? `#${accountId}`;

  return (
    <>
      <button type="button" className="muted" onClick={() => setOpen(true)}>
        {t("expenses.creditCard.financing.openButton")}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t("expenses.creditCard.financing.title")}
        subtitle={t("expenses.creditCard.financing.intro")}
        closeAriaLabel={t("common.close")}
      >
        <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>
          {t("expenses.creditCard.financing.existingTitle")}
        </h3>
        {links.data && links.data.links.length > 0 ? (
          <ul style={{ listStyle: "none", padding: 0, margin: "0 0 1.25rem" }}>
            {links.data.links.map((link) => (
              <li
                key={link.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "1rem",
                  padding: "0.4rem 0",
                  borderBottom: "1px solid var(--border-subtle, #333)",
                }}
              >
                <span>
                  <strong>{accountLabel(link.financed_account_id)}</strong>{" "}
                  {formatYearMonthLabelEs(link.financed_billing_month)}
                  <span className="muted mono" style={{ marginLeft: "0.5rem", fontSize: "0.85em" }}>
                    {link.financing.length}× {t("expenses.creditCard.financing.financingShort")}
                  </span>
                </span>
                <button
                  type="button"
                  className="muted"
                  disabled={del.isPending}
                  onClick={() => del.mutate(link.id)}
                >
                  {t("expenses.creditCard.financing.remove")}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted" style={{ marginBottom: "1.25rem" }}>
            {t("expenses.creditCard.financing.none")}
          </p>
        )}

        <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>
          {t("expenses.creditCard.financing.newTitle")}
        </h3>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", marginBottom: "0.75rem" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <span className="label-inline">{t("expenses.creditCard.financing.accountLabel")}</span>
            <select
              value={financedAccountId}
              onChange={(e) => {
                setFinancedAccountId(e.target.value === "" ? "" : Number(e.target.value));
                setFinancedMonth("");
              }}
            >
              <option value="">{t("expenses.creditCard.financing.selectAccount")}</option>
              {financedAccounts.map((a) => (
                <option key={a.account_id} value={a.account_id}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <span className="label-inline">{t("expenses.creditCard.financing.monthLabel")}</span>
            <select
              value={financedMonth}
              onChange={(e) => setFinancedMonth(e.target.value)}
              disabled={financedAccountId === ""}
            >
              <option value="">{t("expenses.creditCard.financing.selectMonth")}</option>
              {monthsForAccount.map((m) => (
                <option key={m} value={m}>
                  {formatYearMonthLabelEs(m)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className="label-inline" style={{ marginBottom: "0.35rem" }}>
          {t("expenses.creditCard.financing.financingLabel")}
        </p>
        <ul style={{ listStyle: "none", padding: 0, margin: "0 0 1rem", maxHeight: "16rem", overflowY: "auto" }}>
          {financingCandidates.map((c) => (
            <label
              key={c.key}
              style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.25rem 0", cursor: "pointer" }}
            >
              <input
                type="checkbox"
                checked={selectedFinancing.has(c.key)}
                onChange={() => toggleFinancing(c.key)}
              />
              <span style={{ flex: 1 }}>
                {c.merchant || "—"}
                <span className="muted" style={{ marginLeft: "0.4rem", fontSize: "0.85em" }}>
                  {formatYearMonthLabelEs(c.purchase_month)} · {c.origin_label}
                </span>
              </span>
              <span className="mono">{formatClp(c.amount_clp)}</span>
            </label>
          ))}
        </ul>

        <button type="button" disabled={!canSave} onClick={save}>
          {t("expenses.creditCard.financing.save")}
        </button>
        {upsert.isError ? (
          <p className="error" style={{ marginTop: "0.5rem" }}>
            {upsert.error instanceof Error ? upsert.error.message : t("common.loadFailed")}
          </p>
        ) : null}
      </Modal>
    </>
  );
}
