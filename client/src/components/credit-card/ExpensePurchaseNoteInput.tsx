import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n";
import { usePatchCcExpensePurchaseNoteMutation } from "../../queries/hooks";
import styles from "./CreditCardExpenseLinesTable.module.css";

export function ExpensePurchaseNoteInput({
  accountId,
  purchaseKey,
  statementLineId,
  value,
  disabled = false,
}: {
  accountId: number;
  purchaseKey: string;
  statementLineId?: number;
  value: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const patch = usePatchCcExpensePurchaseNoteMutation();
  const [draft, setDraft] = useState(value);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef(value);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (focusedRef.current) return;
    setDraft(value);
    lastSavedRef.current = value;
  }, [value]);

  const persist = useCallback(
    (text: string) => {
      if (disabled) return;
      if (!purchaseKey && (statementLineId == null || statementLineId <= 0)) return;
      const trimmed = text.trim();
      if (trimmed === lastSavedRef.current.trim()) return;
      patch.mutate({
        account_id: accountId,
        ...(purchaseKey ? { purchase_key: purchaseKey } : {}),
        ...(statementLineId != null && statementLineId > 0
          ? { statement_line_id: statementLineId }
          : {}),
        notes: trimmed,
      });
      lastSavedRef.current = trimmed;
    },
    [accountId, disabled, patch, purchaseKey, statementLineId]
  );

  const schedulePersist = useCallback(
    (text: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => persist(text), 500);
    },
    [persist]
  );

  const rowPending =
    patch.isPending &&
    patch.variables?.account_id === accountId &&
    (patch.variables?.purchase_key === purchaseKey ||
      patch.variables?.statement_line_id === statementLineId);

  return (
    <input
      type="text"
      className={styles.noteInput}
      value={draft}
      disabled={disabled || (!purchaseKey && (statementLineId == null || statementLineId <= 0))}
      aria-busy={rowPending || undefined}
      placeholder={t("expenses.creditCard.purchaseNotePlaceholder")}
      aria-label={t("expenses.creditCard.purchaseNoteAria")}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onChange={(e) => {
        const next = e.target.value;
        setDraft(next);
        schedulePersist(next);
      }}
      onBlur={() => {
        focusedRef.current = false;
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
        persist(draft);
      }}
    />
  );
}
