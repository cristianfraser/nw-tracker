import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { queryKeys } from "../../queries/keys";
import {
  leafBucketSlugForAccount,
  listLeafPortfolioGroupBuckets,
} from "../../panelAccounts/portfolioNavBuckets";
import { Modal } from "../ui/Modal";
import type { AccountListRow, NavTreeNodeDto } from "../../types";

type Props = {
  account: AccountListRow;
  netWorthRoot: NavTreeNodeDto | null;
  onClose: () => void;
};

/** Panel accounts table edit modal: rename and/or move the account to another leaf bucket. */
export function EditAccountModal({ account, netWorthRoot, onClose }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const leafBuckets = useMemo(() => listLeafPortfolioGroupBuckets(netWorthRoot), [netWorthRoot]);
  const currentBucketSlug = useMemo(
    () => leafBucketSlugForAccount(netWorthRoot, account.id),
    [netWorthRoot, account.id]
  );

  const [name, setName] = useState(account.name);
  const [bucketSlug, setBucketSlug] = useState(currentBucketSlug ?? "");
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const nameChanged = trimmedName !== account.name;
  const bucketChanged = bucketSlug !== "" && bucketSlug !== (currentBucketSlug ?? "");
  const canSave = trimmedName.length > 0 && (nameChanged || bucketChanged);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.updateAccount(account.id, {
        ...(nameChanged ? { name: trimmedName } : {}),
        ...(bucketChanged ? { bucket_slug: bucketSlug } : {}),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.accountsAll() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.panelNetWorthTree() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.sidebarNav() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard("clp") }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard("usd") }),
      ]);
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={t("panelAccounts.editModal.title", { id: account.id })}
      subtitle={account.name}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={saveMutation.isPending}>
            {t("common.cancel")}
          </button>{" "}
          <button
            type="button"
            onClick={() => saveMutation.mutate()}
            disabled={!canSave || saveMutation.isPending}
          >
            {saveMutation.isPending ? t("common.saving") : t("common.save")}
          </button>
        </>
      }
    >
      {error ? <p className="error">{error}</p> : null}
      <p>
        <label>
          {t("panelAccounts.addAccount.displayName")}{" "}
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        </label>
      </p>
      <p>
        <label>
          {t("panelAccounts.addAccount.bucket")}{" "}
          <select
            value={bucketSlug}
            onChange={(e) => {
              setBucketSlug(e.target.value);
              setError(null);
            }}
          >
            {currentBucketSlug == null ? (
              <option value="">{t("panelAccounts.editModal.keepBucket")}</option>
            ) : null}
            {leafBuckets.map((b) => (
              <option key={b.slug} value={b.slug}>
                {b.label} ({b.slug})
              </option>
            ))}
          </select>
        </label>
      </p>
    </Modal>
  );
}
