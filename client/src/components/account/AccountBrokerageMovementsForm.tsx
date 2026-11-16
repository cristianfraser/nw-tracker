import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { BrokerageMovementsSection } from "../panel/BrokerageMovementsSection";
import {
  buildBrokerageMovementPostBody,
  cashCurrencyByAccountId,
  type InitialMovementDraft,
} from "../../panelAccounts/stockAccountFormTypes";
import { type BrokerageFlowKind } from "../../panelAccounts/brokerageFlowKinds";
import { useAccountsAll } from "../../queries/hooks";
import type { DisplayUnit } from "../../queries/keys";
import { invalidateResources, resources } from "../../queries/resources";
import { Button } from "@crfrsr/ui";

type Props = {
  accountId: number;
  displayUnit: DisplayUnit;
  /** The kinds this account's form offers (an option contract's differ from a stock's). */
  flowKinds?: readonly BrokerageFlowKind[];
};

/**
 * The movement form of a stock or option contract account. A trade, a dividend and a premium
 * settle against a cash account in any currency: the amount is typed and posted in the currency
 * that account holds (the accounts list's `cash_currency`).
 */
export function AccountBrokerageMovementsForm({ accountId, displayUnit, flowKinds }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: accountsData } = useAccountsAll();
  const [movements, setMovements] = useState<InitialMovementDraft[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [lastSavedCount, setLastSavedCount] = useState<number | null>(null);

  const saveMutation = useMutation({
    mutationFn: async (rows: InitialMovementDraft[]) => {
      const cashCurrencies = cashCurrencyByAccountId(accountsData?.accounts ?? []);
      const bodies = rows
        .map((row) => buildBrokerageMovementPostBody(row, cashCurrencies))
        .filter((b): b is Record<string, unknown> => b != null);
      // A row with no date, or a trade with no cash account chosen, has no body: nothing is
      // posted until every row has one.
      if (bodies.length === 0 || bodies.length !== rows.length) {
        throw new Error(t("accountDetail.brokerageMovements.rowIncomplete"));
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
        emptyTextKey="accountDetail.brokerageMovements.emptyDraft"
        currentAccountId={accountId}
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
