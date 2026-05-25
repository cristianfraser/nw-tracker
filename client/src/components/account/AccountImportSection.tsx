import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { useTranslation } from "../../i18n";
import { AccountImportPanel, useAccountImportSlots } from "./AccountImportPanel";

type Props = {
  accountId: number;
  displayUnit: "clp" | "usd";
  extraCcOffsetsKey?: string;
};

export function AccountImportSection({ accountId, displayUnit, extraCcOffsetsKey }: Props) {
  const { t } = useTranslation();
  const { data: specs } = useQuery({
    queryKey: ["accountImportSpecs", accountId],
    queryFn: () => api.accountImportSpecs(accountId),
  });
  const slots = useAccountImportSlots(accountId, specs ?? null, t);
  if (!slots.length) return null;
  return (
    <AccountImportPanel
      accountId={accountId}
      displayUnit={displayUnit}
      extraCcOffsetsKey={extraCcOffsetsKey}
      slots={slots}
    />
  );
}
