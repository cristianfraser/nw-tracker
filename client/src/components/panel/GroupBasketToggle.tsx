import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { invalidateResources, resources } from "../../queries/resources";

type Props = {
  slug: string;
  basket: boolean;
};

/** Declares a portfolio group a basket (`portfolio_groups.basket`); the nav tree carries it back as `basket`. */
export function GroupBasketToggle({ slug, basket }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (next: boolean) => api.updatePortfolioGroupBasket(slug, next),
    onSuccess: () => invalidateResources(queryClient, resources.panelAccounts()),
  });
  return (
    <input
      type="checkbox"
      checked={basket}
      disabled={mutation.isPending}
      aria-label={t("panelAccounts.groupBasketToggle")}
      onChange={(e) => mutation.mutate(e.target.checked)}
    />
  );
}
