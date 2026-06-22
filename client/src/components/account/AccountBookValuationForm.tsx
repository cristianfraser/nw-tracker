import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { formatClp } from "../../format";
import { queryKeys, type DisplayUnit } from "../../queries/keys";
import { Table } from "../ui/Table";
import {
  brokerageMovementFieldLabelStyle,
  brokerageMovementFieldRowStyle,
} from "../panel/BrokerageMovementsSection";

type Props = {
  accountId: number;
  displayUnit: DisplayUnit;
  extraCcOffsetsKey: string;
};

export function AccountBookValuationForm({ accountId, displayUnit, extraCcOffsetsKey }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [asOfDate, setAsOfDate] = useState("");
  const [valueClp, setValueClp] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const valuationsQuery = useQuery({
    queryKey: ["accountValuations", accountId],
    queryFn: () => api.accountValuations(accountId),
  });

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.accountDetail(String(accountId), displayUnit, "monthly", extraCcOffsetsKey),
      }),
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(displayUnit) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboardNav(displayUnit) }),
      queryClient.invalidateQueries({ queryKey: ["accountValuations", accountId] }),
    ]);
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const value_clp = Number(valueClp.replace(/\./g, "").replace(",", "."));
      if (!Number.isFinite(value_clp)) {
        throw new Error(t("accountDetail.bookLedger.valuationValueInvalid"));
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
        throw new Error(t("accountDetail.bookLedger.dateInvalid"));
      }
      return api.createAccountValuation(accountId, { as_of_date: asOfDate, value_clp });
    },
    onSuccess: async () => {
      setFormError(null);
      setSaved(true);
      setAsOfDate("");
      setValueClp("");
      await invalidate();
    },
    onError: (err: Error) => {
      setSaved(false);
      setFormError(err.message);
    },
  });

  const recentRows = (valuationsQuery.data?.valuations ?? []).slice(0, 5);

  return (
    <fieldset style={{ border: "none", padding: 0, margin: "0 0 1.25rem" }}>
      <legend className="flow-section-title" style={{ marginBottom: "0.5rem" }}>
        {t("accountDetail.bookLedger.valuationTitle")}
      </legend>
      <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.75rem" }}>
        {t("accountDetail.bookLedger.valuationHint")}
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(9rem, 1fr))",
          gap: "0.5rem 0.75rem",
          alignItems: "end",
          maxWidth: "28rem",
        }}
      >
        <label style={brokerageMovementFieldRowStyle()}>
          <span style={brokerageMovementFieldLabelStyle()}>{t("accountDetail.bookLedger.dateLabel")}</span>
          <input type="date" value={asOfDate} onChange={(e) => { setAsOfDate(e.target.value); setSaved(false); }} />
        </label>
        <label style={brokerageMovementFieldRowStyle()}>
          <span style={brokerageMovementFieldLabelStyle()}>{t("accountDetail.bookLedger.valueClpLabel")}</span>
          <input
            type="text"
            inputMode="decimal"
            value={valueClp}
            placeholder="1325724"
            onChange={(e) => { setValueClp(e.target.value); setSaved(false); }}
          />
        </label>
        <div style={{ ...brokerageMovementFieldRowStyle(), display: "flex", alignItems: "flex-end" }}>
          <button type="button" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            {saveMutation.isPending ? t("common.loading") : t("accountDetail.bookLedger.valuationSaveBtn")}
          </button>
        </div>
      </div>

      {formError ? <p className="error" style={{ marginTop: "0.75rem" }}>{formError}</p> : null}
      {saved ? (
        <p className="muted" style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
          {t("accountDetail.bookLedger.valuationSaved")}
        </p>
      ) : null}

      {recentRows.length > 0 ? (
        <>
          <p className="muted" style={{ fontSize: "0.85rem", margin: "1rem 0 0.5rem" }}>
            {t("accountDetail.bookLedger.recentValuations")}
          </p>
          <Table
            header={
              <thead>
                <tr>
                  <th>{t("accountDetail.bookLedger.dateLabel")}</th>
                  <th>{t("accountDetail.bookLedger.valueClpLabel")}</th>
                </tr>
              </thead>
            }
          >
            {recentRows.map((row) => (
              <tr key={row.id}>
                <td>{row.as_of_date}</td>
                <td className="mono">{formatClp(row.value_clp)}</td>
              </tr>
            ))}
          </Table>
        </>
      ) : null}
    </fieldset>
  );
}
