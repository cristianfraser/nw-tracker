import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { invalidateResources, resources } from "../../queries/resources";
import {
  leafBucketSlugForAccount,
  listLeafPortfolioGroupBuckets,
} from "../../panelAccounts/portfolioNavBuckets";
import { Modal } from "../ui/Modal";
import type { AccountListRow, NavTreeNodeDto } from "../../types";
import { Button } from "@crfrsr/ui";
import { cn } from "../../cn";
import styles from "./PanelForm.module.css";

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
      await invalidateResources(queryClient, resources.panelAccounts());
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
          <Button variant="secondary" onClick={onClose} disabled={saveMutation.isPending}>
            {t("common.cancel")}
          </Button>{" "}
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={!canSave || saveMutation.isPending}
          >
            {saveMutation.isPending ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      {error ? <p className="error">{error}</p> : null}
      <div className={cn(styles.form, styles.stacked)}>
        <label className={styles.field}>
          <span className="muted">{t("panelAccounts.addAccount.displayName")}</span>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        </label>
        <label className={styles.field}>
          <span className="muted">{t("panelAccounts.addAccount.bucket")}</span>
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
      </div>
    </Modal>
  );
}
