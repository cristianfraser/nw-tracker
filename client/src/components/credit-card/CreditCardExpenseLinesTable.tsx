import { useCallback } from "react";
import { useTranslation, ccExpenseCategoryLabel } from "../../i18n";
import { useCreditCardExpenseLinesSelection } from "./CreditCardExpenseLinesSelection";
import { formatCcExpenseLineAmount } from "../../format";
import type { CcExpenseBigGroupDto, CcExpenseCategoryDto, FlowCcExpenseLineRow } from "../../types";
import { Table } from "../ui/Table";
import { Pill } from "../ui/Pill";
import {
  expenseLineCategoryTargetId,
} from "../../ccExpenseLineBuckets";
import { assignableCcExpenseCategories } from "../../ccExpenseCategories";
import { ExpensePurchaseNoteInput } from "./ExpensePurchaseNoteInput";
import { ExpenseBigGroupSelect } from "./ExpenseBigGroupSelect";
import { useAssignCcExpenseLineCategory } from "../../queries/hooks";
import tableStyles from "../../pages/AccountDetailPage.module.css";
import categoryStyles from "./CreditCardExpenseLinesTable.module.css";

function pillHoverColor(hex: string): string {
  return `color-mix(in srgb, ${hex} 78%, black)`;
}

function formatCuota(current: number | null, total: number | null): string {
  if (current == null || total == null || total <= 0) return "—";
  return `${current}/${total}`;
}

function lineCategorySlug(line: FlowCcExpenseLineRow): string {
  return line.category_slug === "unclassified" ? "" : line.category_slug;
}

function expenseLineOriginCardDisplay(line: FlowCcExpenseLineRow): string | null {
  if (line.source !== "cc") return null;
  const origin = line.origin_card_last4?.trim();
  const primary = line.primary_card_last4?.trim();
  if (!origin) return null;
  if (primary && origin === primary) return null;
  return origin;
}

/** Calendar-month modal order: purchase date, then statement close, then amount. */
export function sortCreditCardExpenseLinesByStatement(
  a: FlowCcExpenseLineRow,
  b: FlowCcExpenseLineRow
): number {
  return (
    (b.purchase_on ?? b.occurred_on).localeCompare(a.purchase_on ?? a.occurred_on) ||
    b.occurred_on.localeCompare(a.occurred_on) ||
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
  variant = "select",
}: {
  line: FlowCcExpenseLineRow;
  categories: readonly CcExpenseCategoryDto[];
  variant?: "select" | "pills";
}) {
  const { t } = useTranslation();
  const assign = useAssignCcExpenseLineCategory();
  const assignable = assignableCcExpenseCategories(categories);
  const activeSlug = lineCategorySlug(line);
  const activeCategory = assignable.find((c) => c.slug === activeSlug);
  const categoryLineId = expenseLineCategoryTargetId(line);
  const rowPending =
    assign.isPending &&
    assign.variables?.lineId === categoryLineId &&
    assign.variables?.source === line.source;

  const persistCategory = useCallback(
    (nextSlug: string) => {
      if (!nextSlug || nextSlug === "unclassified") {
        assign.mutate({
          lineId: categoryLineId,
          source: line.source,
          unique: line.category_unique,
          clear_category: true,
        });
        return;
      }
      assign.mutate({
        lineId: categoryLineId,
        source: line.source,
        unique: line.category_unique,
        category_slug: nextSlug,
      });
    },
    [assign, categoryLineId, line.category_unique, line.source]
  );

  const persistUnique = useCallback(
    (nextUnique: boolean) => {
      assign.mutate({
        lineId: categoryLineId,
        source: line.source,
        unique: nextUnique,
        ...(activeSlug ? { category_slug: activeSlug } : {}),
      });
    },
    [activeSlug, assign, categoryLineId, line.source]
  );

  const uniqueCheckbox = (
    <label
      className={`${categoryStyles.uniqueLabel} ${
        rowPending ? categoryStyles.uniqueLabelPending : categoryStyles.uniqueLabelReady
      }`}
    >
      <input
        type="checkbox"
        checked={line.category_unique}
        disabled={rowPending}
        onChange={(e) => persistUnique(e.target.checked)}
      />
      {t("expenses.creditCard.categoryUniqueLabel")}
    </label>
  );

  if (variant === "pills") {
    return (
      <div className={categoryStyles.categoryCell}>
        {activeCategory ? (
          <Pill
            size="small"
            uppercase={false}
            label={ccExpenseCategoryLabel(activeCategory.slug)}
            backgroundColor={activeCategory.chart_color}
            hoverBackgroundColor={pillHoverColor(activeCategory.chart_color)}
            clearable
            title={t("expenses.creditCard.clearCategoryAria")}
            onClick={() => {
              if (rowPending) return;
              persistCategory("");
            }}
          />
        ) : (
          <div
            className={categoryStyles.categoryPills}
            role="group"
            aria-label={t("expenses.creditCard.colCategory")}
          >
            {assignable.map((c) => (
              <Pill
                key={c.slug}
                size="small"
                uppercase={false}
                label={ccExpenseCategoryLabel(c.slug)}
                backgroundColor={c.chart_color}
                hoverBackgroundColor={pillHoverColor(c.chart_color)}
                aria-label={ccExpenseCategoryLabel(c.slug)}
                onClick={() => {
                  if (rowPending) return;
                  persistCategory(c.slug);
                }}
              />
            ))}
          </div>
        )}
        {uniqueCheckbox}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem" }}>
      <select
        value={activeSlug}
        disabled={rowPending}
        aria-label={t("expenses.creditCard.colCategory")}
        onChange={(e) => persistCategory(e.target.value)}
      >
        <option value="">{ccExpenseCategoryLabel("unclassified")}</option>
        {assignable.map((c) => (
          <option key={c.slug} value={c.slug}>
            {ccExpenseCategoryLabel(c.slug)}
          </option>
        ))}
      </select>
      {uniqueCheckbox}
    </div>
  );
}

export function CreditCardExpenseLinesTable({
  lines,
  categories,
  emptyLabel,
  showCategoryControls = true,
  showNotesColumn = true,
  showBigGroupControls = false,
  bigGroups = [],
  categoryControlVariant = "select",
  collapsedVisibleRows,
  showMoreLabel,
  showLessLabel,
  showDeleteAction = false,
  deletableLineIds,
  onDeleteLine,
  deletePendingLineId,
  enableCheckingNotes = false,
}: {
  lines: readonly FlowCcExpenseLineRow[];
  categories: readonly CcExpenseCategoryDto[];
  emptyLabel: string;
  showCategoryControls?: boolean;
  showNotesColumn?: boolean;
  showBigGroupControls?: boolean;
  bigGroups?: readonly CcExpenseBigGroupDto[];
  categoryControlVariant?: "select" | "pills";
  collapsedVisibleRows?: number;
  showMoreLabel?: string;
  showLessLabel?: string;
  showDeleteAction?: boolean;
  deletableLineIds?: ReadonlySet<number>;
  onDeleteLine?: (line: FlowCcExpenseLineRow) => void;
  deletePendingLineId?: number;
  /** Show note inputs for cuenta corriente (checking) rows — expenses tab only. */
  enableCheckingNotes?: boolean;
}) {
  const { t } = useTranslation();
  const selection = useCreditCardExpenseLinesSelection();
  const showRowSelection = showCategoryControls && selection != null;

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
            {showRowSelection ? (
              <th className={categoryStyles.selectCol} aria-label={t("expenses.creditCard.colSelect")} />
            ) : null}
            <th data-sort-key="source">{t("expenses.creditCard.lineColSource")}</th>
            <th data-sort-key="origin-card">{t("expenses.creditCard.lineColOriginCard")}</th>
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
            {showBigGroupControls ? (
              <th>{t("expenses.creditCard.bigGroups.colGroup")}</th>
            ) : null}
            {showNotesColumn ? <th>{t("expenses.creditCard.lineColNotes")}</th> : null}
            {showDeleteAction ? (
              <th>{t("accountDetail.creditCard.lineColActions")}</th>
            ) : null}
          </tr>
        </thead>
      }
    >
      {lines.map((ln) => {
        const isCc = ln.source === "cc";
        const noteStatementLineId =
          ln.statement_line_id > 0
            ? ln.statement_line_id
            : ln.category_statement_line_id ?? undefined;
        const canDelete =
          showDeleteAction &&
          deletableLineIds?.has(ln.statement_line_id) === true &&
          ln.statement_line_id > 0;
        const deleteBusy = deletePendingLineId === ln.statement_line_id;
        const showNoteInput =
          Boolean(ln.purchase_key) &&
          (isCc || (enableCheckingNotes && ln.source === "checking"));
        const originCard = expenseLineOriginCardDisplay(ln);
        const rowSelected = showRowSelection && selection.isSelected(ln);
        return (
          <tr
            key={`${ln.source}-${ln.statement_line_id}-${ln.purchase_key}`}
            className={rowSelected ? categoryStyles.rowSelected : undefined}
            data-sort-source={ln.origin_label}
            data-sort-origin-card={originCard ?? ""}
            data-sort-statement={ln.occurred_on}
            data-sort-purchase={ln.purchase_on ?? ""}
            data-sort-merchant={ln.merchant ?? ""}
            data-sort-amount={ln.amount_clp}
            data-sort-installment={
              ln.installment_flag ? (ln.nro_cuota_current ?? 0) : -1
            }
          >
            {showRowSelection ? (
              <td className={categoryStyles.selectCol}>
                <input
                  type="checkbox"
                  checked={rowSelected}
                  aria-label={t("expenses.creditCard.selectRowAria", {
                    merchant: ln.merchant ?? ln.origin_label,
                  })}
                  onChange={() => selection.toggleLine(ln)}
                />
              </td>
            ) : null}
            <td className="mono">{ln.origin_label}</td>
            <td className="mono muted">
              {originCard
                ? t("expenses.creditCard.originCardAdditional", { last4: originCard })
                : "—"}
            </td>
            <td className="mono">{isCc ? ln.statement_date : "—"}</td>
            <td className="mono">{ln.purchase_on ?? "—"}</td>
            <td>{ln.merchant ?? "—"}</td>
            <td className="mono">{formatCcExpenseLineAmount(ln.amount_clp, ln.amount_usd)}</td>
            <td className="mono muted">
              {ln.line_role === "installment_purchase_total" ? (
                <Pill
                  size="small"
                  label={t("expenses.creditCard.installmentPurchaseTotalLabel", {
                    count: ln.nro_cuota_total ?? 0,
                  })}
                  backgroundColor="#475569"
                  hoverBackgroundColor="#64748b"
                />
              ) : ln.installment_flag ? (
                formatCuota(ln.nro_cuota_current, ln.nro_cuota_total)
              ) : (
                "—"
              )}
            </td>
            {showCategoryControls ? (
              <td>
                <ExpenseLineCategoryControls
                  line={ln}
                  categories={categories}
                  variant={categoryControlVariant}
                />
              </td>
            ) : null}
            {showBigGroupControls ? (
              <td>
                {ln.purchase_key ? (
                  <ExpenseBigGroupSelect
                    accountId={ln.account_id}
                    purchaseKey={ln.purchase_key}
                    value={ln.big_group_slug}
                    groups={bigGroups}
                  />
                ) : (
                  "—"
                )}
              </td>
            ) : null}
            {showNotesColumn ? (
              <td>
                {showNoteInput ? (
                  <ExpensePurchaseNoteInput
                    accountId={ln.account_id}
                    purchaseKey={ln.purchase_key}
                    statementLineId={noteStatementLineId}
                    value={ln.purchase_notes ?? ""}
                  />
                ) : (
                  "—"
                )}
              </td>
            ) : null}
            {showDeleteAction ? (
              <td>
                {canDelete ? (
                  <button
                    type="button"
                    className="muted"
                    disabled={deleteBusy}
                    aria-label={t("accountDetail.creditCard.facturacionDeleteLineAria")}
                    onClick={() => onDeleteLine?.(ln)}
                  >
                    {t("accountDetail.creditCard.facturacionDeleteLine")}
                  </button>
                ) : (
                  "—"
                )}
              </td>
            ) : null}
          </tr>
        );
      })}
    </Table>
  );
}
