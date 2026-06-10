import { useCallback, useState } from "react";
import { useTranslation } from "../../i18n";
import {
  useCreateCcExpenseBigGroupMutation,
  usePutCcExpensePurchaseBigGroupMutation,
} from "../../queries/hooks";
import type { CcExpenseBigGroupDto } from "../../types";
import styles from "./CreditCardExpenseLinesSelection.module.css";

const CREATE_VALUE = "__create_big_group__";

export function ExpenseBigGroupSelect({
  accountId,
  purchaseKey,
  value,
  groups,
  disabled = false,
}: {
  accountId: number;
  purchaseKey: string;
  value: string | null;
  groups: readonly CcExpenseBigGroupDto[];
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const put = usePutCcExpensePurchaseBigGroupMutation();
  const create = useCreateCcExpenseBigGroupMutation();
  const [creating, setCreating] = useState(false);

  const rowPending =
    (put.isPending &&
      put.variables?.account_id === accountId &&
      put.variables?.purchase_key === purchaseKey) ||
    create.isPending;

  const persist = useCallback(
    (groupSlug: string | null) => {
      if (disabled || !purchaseKey) return;
      put.mutate({
        account_id: accountId,
        purchase_key: purchaseKey,
        group_slug: groupSlug,
      });
    },
    [accountId, disabled, purchaseKey, put]
  );

  const onCreate = async () => {
    try {
      const label = window.prompt(t("expenses.creditCard.bigGroups.createPrompt"));
      if (label == null) return;
      const trimmed = label.trim();
      if (!trimmed) return;
      const group = await create.mutateAsync(trimmed);
      persist(group.slug);
    } catch {
      /* mutation onError */
    } finally {
      setCreating(false);
    }
  };

  return (
    <select
      className={styles.categorySelect}
      value={value ?? ""}
      disabled={disabled || !purchaseKey || rowPending || creating}
      aria-busy={rowPending || creating || undefined}
      aria-label={t("expenses.creditCard.bigGroups.selectAria")}
      onChange={(e) => {
        const next = e.target.value;
        if (next === CREATE_VALUE) {
          setCreating(true);
          void onCreate();
          return;
        }
        persist(next ? next : null);
      }}
    >
      <option value="">{t("expenses.creditCard.bigGroups.none")}</option>
      {groups.map((g) => (
        <option key={g.slug} value={g.slug}>
          {g.label}
        </option>
      ))}
      <option value={CREATE_VALUE}>{t("expenses.creditCard.bigGroups.createOption")}</option>
    </select>
  );
}
