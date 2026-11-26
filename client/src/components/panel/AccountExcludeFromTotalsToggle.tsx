import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { invalidateResources, resources } from "../../queries/resources";
import styles from "./PanelForm.module.css";

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
    <label className={styles.check}>
      <input
        type="checkbox"
        checked={excluded}
        disabled={mutation.isPending}
        onChange={(e) => mutation.mutate(e.target.checked)}
      />
      <span>{t("panelAccounts.addAccount.excludeFromTotals")}</span>
    </label>
  );
}
