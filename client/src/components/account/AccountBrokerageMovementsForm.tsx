import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { BrokerageMovementsSection } from "../panel/BrokerageMovementsSection";
import {
  buildBrokerageMovementPostBody,
  type InitialMovementDraft,
} from "../../panelAccounts/stockAccountFormTypes";
import { type BrokerageFlowKind, type StockQuoteCurrency } from "../../panelAccounts/brokerageFlowKinds";
import { queryKeys, type DisplayUnit } from "../../queries/keys";
import { Button } from "@crfrsr/ui";

type Props = {
  accountId: number;
  /** Stock's quote currency from the summary DTO (present even before the first movement). */
  quoteCurrency?: StockQuoteCurrency | null;
  displayUnit: DisplayUnit;
  /** The kinds this account's form offers (an option contract's differ from a stock's). */
  flowKinds?: readonly BrokerageFlowKind[];
};

export function AccountBrokerageMovementsForm({
  accountId,
  quoteCurrency,
  displayUnit,
  flowKinds,
}: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [movements, setMovements] = useState<InitialMovementDraft[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [lastSavedCount, setLastSavedCount] = useState<number | null>(null);

  const saveMutation = useMutation({
    mutationFn: async (rows: InitialMovementDraft[]) => {
      const bodies = rows
        .map((row) => buildBrokerageMovementPostBody(row, quoteCurrency ?? undefined))
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
          queryKey: queryKeys.accountDetail(String(accountId), displayUnit, "monthly"),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.accountFlowsAll() }),
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
    <section>
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
        flowKinds={flowKinds}
      />

      {movements.length > 0 ? (
        <div>
          <Button
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate(movements)}
          >
            {saveMutation.isPending
              ? t("common.loading")
              : t("accountDetail.brokerageMovements.saveBtn")}
          </Button>
        </div>
      ) : null}

      {formError ? (
        <p className="error" style={{ margin: 0 }}>
          {formError}
        </p>
      ) : null}
      {lastSavedCount != null ? (
        <p className="muted" style={{ fontSize: "var(--font-size-prose)", margin: 0 }}>
          {t("accountDetail.brokerageMovements.saveSuccess", { count: lastSavedCount })}
        </p>
      ) : null}
    </section>
  );
}
