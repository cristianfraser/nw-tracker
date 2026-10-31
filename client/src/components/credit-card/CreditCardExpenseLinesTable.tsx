import { useCallback, useMemo, useState } from "react";
import { Button } from "@crfrsr/ui";
import { cn } from "../../cn";
import { useTranslation } from "../../i18n";
import { expenseLineRowKey, useCreditCardExpenseLinesSelection } from "./CreditCardExpenseLinesSelection";
import { formatCcExpenseLineAmount, formatClp } from "../../format";
import type { CcExpenseBigGroupDto, CcExpenseCategoryDto, FlowCcExpenseLineRow } from "../../types";
import { loadableClass } from "../ui/Loadable";
import { Pill } from "../ui/Pill";
import { PillPicker } from "../ui/PillPicker";
import { expenseLineCategoryTargetId } from "../../ccExpenseLineBuckets";
import { assignableCcExpenseCategories, ccExpenseCategoryPathLabel } from "../../ccExpenseCategories";
import { ExpensePurchaseNoteInput } from "./ExpensePurchaseNoteInput";
import { ExpenseBigGroupPicker } from "./ExpenseBigGroupPicker";
import { ExpenseOriginIcon } from "./ExpenseOriginIcon";
import {
  ExpenseRowMoreButton,
  ExpenseVendorLabel,
  ExpenseVendorPanelLink,
  expenseVendorName,
  Joined,
  useExpenseVendorLinkLabel,
} from "./ExpenseVendorLabel";
import { useAssignCcExpenseLineCategory, usePostVendorBranchChoiceMutation } from "../../queries/hooks";
import styles from "./CreditCardExpenseLinesTable.module.css";

function lineCategorySlug(line: FlowCcExpenseLineRow): string {
  return line.category_slug === "unclassified" ? "" : line.category_slug;
}

function lineDate(line: FlowCcExpenseLineRow): string {
  return line.purchase_on ?? line.occurred_on;
}

/** Calendar-month modal order: purchase date, then statement close, then amount. */
export function sortCreditCardExpenseLinesByStatement(
  a: FlowCcExpenseLineRow,
  b: FlowCcExpenseLineRow
): number {
  return (
    lineDate(b).localeCompare(lineDate(a)) ||
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

type SortKey = "date" | "amount" | "category";
type SortState = { key: SortKey; direction: "asc" | "desc" } | null;

/**
 * Sorts by the column's value; ties keep the incoming order. «No category» stays last in both
 * directions (it is the absence of a category, not a label).
 */
function sortLines(
  lines: readonly FlowCcExpenseLineRow[],
  sort: SortState,
  categoryLabel: (line: FlowCcExpenseLineRow) => string | null
): readonly FlowCcExpenseLineRow[] {
  if (!sort) return lines;
  const sign = sort.direction === "asc" ? 1 : -1;
  return lines
    .map((line, index) => ({ line, index }))
    .sort((a, b) => {
      let cmp = 0;
      if (sort.key === "date") cmp = sign * lineDate(a.line).localeCompare(lineDate(b.line));
      else if (sort.key === "amount") cmp = sign * (a.line.amount_clp - b.line.amount_clp);
      else {
        const la = categoryLabel(a.line);
        const lb = categoryLabel(b.line);
        if (la == null || lb == null) cmp = la == null ? (lb == null ? 0 : 1) : -1;
        else cmp = sign * la.localeCompare(lb);
      }
      return cmp || a.index - b.index;
    })
    .map((x) => x.line);
}

function ExpenseLineCategoryPicker({
  line,
  categories,
}: {
  line: FlowCcExpenseLineRow;
  categories: readonly CcExpenseCategoryDto[];
}) {
  const { t } = useTranslation();
  const assign = useAssignCcExpenseLineCategory();
  const assignable = assignableCcExpenseCategories(categories);
  const activeSlug = lineCategorySlug(line);
  const active = assignable.find((c) => c.slug === activeSlug);
  const categoryLineId = expenseLineCategoryTargetId(line);
  const pending =
    assign.isPending &&
    assign.variables?.lineId === categoryLineId &&
    assign.variables?.source === line.source;

  // «Específico»: a change writes the rule for this vendor + the line's link (its store, app or
  // recipient) instead of the vendor's general rule. Off by default for food delivery.
  const link = line.category_link;
  const [specific, setSpecific] = useState(
    () => line.category_specific === true || (link?.specific_default ?? false)
  );
  const ruleLink = link && specific && !line.category_unique ? { kind: link.kind, key: link.key } : null;

  const persistCategory = useCallback(
    (nextSlug: string | null) => {
      assign.mutate(
        nextSlug
          ? { lineId: categoryLineId, source: line.source, unique: line.category_unique, category_slug: nextSlug, rule_link: ruleLink }
          : { lineId: categoryLineId, source: line.source, unique: line.category_unique, clear_category: true, rule_link: ruleLink }
      );
    },
    [assign, categoryLineId, line.category_unique, line.source, ruleLink]
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

  const unclassified = t("expenses.creditCard.categories.unclassified");
  const value = active
    ? { key: active.slug, label: ccExpenseCategoryPathLabel(active), color: active.chart_color }
    : null;
  return (
    <PillPicker
      value={value}
      emptyLabel={unclassified}
      options={assignable.map((c) => ({
        key: c.slug,
        label: ccExpenseCategoryPathLabel(c),
        color: c.chart_color,
      }))}
      onSelect={(slug) => persistCategory(slug)}
      onClear={() => persistCategory(null)}
      clearLabel={t("expenses.creditCard.clearCategoryAria")}
      ariaLabel={t("expenses.creditCard.lineRow.categoryPickerAria", {
        category: value?.label ?? unclassified,
      })}
      pending={pending}
      footer={
        <>
          <label className={styles.uniqueLabel}>
            <input
              type="checkbox"
              checked={line.category_unique}
              disabled={pending}
              onChange={(e) => persistUnique(e.target.checked)}
            />
            {t("expenses.creditCard.categoryUniqueLabel")}
          </label>
          {link && !line.category_unique ? (
            <label className={styles.uniqueLabel} title={t("expenses.creditCard.categorySpecificHint")}>
              <input type="checkbox" checked={specific} disabled={pending} onChange={(e) => setSpecific(e.target.checked)} />
              {t("expenses.creditCard.categorySpecificLabel", { link: link.label })}
            </label>
          ) : null}
        </>
      }
    />
  );
}

/** A category drawn as a pill nobody can change (payslip deductions, read-only tables). */
function FixedCategoryPill({
  line,
  categories,
}: {
  line: FlowCcExpenseLineRow;
  categories: readonly CcExpenseCategoryDto[];
}) {
  const { t } = useTranslation();
  const c = categories.find((x) => x.slug === line.category_slug);
  const value = c
    ? { key: c.slug, label: ccExpenseCategoryPathLabel(c), color: c.chart_color }
    : null;
  return (
    <PillPicker
      readOnly
      value={value}
      emptyLabel={t("expenses.creditCard.categories.unclassified")}
      options={[]}
      onSelect={() => undefined}
      onClear={() => undefined}
      clearLabel=""
      ariaLabel=""
    />
  );
}

/** The separator between the parts of a row's text: drawn by the row, never part of a string. */
/** The amount, with the installment detail in superscript («3/6 · $270.000», «6 cuotas»). */
function LineAmount({ line }: { line: FlowCcExpenseLineRow }) {
  const { t } = useTranslation();
  let sup: string[] | null = null;
  if (line.line_role === "installment_purchase_total") {
    sup = [t("expenses.creditCard.installmentPurchaseTotalLabel", { count: line.nro_cuota_total ?? 0 })];
  } else if (line.installment_flag && line.nro_cuota_current != null && line.nro_cuota_total != null) {
    const cuota = `${line.nro_cuota_current}/${line.nro_cuota_total}`;
    sup =
      line.line_role === "installment_cuota" && line.installment_total_clp != null
        ? [cuota, formatClp(line.installment_total_clp)]
        : [cuota];
  }
  return (
    <span className={cn("mono", styles.amount)}>
      {formatCcExpenseLineAmount(line.amount_clp, line.amount_usd)}
      {sup ? (
        <sup className={styles.amountSup}>
          <Joined parts={sup} />
        </sup>
      ) : null}
    </span>
  );
}

type RowActions = {
  showDeleteAction: boolean;
  deletableLineIds?: ReadonlySet<number>;
  onDeleteLine?: (line: FlowCcExpenseLineRow) => void;
  deletePendingLineId?: number;
  makeInstallmentLineIds?: ReadonlySet<number>;
  onMakeInstallmentLine?: (line: FlowCcExpenseLineRow) => void;
  makeInstallmentBusyLineId?: number;
  onEditPieces?: (line: FlowCcExpenseLineRow) => void;
  onEditManual?: (line: FlowCcExpenseLineRow) => void;
  enableCheckingNotes: boolean;
};

function ExpenseLineRow({
  line: ln,
  categories,
  bigGroups,
  showCategoryControls,
  showBigGroupControls,
  selectable,
  actions,
  expanded,
  onToggleExpanded,
}: {
  line: FlowCcExpenseLineRow;
  categories: readonly CcExpenseCategoryDto[];
  bigGroups: readonly CcExpenseBigGroupDto[];
  showCategoryControls: boolean;
  showBigGroupControls: boolean;
  selectable: boolean;
  actions: RowActions;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const { t } = useTranslation();
  const selection = useCreditCardExpenseLinesSelection();
  const linkLabel = useExpenseVendorLinkLabel(ln);
  // A payslip deduction's category is the deduction's own: no picker, no bulk select, no group.
  const fixedCategory = ln.source === "payslip";
  const canSelect = selectable && selection != null && !fixedCategory;
  const selected = canSelect && selection.isSelected(ln);

  const canDelete =
    actions.showDeleteAction &&
    actions.deletableLineIds?.has(ln.statement_line_id) === true &&
    ln.statement_line_id > 0;
  const deleteBusy = actions.deletePendingLineId === ln.statement_line_id;
  const canMakeInstallment =
    actions.showDeleteAction &&
    actions.makeInstallmentLineIds?.has(ln.statement_line_id) === true &&
    ln.statement_line_id > 0 &&
    !ln.installment_flag;
  const makeInstallmentBusy = actions.makeInstallmentBusyLineId === ln.statement_line_id;
  const canEditPieces =
    actions.onEditPieces != null &&
    (ln.source === "cc" || ln.source === "checking") &&
    ln.statement_line_id > 0 &&
    ln.line_role === "purchase" &&
    !ln.installment_flag &&
    !ln.checking_refund &&
    ln.amount_clp > 0;
  const hasPieces = ln.piece_seq != null || ln.pieces_remainder === true;
  const canEditManual = actions.onEditManual != null && ln.source === "manual" && ln.statement_line_id > 0;
  const showNoteInput =
    Boolean(ln.purchase_key) &&
    (ln.source === "cc" || (actions.enableCheckingNotes && ln.source === "checking"));
  const noteStatementLineId =
    ln.statement_line_id > 0 ? ln.statement_line_id : ln.category_statement_line_id ?? undefined;
  const needsAction = ln.cuota_purchase_kind != null || ln.branch_choices != null;
  // A big group shows on the row once set; until then its picker lives in the row's extras.
  const canBigGroup = showBigGroupControls && Boolean(ln.purchase_key) && !fixedCategory;
  const bigGroupOnRow = canBigGroup && ln.big_group_slug != null;
  const bigGroupInPanel = canBigGroup && ln.big_group_slug == null;
  const hasPanel =
    linkLabel != null ||
    showNoteInput ||
    bigGroupInPanel ||
    hasPieces ||
    needsAction ||
    canEditPieces ||
    canEditManual ||
    canMakeInstallment ||
    canDelete;
  const merchant = expenseVendorName(ln);

  return (
    <div
      role="listitem"
      className={cn(
        styles.row,
        selected && styles.rowSelected,
        canSelect && styles.rowSelectable
      )}
    >
      <div className={styles.origin}>
        <span className={styles.originIcon}>
          <ExpenseOriginIcon origin={ln.origin} />
        </span>
        {canSelect ? (
          <input
            type="checkbox"
            className={styles.select}
            checked={selected}
            aria-label={t("expenses.creditCard.selectRowAria", { merchant })}
            onChange={() => selection.toggleLine(ln)}
          />
        ) : null}
      </div>
      <div className={cn("mono", "muted", styles.date)}>{lineDate(ln)}</div>
      <div className={styles.pills}>
        {bigGroupOnRow ? (
          <ExpenseBigGroupPicker purchaseKey={ln.purchase_key} value={ln.big_group_slug} groups={bigGroups} />
        ) : null}
        {showCategoryControls && !fixedCategory ? (
          <ExpenseLineCategoryPicker line={ln} categories={categories} />
        ) : (
          <FixedCategoryPill line={ln} categories={categories} />
        )}
      </div>
      <ExpenseVendorLabel source={ln} note={ln.purchase_notes} className={styles.vendor} />
      <div className={styles.amountCell}>
        <LineAmount line={ln} />
      </div>
      <div className={styles.more}>
        {hasPanel ? (
          <ExpenseRowMoreButton
            expanded={expanded}
            needsAction={needsAction}
            ariaLabel={t("expenses.creditCard.lineRow.moreAria", { merchant })}
            needsActionTitle={t("expenses.creditCard.lineRow.needsAction")}
            onClick={onToggleExpanded}
          />
        ) : null}
      </div>
      {hasPanel && expanded ? (
        <div className={styles.panel}>
          {linkLabel ? <ExpenseVendorPanelLink linkLabel={linkLabel} /> : null}
          {hasPieces || needsAction ? (
            <div className={styles.panelBadges}>
              {hasPieces ? (
                <span className="muted">
                  {ln.piece_seq != null
                    ? t("expenses.creditCard.pieces.pieceBadge")
                    : t("expenses.creditCard.pieces.remainderBadge")}
                </span>
              ) : null}
              {ln.cuota_purchase_kind ? (
                <>
                  <Pill
                    size="small"
                    label={t("expenses.creditCard.cuotaPurchasePendingBadge")}
                    backgroundColor="#92400e"
                  />
                  <span className="muted">
                    {t(`expenses.creditCard.cuotaPurchasePendingHint.${ln.cuota_purchase_kind}`)}
                  </span>
                </>
              ) : null}
            </div>
          ) : null}
          {ln.branch_choices ? <BranchChoice choices={ln.branch_choices} /> : null}
          {bigGroupInPanel ? (
            <div className={styles.panelBigGroup}>
              <span className="muted">{t("expenses.creditCard.lineRow.bigGroupLabel")}</span>
              <ExpenseBigGroupPicker purchaseKey={ln.purchase_key} value={null} groups={bigGroups} />
            </div>
          ) : null}
          {showNoteInput ? (
            <div className={styles.panelNote}>
              <ExpensePurchaseNoteInput
                accountId={ln.account_id}
                purchaseKey={ln.purchase_key}
                statementLineId={noteStatementLineId}
                value={ln.purchase_notes ?? ""}
              />
            </div>
          ) : null}
          {canEditPieces || canEditManual || canMakeInstallment || canDelete ? (
            <div className={styles.panelActions}>
              {canEditPieces ? (
                <Button variant="ghost" size="sm" onClick={() => actions.onEditPieces?.(ln)}>
                  {hasPieces
                    ? t("expenses.creditCard.pieces.actionEdit")
                    : t("expenses.creditCard.pieces.action")}
                </Button>
              ) : null}
              {canEditManual ? (
                <Button variant="ghost" size="sm" onClick={() => actions.onEditManual?.(ln)}>
                  {t("expenses.creditCard.manualExpense.edit")}
                </Button>
              ) : null}
              {canMakeInstallment ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={makeInstallmentBusy || deleteBusy}
                  onClick={() => actions.onMakeInstallmentLine?.(ln)}
                >
                  {ln.cuota_purchase_kind
                    ? t("accountDetail.creditCard.makeInstallmentActionPending")
                    : t("accountDetail.creditCard.makeInstallmentAction")}
                </Button>
              ) : null}
              {canDelete ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={deleteBusy || makeInstallmentBusy}
                  aria-label={t("accountDetail.creditCard.facturacionDeleteLineAria")}
                  onClick={() => actions.onDeleteLine?.(ln)}
                >
                  {t("accountDetail.creditCard.facturacionDeleteLine")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A cut branch that could be several places: one button per place; the pick names every such row. */
function BranchChoice({ choices }: { choices: { key: string; options: string[] } }) {
  const { t } = useTranslation();
  const pick = usePostVendorBranchChoiceMutation();
  return (
    <div className={styles.panelBigGroup}>
      <span className="muted" title={t("expenses.creditCard.lineRow.branchChoiceHint")}>
        {t("expenses.creditCard.lineRow.branchChoiceLabel")}
      </span>
      {choices.options.map((option) => (
        <Button
          key={option}
          variant="ghost"
          size="sm"
          disabled={pick.isPending}
          onClick={() => pick.mutate({ key: choices.key, display: option })}
        >
          {option}
        </Button>
      ))}
    </div>
  );
}

function SortButton({
  sortKey,
  label,
  sort,
  onSort,
}: {
  sortKey: SortKey;
  label: string;
  sort: SortState;
  onSort: (key: SortKey) => void;
}) {
  const { t } = useTranslation();
  const active = sort?.key === sortKey;
  return (
    <button
      type="button"
      className={cn(styles.sortButton, active && styles.sortButtonActive)}
      aria-label={t("expenses.creditCard.lineRow.sortAria", { column: label })}
      aria-pressed={active}
      onClick={() => onSort(sortKey)}
    >
      {label}
      {active ? <span aria-hidden>{sort.direction === "asc" ? " ▲" : " ▼"}</span> : null}
    </button>
  );
}

/**
 * Expense lines as a responsive list: one row per line — origin icon, date and the category pill
 * (+ the big group's once set) on top, the merchant (+ note, ⓘ linked details) and the amount
 * (installment detail in superscript) below; the ⋯ button opens the row's extras (big group while
 * unset, note editor, pieces, installments, delete), with a red badge when the line waits on the user. The header is a set of
 * sort buttons (date, category, amount) that sort and reverse the rows. Same rendering at every
 * width; narrow containers stack the pills under the merchant.
 */
export function CreditCardExpenseLinesTable({
  lines,
  categories,
  emptyLabel,
  showCategoryControls = true,
  showBigGroupControls = false,
  bigGroups = [],
  collapsedVisibleRows,
  showMoreLabel,
  showLessLabel,
  showDeleteAction = false,
  deletableLineIds,
  onDeleteLine,
  deletePendingLineId,
  makeInstallmentLineIds,
  onMakeInstallmentLine,
  makeInstallmentBusyLineId,
  onEditPieces,
  onEditManual,
  enableCheckingNotes = false,
  loading,
}: {
  lines: readonly FlowCcExpenseLineRow[];
  categories: readonly CcExpenseCategoryDto[];
  emptyLabel: string;
  showCategoryControls?: boolean;
  showBigGroupControls?: boolean;
  bigGroups?: readonly CcExpenseBigGroupDto[];
  collapsedVisibleRows?: number;
  showMoreLabel?: string;
  showLessLabel?: string;
  showDeleteAction?: boolean;
  deletableLineIds?: ReadonlySet<number>;
  onDeleteLine?: (line: FlowCcExpenseLineRow) => void;
  deletePendingLineId?: number;
  makeInstallmentLineIds?: ReadonlySet<number>;
  onMakeInstallmentLine?: (line: FlowCcExpenseLineRow) => void;
  makeInstallmentBusyLineId?: number;
  /** Break a card / checking purchase line into dated pieces (row extras). */
  onEditPieces?: (line: FlowCcExpenseLineRow) => void;
  /** Edit or delete a manual expense line (row extras). */
  onEditManual?: (line: FlowCcExpenseLineRow) => void;
  /** Show note inputs for cuenta corriente (checking) rows — expenses tab only. */
  enableCheckingNotes?: boolean;
  /** Lines still loading: the header renders with no rows (not the empty label), dimmed. */
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const selection = useCreditCardExpenseLinesSelection();
  const [sort, setSort] = useState<SortState>(null);
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);

  const categoryLabelBySlug = useMemo(
    () => new Map(categories.map((c) => [c.slug, ccExpenseCategoryPathLabel(c)])),
    [categories]
  );
  const sorted = useMemo(
    () =>
      sortLines(lines, sort, (ln) => {
        const slug = lineCategorySlug(ln);
        return slug ? (categoryLabelBySlug.get(slug) ?? slug) : null;
      }),
    [categoryLabelBySlug, lines, sort]
  );

  if (lines.length === 0 && !loading) {
    return <p className="muted" style={{ marginBottom: "1rem" }}>{emptyLabel}</p>;
  }

  const onSort = (key: SortKey) =>
    setSort((prev) =>
      prev?.key === key
        ? { key, direction: prev.direction === "desc" ? "asc" : "desc" }
        : { key, direction: "desc" }
    );
  const toggleExpanded = (key: string) =>
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const limit = collapsedVisibleRows != null && collapsedVisibleRows > 0 ? collapsedVisibleRows : null;
  const hidden = limit != null ? Math.max(0, sorted.length - limit) : 0;
  const visible = hidden > 0 && !showAll ? sorted.slice(0, limit ?? undefined) : sorted;
  const actions: RowActions = {
    showDeleteAction,
    deletableLineIds,
    onDeleteLine,
    deletePendingLineId,
    makeInstallmentLineIds,
    onMakeInstallmentLine,
    makeInstallmentBusyLineId,
    onEditPieces,
    onEditManual,
    enableCheckingNotes,
  };
  const anySelected = selection != null && selection.selectedKeys.size > 0;

  return (
    <div className={cn(styles.wrap, loading && loadableClass(true))}>
      <div
        className={cn(
          styles.list,
          anySelected && styles.listHasSelection
        )}
      >
        <div className={styles.header}>
          <SortButton sortKey="date" label={t("expenses.creditCard.lineRow.sortDate")} sort={sort} onSort={onSort} />
          <span className={styles.headerRight}>
            <SortButton
              sortKey="category"
              label={t("expenses.creditCard.lineRow.sortCategory")}
              sort={sort}
              onSort={onSort}
            />
            <SortButton
              sortKey="amount"
              label={t("expenses.creditCard.lineRow.sortAmount")}
              sort={sort}
              onSort={onSort}
            />
          </span>
        </div>
        <div role="list">
          {visible.map((ln) => {
            const key = expenseLineRowKey(ln);
            return (
              <ExpenseLineRow
                key={key}
                line={ln}
                categories={categories}
                bigGroups={bigGroups}
                showCategoryControls={showCategoryControls}
                showBigGroupControls={showBigGroupControls}
                selectable={showCategoryControls}
                actions={actions}
                expanded={expandedKeys.has(key)}
                onToggleExpanded={() => toggleExpanded(key)}
              />
            );
          })}
        </div>
      </div>
      {hidden > 0 ? (
        <Button variant="ghost" onClick={() => setShowAll((s) => !s)}>
          {showAll
            ? (showLessLabel ?? t("table.showLess"))
            : (showMoreLabel ?? t("table.showMoreRows", { count: hidden }))}
        </Button>
      ) : null}
    </div>
  );
}
