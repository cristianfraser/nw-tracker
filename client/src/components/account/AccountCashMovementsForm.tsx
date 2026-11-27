import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { buildCashMovementPostBody, cashFlowKindsFor } from "../../panelAccounts/cashAccountFormTypes";
import { type InitialMovementDraft } from "../../panelAccounts/stockAccountFormTypes";
import { invalidateResources, resources } from "../../queries/resources";
import { BrokerageMovementsSection } from "../panel/BrokerageMovementsSection";
import { Button } from "@crfrsr/ui";

type Props = {
  accountId: number;
  /** The currency the cash ledger holds (the server's `movement_create.cash_currency`). */
  currency: string;
};

/** The movement form of a cash ledger account, in whatever currency the account holds. */
export function AccountCashMovementsForm({ accountId, currency }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [movements, setMovements] = useState<InitialMovementDraft[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [lastSavedCount, setLastSavedCount] = useState<number | null>(null);

  const saveMutation = useMutation({
    mutationFn: async (rows: InitialMovementDraft[]) => {
      const bodies = rows
        .map((row) => buildCashMovementPostBody(row, currency))
        .filter((b): b is Record<string, unknown> => b != null);
      if (bodies.length === 0 || bodies.length !== rows.length) {
        throw new Error(t("accountDetail.cashMovements.rowIncomplete"));
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
      await invalidateResources(queryClient, resources.accountMovements(accountId));
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
        titleKey="accountDetail.cashMovements.title"
        hintKey="accountDetail.cashMovements.hint"
        emptyTextKey="accountDetail.cashMovements.emptyDraft"
        currentAccountId={accountId}
        flowKinds={cashFlowKindsFor(currency)}
        cashCurrency={currency}
      />

      {movements.length > 0 ? (
        <div>
          <Button
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate(movements)}
          >
            {saveMutation.isPending
              ? t("common.loading")
              : t("accountDetail.cashMovements.saveBtn")}
          </Button>
        </div>
      ) : null}

      {formError ? <p className="error">{formError}</p> : null}
      {lastSavedCount != null ? (
        <p className="muted">{t("accountDetail.cashMovements.saved", { count: lastSavedCount })}</p>
      ) : null}
    </section>
  );
}
