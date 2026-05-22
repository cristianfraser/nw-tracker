import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation, ccExpenseCategoryLabel } from "../i18n";
import { formatClp } from "../format";
import type { CcExpenseCategoryDto, FlowCcExpenseLineRow } from "../types";
import { Table } from "./Table";
import { useAssignCcExpenseLineCategory } from "../queries/hooks";
import tableStyles from "../pages/AccountDetailPage.module.css";

function formatCuota(current: number | null, total: number | null): string {
  if (current == null || total == null || total <= 0) return "—";
  return `${current}/${total}`;
}

/** Default modal order: statement close, then purchase date, then amount. */
export function sortCreditCardExpenseLinesByStatement(
  a: FlowCcExpenseLineRow,
  b: FlowCcExpenseLineRow
): number {
  return (
    b.occurred_on.localeCompare(a.occurred_on) ||
    (b.purchase_on ?? "").localeCompare(a.purchase_on ?? "") ||
    Math.abs(b.amount_clp) - Math.abs(a.amount_clp)
  );
}

export function sortCreditCardExpenseLinesByAmountDesc(
  a: FlowCcExpenseLineRow,
  b: FlowCcExpenseLineRow
): number {
  return b.amount_clp - a.amount_clp || b.occurred_on.localeCompare(a.occurred_on);
}

function ExpenseLineCategoryControls({
  line,
  categories,
}: {
  line: FlowCcExpenseLineRow;
  categories: readonly CcExpenseCategoryDto[];
}) {
  const { t } = useTranslation();
  const assign = useAssignCcExpenseLineCategory();
  const [unique, setUnique] = useState(line.category_unique);
  const [slug, setSlug] = useState(
    line.category_slug === "unclassified" ? "" : line.category_slug
  );

  useEffect(() => {
    if (assign.isPending) return;
    setUnique(line.category_unique);
    setSlug(line.category_slug === "unclassified" ? "" : line.category_slug);
  }, [line.category_slug, line.category_unique, line.statement_line_id, assign.isPending]);

  const assignable = useMemo(
    () => categories.filter((c) => c.slug !== "unclassified"),
    [categories]
  );

  const persistCategory = useCallback(
    (nextSlug: string) => {
      if (!nextSlug || nextSlug === "unclassified") return;
      assign.mutate({
        lineId: line.statement_line_id,
        unique,
        category_slug: nextSlug,
      });
    },
    [assign, line.statement_line_id, unique]
  );

  const persistUnique = useCallback(
    (nextUnique: boolean) => {
      const categoryForSave =
        slug || (line.category_slug !== "unclassified" ? line.category_slug : undefined);
      assign.mutate({
        lineId: line.statement_line_id,
        unique: nextUnique,
        ...(categoryForSave ? { category_slug: categoryForSave } : {}),
      });
    },
    [assign, line.statement_line_id, slug, line.category_slug]
  );

  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem" }}>
      <select
        value={
          slug !== ""
            ? slug
            : line.category_slug === "unclassified"
              ? ""
              : line.category_slug
        }
        disabled={assign.isPending}
        aria-label={t("expenses.creditCard.colCategory")}
        onChange={(e) => {
          const v = e.target.value;
          setSlug(v);
          if (v) persistCategory(v);
        }}
      >
        <option value="">{ccExpenseCategoryLabel("unclassified")}</option>
        {assignable.map((c) => (
          <option key={c.slug} value={c.slug}>
            {ccExpenseCategoryLabel(c.slug)}
          </option>
        ))}
      </select>
      <label
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.25rem",
          fontSize: "0.8rem",
          cursor: assign.isPending ? "wait" : "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={unique}
          disabled={assign.isPending}
          onChange={(e) => {
            const next = e.target.checked;
            setUnique(next);
            persistUnique(next);
          }}
        />
        {t("expenses.creditCard.categoryUniqueLabel")}
      </label>
    </div>
  );
}

export function CreditCardExpenseLinesTable({
  lines,
  categories,
  emptyLabel,
  showCategoryControls = true,
  collapsedVisibleRows,
  showMoreLabel,
  showLessLabel,
}: {
  lines: readonly FlowCcExpenseLineRow[];
  categories: readonly CcExpenseCategoryDto[];
  emptyLabel: string;
  showCategoryControls?: boolean;
  collapsedVisibleRows?: number;
  showMoreLabel?: string;
  showLessLabel?: string;
}) {
  const { t } = useTranslation();

  if (lines.length === 0) {
    return <p className="muted" style={{ marginBottom: "1rem" }}>{emptyLabel}</p>;
  }

  const hidden =
    collapsedVisibleRows != null && collapsedVisibleRows > 0
      ? Math.max(0, lines.length - collapsedVisibleRows)
      : 0;

  return (
    <Table
      tableClassName={tableStyles.tableCompact}
      tableStyle={{ marginBottom: "1.25rem" }}
      collapsedVisibleRows={collapsedVisibleRows}
      showMoreLabel={
        showMoreLabel ??
        (hidden > 0 ? t("table.showMoreRows", { count: hidden }) : t("table.showMore"))
      }
      showLessLabel={showLessLabel ?? t("table.showLess")}
      header={
        <thead>
          <tr>
            <th data-sort-key="statement" data-sort-type="date">
              {t("expenses.creditCard.lineColStatementClose")}
            </th>
            <th data-sort-key="purchase" data-sort-type="date">
              {t("expenses.creditCard.lineColPurchaseDate")}
            </th>
            <th data-sort-key="merchant">{t("account.creditCard.lineMerchant")}</th>
            <th data-sort-key="amount" data-sort-type="number">
              {t("expenses.creditCard.lineColAmount")}
            </th>
            <th data-sort-key="installment" data-sort-type="number">
              {t("expenses.creditCard.lineColInstallment")}
            </th>
            {showCategoryControls ? <th>{t("expenses.creditCard.colCategory")}</th> : null}
          </tr>
        </thead>
      }
    >
      {lines.map((ln) => (
        <tr
          key={ln.statement_line_id}
          data-sort-statement={ln.occurred_on}
          data-sort-purchase={ln.purchase_on ?? ""}
          data-sort-merchant={ln.merchant ?? ""}
          data-sort-amount={ln.amount_clp}
          data-sort-installment={
            ln.installment_flag ? (ln.nro_cuota_current ?? 0) : -1
          }
        >
          <td className="mono">{ln.statement_date}</td>
          <td className="mono">{ln.purchase_on ?? "—"}</td>
          <td>{ln.merchant ?? "—"}</td>
          <td className="mono">{formatClp(ln.amount_clp)}</td>
          <td className="mono muted">
            {ln.installment_flag ? formatCuota(ln.nro_cuota_current, ln.nro_cuota_total) : "—"}
          </td>
          {showCategoryControls ? (
            <td>
              <ExpenseLineCategoryControls line={ln} categories={categories} />
            </td>
          ) : null}
        </tr>
      ))}
    </Table>
  );
}
