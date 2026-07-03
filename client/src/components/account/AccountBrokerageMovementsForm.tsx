import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { BrokerageMovementsSection } from "../panel/BrokerageMovementsSection";
import {
  buildBrokerageMovementPostBody,
  type InitialMovementDraft,
} from "../../panelAccounts/stockAccountFormTypes";
import { type StockQuoteCurrency } from "../../panelAccounts/brokerageFlowKinds";
import { queryKeys, type DisplayUnit } from "../../queries/keys";

type Props = {
  accountId: number;
  ticker?: string | null;
  /** Stock's quote currency from the summary DTO (present even before the first movement). */
  quoteCurrency?: StockQuoteCurrency | null;
  displayUnit: DisplayUnit;
  extraCcOffsetsKey: string;
};

export function AccountBrokerageMovementsForm({
  accountId,
  ticker,
  quoteCurrency,
  displayUnit,
  extraCcOffsetsKey,
}: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [movements, setMovements] = useState<InitialMovementDraft[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [lastSavedCount, setLastSavedCount] = useState<number | null>(null);

  const saveMutation = useMutation({
    mutationFn: async (rows: InitialMovementDraft[]) => {
      const bodies = rows
        .map((row) => buildBrokerageMovementPostBody(row, ticker, quoteCurrency ?? undefined))
        .filter((b): b is Record<string, unknown> => b != null);
      if (bodies.length === 0) {
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
        emptyTextKey="accountDetail.brokerageMovements.emptyDraft"
        currentAccountId={accountId}
        stockQuoteCurrency={quoteCurrency ?? undefined}
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
              : t("accountDetail.brokerageMovements.saveBtn")}
          </button>
        </div>
      ) : null}

      {formError ? (
        <p className="error" style={{ marginTop: "0.75rem" }}>
          {formError}
        </p>
      ) : null}
      {lastSavedCount != null ? (
        <p className="muted" style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
          {t("accountDetail.brokerageMovements.saveSuccess", { count: lastSavedCount })}
        </p>
      ) : null}
    </section>
  );
}
