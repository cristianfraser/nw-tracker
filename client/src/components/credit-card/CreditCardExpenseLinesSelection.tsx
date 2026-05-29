import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslation, ccExpenseCategoryLabel } from "../../i18n";
import type { CcExpenseCategoryDto, FlowCcExpenseLineRow } from "../../types";
import { expenseLineCategoryTargetId } from "../../ccExpenseLineBuckets";
import { useAssignCcExpenseLineCategory } from "../../queries/hooks";
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

function assignableCategories(
  categories: readonly CcExpenseCategoryDto[]
): CcExpenseCategoryDto[] {
  return categories.filter((c) => c.slug !== "unclassified");
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
}: {
  categories: readonly CcExpenseCategoryDto[];
}) {
  const selection = useCreditCardExpenseLinesSelection();
  if (!selection || selection.selectedKeys.size === 0) {
    return null;
  }
  return (
    <div className={styles.pageStickyWrap}>
      <CreditCardExpenseLinesBulkFooter categories={categories} />
    </div>
  );
}

export function CreditCardExpenseLinesBulkFooter({
  categories,
}: {
  categories: readonly CcExpenseCategoryDto[];
}) {
  const { t } = useTranslation();
  const selection = useCreditCardExpenseLinesSelection();
  const assign = useAssignCcExpenseLineCategory();
  const assignable = assignableCategories(categories);

  if (!selection || selection.selectedKeys.size === 0) {
    return null;
  }

  const selectedLines = [...selection.selectedKeys]
    .map((key) => selection.linesByKey.get(key))
    .filter((line): line is FlowCcExpenseLineRow => line != null);

  const busy = assign.isPending;

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
      </div>
    </div>
  );
}
