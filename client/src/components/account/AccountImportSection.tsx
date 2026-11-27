import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "../../queries/keys";
import { api } from "../../api";
import { useTranslation } from "../../i18n";
import { AccountImportPanel, useAccountImportSlots } from "./AccountImportPanel";
import { PageGridTile } from "../layout/PageGridTile";

type Props = {
  accountId: number;
};

export function AccountImportSection({ accountId }: Props) {
  const { t } = useTranslation();
  const { data: specs } = useQuery({
    queryKey: queryKeys.accountImportSpecs(accountId),
    queryFn: () => api.accountImportSpecs(accountId),
  });
  const slots = useAccountImportSlots(accountId, specs ?? null, t);
  if (!slots.length) return null;
  return (
    <PageGridTile id="import">
      <AccountImportPanel
        accountId={accountId}
        slots={slots}
      />
    </PageGridTile>
  );
}
