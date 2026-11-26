import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { loadableClass } from "../ui/Loadable";
import { OpenRow, OpenRows } from "../ui/OpenRows";
import type { ExpenseGenericUniqueMerchantRow } from "../../types";
import { Button, Input } from "@crfrsr/ui";
import {
  useCreateGenericUniqueMerchantMutation,
  useDeleteGenericUniqueMerchantMutation,
  useUpdateGenericUniqueMerchantMutation,
} from "../../queries/hooks";
import styles from "./GenericUniqueMerchantsPanel.module.css";

type Props = {
  merchants: ExpenseGenericUniqueMerchantRow[];
  loading?: boolean;
};

/**
 * The merchants whose expenses are tagged «One-off» on import: one line per name with Edit and
 * Remove (Edit turns the line into the field), and a field to add one.
 */
export function GenericUniqueMerchantsPanel({ merchants, loading }: Props) {
  const { t } = useTranslation();
  const createMutation = useCreateGenericUniqueMerchantMutation();
  const updateMutation = useUpdateGenericUniqueMerchantMutation();
  const deleteMutation = useDeleteGenericUniqueMerchantMutation();

  const [newMerchant, setNewMerchant] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  function onAdd(e: FormEvent) {
    e.preventDefault();
    const trimmed = newMerchant.trim();
    if (!trimmed) return;
    setFormError(null);
    createMutation.mutate(trimmed, {
      onSuccess: () => setNewMerchant(""),
      onError: (err: Error) => setFormError(err.message),
    });
  }

  function startEdit(row: ExpenseGenericUniqueMerchantRow) {
    setEditingId(row.id);
    setEditDraft(row.merchant_key);
    setFormError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft("");
    setFormError(null);
  }

  function saveEdit(id: number) {
    const trimmed = editDraft.trim();
    if (!trimmed) return;
    setFormError(null);
    updateMutation.mutate(
      { id, merchant: trimmed },
      {
        onSuccess: () => cancelEdit(),
        onError: (err: Error) => setFormError(err.message),
      }
    );
  }

  function onDelete(id: number, merchantKey: string) {
    if (!window.confirm(t("importSync.genericUniqueMerchants.confirmDelete", { merchant: merchantKey }))) {
      return;
    }
    setFormError(null);
    deleteMutation.mutate(id, {
      onError: (err: Error) => setFormError(err.message),
    });
  }

  const busy =
    createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;

  return (
    <div className={loadableClass(loading)} aria-busy={loading || undefined}>
      {formError ? <p className="error">{formError}</p> : null}

      <OpenRows
        empty={merchants.length === 0 && !loading ? t("importSync.genericUniqueMerchants.empty") : undefined}
      >
        {merchants.map((row) =>
          editingId === row.id ? (
            <OpenRow
              key={row.id}
              title={
                <Input
                  type="text"
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  disabled={busy}
                  aria-label={t("importSync.genericUniqueMerchants.colMerchant")}
                />
              }
              action={
                <>
                  <Button variant="secondary" size="sm" onClick={() => saveEdit(row.id)} disabled={busy || !editDraft.trim()}>
                    {updateMutation.isPending
                      ? t("importSync.genericUniqueMerchants.saving")
                      : t("importSync.genericUniqueMerchants.save")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={cancelEdit} disabled={busy}>
                    {t("importSync.genericUniqueMerchants.cancel")}
                  </Button>
                </>
              }
            />
          ) : (
            <OpenRow
              key={row.id}
              title={<span className={styles.name}>{row.merchant_key}</span>}
              action={
                <>
                  <Button variant="ghost" size="sm" onClick={() => startEdit(row)} disabled={busy || editingId != null}>
                    {t("importSync.genericUniqueMerchants.edit")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onDelete(row.id, row.merchant_key)}
                    disabled={busy || editingId != null}
                  >
                    {deleteMutation.isPending && deleteMutation.variables === row.id
                      ? t("importSync.genericUniqueMerchants.removing")
                      : t("importSync.genericUniqueMerchants.remove")}
                  </Button>
                </>
              }
            />
          )
        )}
      </OpenRows>

      <form onSubmit={onAdd} className={styles.addForm}>
        <div className={styles.addField}>
          <Input
            type="text"
            value={newMerchant}
            onChange={(e) => setNewMerchant(e.target.value)}
            placeholder={t("importSync.genericUniqueMerchants.addPlaceholder")}
            disabled={busy || editingId != null}
            aria-label={t("importSync.genericUniqueMerchants.addPlaceholder")}
          />
        </div>
        <Button type="submit" disabled={busy || editingId != null || !newMerchant.trim()}>
          {createMutation.isPending
            ? t("importSync.genericUniqueMerchants.adding")
            : t("importSync.genericUniqueMerchants.add")}
        </Button>
      </form>
    </div>
  );
}
