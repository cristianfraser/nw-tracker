import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { USD_CASH_FLOW_KINDS } from "../../panelAccounts/brokerageFlowKinds";
import {
  buildUsdCashMovementPostBody,
} from "../../panelAccounts/usdCashAccountFormTypes";
import { type InitialMovementDraft } from "../../panelAccounts/stockAccountFormTypes";
import type { DisplayUnit } from "../../queries/keys";
import { invalidateResources, resources } from "../../queries/resources";
import { BrokerageMovementsSection } from "../panel/BrokerageMovementsSection";
import { Button } from "@crfrsr/ui";

type Props = {
  accountId: number;
  displayUnit: DisplayUnit;
};

export function AccountUsdCashMovementsForm({ accountId, displayUnit }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [movements, setMovements] = useState<InitialMovementDraft[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [lastSavedCount, setLastSavedCount] = useState<number | null>(null);

  const saveMutation = useMutation({
    mutationFn: async (rows: InitialMovementDraft[]) => {
      const bodies = rows
        .map((row) => buildUsdCashMovementPostBody(row))
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
      await invalidateResources(queryClient, resources.accountMovements(accountId, displayUnit));
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
        titleKey="accountDetail.usdCashMovements.title"
        hintKey={null}
        emptyTextKey="accountDetail.usdCashMovements.emptyDraft"
        currentAccountId={accountId}
        flowKinds={USD_CASH_FLOW_KINDS}
        cashCurrency="usd"
      />

      {movements.length > 0 ? (
        <div>
          <Button
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate(movements)}
          >
            {saveMutation.isPending
              ? t("common.loading")
              : t("accountDetail.usdCashMovements.saveBtn")}
          </Button>
        </div>
      ) : null}

      {formError ? <p className="error">{formError}</p> : null}
      {lastSavedCount != null ? (
        <p className="muted">{t("accountDetail.usdCashMovements.saved", { count: lastSavedCount })}</p>
      ) : null}
    </section>
  );
}
