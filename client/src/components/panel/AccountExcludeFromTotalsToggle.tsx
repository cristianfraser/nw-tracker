import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { queryKeys } from "../../queries/keys";

type Props = {
  accountId: number;
  excluded: boolean;
};

async function invalidateAccountPanelQueries(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.accountsAll() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.panelNetWorthTree() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.sidebarNav() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboard("clp") }),
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboard("usd") }),
  ]);
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
