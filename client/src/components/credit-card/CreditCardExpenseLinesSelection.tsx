import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslation, ccExpenseCategoryLabel } from "../../i18n";
import type { CcExpenseBigGroupDto, CcExpenseCategoryDto, FlowCcExpenseLineRow } from "../../types";
import { expenseLineCategoryTargetId } from "../../ccExpenseLineBuckets";
import { assignableCcExpenseCategories } from "../../ccExpenseCategories";
import {
  useAssignCcExpenseLineCategory,
  useCreateCcExpenseBigGroupMutation,
  usePutCcExpensePurchaseBigGroupMutation,
} from "../../queries/hooks";
import styles from "./CreditCardExpenseLinesSelection.module.css";

export function expenseLineRowKey(line: FlowCcExpenseLineRow): string {
  return `${line.source}-${line.statement_line_id}-${line.purchase_key}`;
}

type SelectionContextValue = {
  linesByKey: ReadonlyMap<string, FlowCcExpenseLineRow>;
  selectedKeys: ReadonlySet<string>;
  isSelected: (line: FlowCcExpenseLineRow) => boolean;
  toggleLine: (line: FlowCcExpenseLineRow) => void;
  clearSelection: () => void;
};

const SelectionContext = createContext<SelectionContextValue | null>(null);

export function useCreditCardExpenseLinesSelection(): SelectionContextValue | null {
  return useContext(SelectionContext);
}

function existingCategorySlugForAssign(line: FlowCcExpenseLineRow): string | undefined {
  const slug = line.category_slug;
  return slug && slug !== "unclassified" ? slug : undefined;
}

export function CreditCardExpenseLinesSelectionProvider({
  lines,
  children,
}: {
  lines: readonly FlowCcExpenseLineRow[];
  children: ReactNode;
}) {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());

  const linesByKey = useMemo(() => {
    const map = new Map<string, FlowCcExpenseLineRow>();
    for (const line of lines) {
      map.set(expenseLineRowKey(line), line);
    }
    return map;
  }, [lines]);

  const isSelected = useCallback(
    (line: FlowCcExpenseLineRow) => selectedKeys.has(expenseLineRowKey(line)),
    [selectedKeys]
  );

  const toggleLine = useCallback((line: FlowCcExpenseLineRow) => {
    const key = expenseLineRowKey(line);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedKeys(new Set());
  }, []);

  const value = useMemo(
    () => ({
      linesByKey,
      selectedKeys,
      isSelected,
      toggleLine,
      clearSelection,
    }),
    [linesByKey, selectedKeys, isSelected, toggleLine, clearSelection]
  );

  return (
    <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>
  );
}

export function CreditCardExpenseLinesSelectionPageFooter({
  categories,
  bigGroups = [],
}: {
  categories: readonly CcExpenseCategoryDto[];
  bigGroups?: readonly CcExpenseBigGroupDto[];
}) {
  const selection = useCreditCardExpenseLinesSelection();
  if (!selection || selection.selectedKeys.size === 0) {
    return null;
  }
  return (
    <div className={styles.pageStickyWrap}>
      <CreditCardExpenseLinesBulkFooter categories={categories} bigGroups={bigGroups} />
    </div>
  );
}

export function CreditCardExpenseLinesBulkFooter({
  categories,
  bigGroups = [],
}: {
  categories: readonly CcExpenseCategoryDto[];
  bigGroups?: readonly CcExpenseBigGroupDto[];
}) {
  const { t } = useTranslation();
  const selection = useCreditCardExpenseLinesSelection();
  const assign = useAssignCcExpenseLineCategory();
  const putBigGroup = usePutCcExpensePurchaseBigGroupMutation();
  const createBigGroup = useCreateCcExpenseBigGroupMutation();
  const assignable = assignableCcExpenseCategories(categories);

  const selectedLines = useMemo(() => {
    if (!selection) return [];
    return [...selection.selectedKeys]
      .map((key) => selection.linesByKey.get(key))
      .filter((line): line is FlowCcExpenseLineRow => line != null);
  }, [selection]);

  const uniquePurchases = useMemo(() => {
    const seen = new Set<string>();
    const out: { account_id: number; purchase_key: string }[] = [];
    for (const line of selectedLines) {
      if (!line.purchase_key) continue;
      const key = `${line.account_id}|${line.purchase_key}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ account_id: line.account_id, purchase_key: line.purchase_key });
    }
    return out;
  }, [selectedLines]);

  const busy = assign.isPending || putBigGroup.isPending || createBigGroup.isPending;

  if (!selection || selection.selectedKeys.size === 0) {
    return null;
  }

  const applyCategory = async (slug: string) => {
    if (!slug || busy) return;
    try {
      await Promise.all(
        selectedLines.map((line) => {
          const existing = existingCategorySlugForAssign(line);
          return assign.mutateAsync({
            lineId: expenseLineCategoryTargetId(line),
            source: line.source,
            unique: true,
            ...(existing ? { category_slug: existing } : {}),
          });
        })
      );
      await Promise.all(
        selectedLines.map((line) =>
          assign.mutateAsync({
            lineId: expenseLineCategoryTargetId(line),
            source: line.source,
            unique: true,
            category_slug: slug,
          })
        )
      );
      selection.clearSelection();
    } catch {
      /* optimistic rollback via mutation onError */
    }
  };

  const applyBigGroup = async (groupSlug: string | null) => {
    if (busy || uniquePurchases.length === 0) return;
    try {
      await Promise.all(
        uniquePurchases.map((p) =>
          putBigGroup.mutateAsync({
            account_id: p.account_id,
            purchase_key: p.purchase_key,
            group_slug: groupSlug,
          })
        )
      );
      selection.clearSelection();
    } catch {
      /* optimistic rollback via mutation onError */
    }
  };

  const onBulkBigGroupChange = async (value: string) => {
    if (value === "__create_big_group__") {
      const label = window.prompt(t("expenses.creditCard.bigGroups.createPrompt"));
      if (label == null) return;
      const trimmed = label.trim();
      if (!trimmed) return;
      try {
        const group = await createBigGroup.mutateAsync(trimmed);
        await applyBigGroup(group.slug);
      } catch {
        /* mutation onError */
      }
      return;
    }
    await applyBigGroup(value || null);
  };

  return (
    <div className={styles.footer} role="region" aria-label={t("expenses.creditCard.bulkFooterAria")}>
      <span className={styles.count}>
        {t("expenses.creditCard.bulkSelectedCount", { count: selectedLines.length })}
      </span>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.clearBtn}
          disabled={busy}
          onClick={() => selection.clearSelection()}
        >
          {t("expenses.creditCard.bulkClearSelection")}
        </button>
        <select
          className={styles.categorySelect}
          value=""
          disabled={busy}
          aria-label={t("expenses.creditCard.bulkCategorySelectAria")}
          onChange={(e) => {
            const slug = e.target.value;
            e.target.value = "";
            void applyCategory(slug);
          }}
        >
          <option value="" disabled>
            {t("expenses.creditCard.bulkCategoryPlaceholder")}
          </option>
          {assignable.map((c) => (
            <option key={c.slug} value={c.slug}>
              {ccExpenseCategoryLabel(c.slug)}
            </option>
          ))}
        </select>
        <select
          className={styles.categorySelect}
          value=""
          disabled={busy || uniquePurchases.length === 0}
          aria-label={t("expenses.creditCard.bigGroups.bulkSelectAria")}
          onChange={(e) => {
            const value = e.target.value;
            e.target.value = "";
            void onBulkBigGroupChange(value);
          }}
        >
          <option value="" disabled>
            {t("expenses.creditCard.bigGroups.bulkPlaceholder")}
          </option>
          <option value="">{t("expenses.creditCard.bigGroups.none")}</option>
          {bigGroups.map((g) => (
            <option key={g.slug} value={g.slug}>
              {g.label}
            </option>
          ))}
          <option value="__create_big_group__">
            {t("expenses.creditCard.bigGroups.createOption")}
          </option>
        </select>
      </div>
    </div>
  );
}
