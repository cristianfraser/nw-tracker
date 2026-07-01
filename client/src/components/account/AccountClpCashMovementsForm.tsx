import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { CLP_CASH_FLOW_KINDS } from "../../panelAccounts/brokerageFlowKinds";
import { buildClpCashMovementPostBody } from "../../panelAccounts/clpCashAccountFormTypes";
import { type InitialMovementDraft } from "../../panelAccounts/stockAccountFormTypes";
import { queryKeys, type DisplayUnit } from "../../queries/keys";
import { BrokerageMovementsSection } from "../panel/BrokerageMovementsSection";

type Props = {
  accountId: number;
  displayUnit: DisplayUnit;
  extraCcOffsetsKey: string;
};

export function AccountClpCashMovementsForm({ accountId, displayUnit, extraCcOffsetsKey }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [movements, setMovements] = useState<InitialMovementDraft[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [lastSavedCount, setLastSavedCount] = useState<number | null>(null);

  const saveMutation = useMutation({
    mutationFn: async (rows: InitialMovementDraft[]) => {
      const bodies = rows
        .map((row) => buildClpCashMovementPostBody(row))
        .filter((b): b is Record<string, unknown> => b != null);
      if (bodies.length === 0 || bodies.length !== rows.length) {
        throw new Error(t("panelAccounts.addAccount.previewInvalid"));
      }
      for (const body of bodies) {
        await api.createAccountMovement(accountId, body);
      }
      return bodies.length;
    },
    onSuccess: async (count) => {
      setMovements([]);
      setFormError(null);
      setLastSavedCount(count);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.accountDetail(String(accountId), displayUnit, "monthly", extraCcOffsetsKey),
        }),
        queryClient.invalidateQueries({ queryKey: ["accountFlows"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(displayUnit) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboardNav(displayUnit) }),
      ]);
    },
    onError: (err: Error) => {
      setFormError(err.message);
      setLastSavedCount(null);
    },
  });

  return (
    <section style={{ marginBottom: "1.5rem" }}>
      <BrokerageMovementsSection
        movements={movements}
        onChange={(next) => {
          setMovements(next);
          setFormError(null);
          setLastSavedCount(null);
        }}
        legend="add"
        titleKey="accountDetail.clpCashMovements.title"
        hintKey="accountDetail.clpCashMovements.hint"
        emptyTextKey="accountDetail.clpCashMovements.emptyDraft"
        currentAccountId={accountId}
        flowKinds={CLP_CASH_FLOW_KINDS}
        cashCurrency="clp"
      />

      {movements.length > 0 ? (
        <div style={{ marginTop: "0.75rem" }}>
          <button
            type="button"
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate(movements)}
          >
            {saveMutation.isPending
              ? t("common.loading")
              : t("accountDetail.clpCashMovements.saveBtn")}
          </button>
        </div>
      ) : null}

      {formError ? <p className="error">{formError}</p> : null}
      {lastSavedCount != null ? (
        <p className="muted">{t("accountDetail.clpCashMovements.saved", { count: lastSavedCount })}</p>
      ) : null}
    </section>
  );
}
