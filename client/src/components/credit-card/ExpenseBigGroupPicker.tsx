import { useCallback, useState } from "react";
import { Button } from "@crfrsr/ui";
import { useTranslation } from "../../i18n";
import {
  useCreateCcExpenseBigGroupMutation,
  usePutCcExpensePurchaseBigGroupMutation,
} from "../../queries/hooks";
import type { CcExpenseBigGroupDto } from "../../types";
import { PillPicker } from "../ui/PillPicker";

/** Big groups carry no colour of their own: one neutral pill for all. */
const BIG_GROUP_PILL_COLOR = "#475569";

/** An expense's big group (trip, remodeling…) as a pill picker, like its category. */
export function ExpenseBigGroupPicker({
  purchaseKey,
  value,
  groups,
}: {
  purchaseKey: string;
  value: string | null;
  groups: readonly CcExpenseBigGroupDto[];
}) {
  const { t } = useTranslation();
  const put = usePutCcExpensePurchaseBigGroupMutation();
  const create = useCreateCcExpenseBigGroupMutation();
  const [creating, setCreating] = useState(false);

  const pending =
    (put.isPending && put.variables?.purchase_key === purchaseKey) || create.isPending || creating;

  const persist = useCallback(
    (groupSlug: string | null) => put.mutate({ purchase_key: purchaseKey, group_slug: groupSlug }),
    [purchaseKey, put]
  );

  const onCreate = async () => {
    setCreating(true);
    try {
      const label = window.prompt(t("expenses.creditCard.bigGroups.createPrompt"));
      const trimmed = label?.trim();
      if (!trimmed) return;
      const group = await create.mutateAsync(trimmed);
      persist(group.slug);
    } catch {
      /* mutation onError */
    } finally {
      setCreating(false);
    }
  };

  const current = groups.find((g) => g.slug === value);
  const shown = current ? { key: current.slug, label: current.label, color: BIG_GROUP_PILL_COLOR } : null;
  return (
    <PillPicker
      value={shown}
      emptyLabel={t("expenses.creditCard.lineRow.noBigGroup")}
      options={groups.map((g) => ({ key: g.slug, label: g.label, color: BIG_GROUP_PILL_COLOR }))}
      onSelect={(slug) => persist(slug)}
      onClear={() => persist(null)}
      clearLabel={t("expenses.creditCard.lineRow.clearBigGroupAria")}
      ariaLabel={t("expenses.creditCard.lineRow.bigGroupPickerAria", {
        group: shown?.label ?? t("expenses.creditCard.lineRow.noBigGroup"),
      })}
      pending={pending}
      footer={
        <Button variant="ghost" size="sm" onClick={() => void onCreate()}>
          {t("expenses.creditCard.bigGroups.createOption")}
        </Button>
      }
    />
  );
}
