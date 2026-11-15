import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { invalidateResources, resources } from "../../queries/resources";

type Props = {
  accountId: number;
  excluded: boolean;
};

async function invalidateAccountPanelQueries(queryClient: ReturnType<typeof useQueryClient>) {
  await invalidateResources(queryClient, resources.panelAccounts());
}

export function AccountExcludeFromTotalsToggle({ accountId, excluded }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (nextExcluded: boolean) =>
      api.updateAccountExcludeFromGroupTotals(accountId, nextExcluded),
    onSuccess: () => invalidateAccountPanelQueries(queryClient),
  });

  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
      <input
        type="checkbox"
        checked={excluded}
        disabled={mutation.isPending}
        aria-label={t("panelAccounts.addAccount.excludeFromTotals")}
        onChange={(e) => mutation.mutate(e.target.checked)}
      />
    </label>
  );
}
