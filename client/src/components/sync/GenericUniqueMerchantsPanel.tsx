import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Table } from "../ui/Table";
import type { CcExpenseGenericUniqueMerchantRow } from "../../types";
import { Button, Input } from "@crfrsr/ui";
import {
  useCreateGenericUniqueMerchantMutation,
  useDeleteGenericUniqueMerchantMutation,
  useUpdateGenericUniqueMerchantMutation,
} from "../../queries/hooks";

type Props = {
  merchants: CcExpenseGenericUniqueMerchantRow[];
};

export function GenericUniqueMerchantsPanel({ merchants }: Props) {
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

  function startEdit(row: CcExpenseGenericUniqueMerchantRow) {
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
    <>
      <p className="muted" style={{ fontSize: "var(--font-size-ui)", marginBottom: "0.75rem" }}>
        {t("importSync.genericUniqueMerchants.hint")}
      </p>

      {formError ? <p className="error">{formError}</p> : null}

      <Table
        header={
          <thead>
            <tr>
              <th>{t("importSync.genericUniqueMerchants.colMerchant")}</th>
              <th>{t("importSync.genericUniqueMerchants.colActions")}</th>
            </tr>
          </thead>
        }
      >
        {merchants.length === 0 ? (
          <tr>
            <td colSpan={2} className="muted">
              {t("importSync.genericUniqueMerchants.empty")}
            </td>
          </tr>
        ) : (
          merchants.map((row) => (
            <tr key={row.id}>
              <td>
                {editingId === row.id ? (
                  <Input
                    type="text"
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    disabled={busy}
                    aria-label={t("importSync.genericUniqueMerchants.colMerchant")}
                  />
                ) : (
                  <span className="mono">{row.merchant_key}</span>
                )}
              </td>
              <td>
                {editingId === row.id ? (
                  <>
                    <Button
                      onClick={() => saveEdit(row.id)}
                      disabled={busy || !editDraft.trim()}
                    >
                      {updateMutation.isPending
                        ? t("importSync.genericUniqueMerchants.saving")
                        : t("importSync.genericUniqueMerchants.save")}
                    </Button>{" "}
                    <Button onClick={cancelEdit} disabled={busy}>
                      {t("importSync.genericUniqueMerchants.cancel")}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      onClick={() => startEdit(row)}
                      disabled={busy || editingId != null}
                    >
                      {t("importSync.genericUniqueMerchants.edit")}
                    </Button>{" "}
                    <Button
                      onClick={() => onDelete(row.id, row.merchant_key)}
                      disabled={busy || editingId != null}
                    >
                      {deleteMutation.isPending
                        ? t("importSync.genericUniqueMerchants.removing")
                        : t("importSync.genericUniqueMerchants.remove")}
                    </Button>
                  </>
                )}
              </td>
            </tr>
          ))
        )}
      </Table>

      <form onSubmit={onAdd} style={{ marginTop: "1rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <div style={{ width: "18rem" }}>
          <Input
            type="text"
            value={newMerchant}
            onChange={(e) => setNewMerchant(e.target.value)}
            placeholder={t("importSync.genericUniqueMerchants.addPlaceholder")}
            disabled={busy || editingId != null}
            aria-label={t("importSync.genericUniqueMerchants.addPlaceholder")}
          />
        </div>
        <Button
          type="submit"
          disabled={busy || editingId != null || !newMerchant.trim()}
        >
          {createMutation.isPending
            ? t("importSync.genericUniqueMerchants.adding")
            : t("importSync.genericUniqueMerchants.add")}
        </Button>
      </form>
    </>
  );
}
