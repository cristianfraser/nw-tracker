import { DEMO_EDITS_LIMITED } from "../../demoEdits";
import { chileTodayYmd } from "../../calendarMonth";
import { createContext, Fragment, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { Button, Input } from "@crfrsr/ui";
import { cn } from "../../cn";
import { shownNameText, useTranslation } from "../../i18n";
import { expenseLineRowKey, useCreditCardExpenseLinesSelection } from "./CreditCardExpenseLinesSelection";
import { formatLineAmount, lineAmountParts, parseNumberInput } from "../../format";
import { formatCardBillingPesos } from "../../formatNative";
import { linePesos, lineValueIn } from "../../lineMoney";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import type { CcExpenseBigGroupDto, CcExpenseCategoryDto, FlowCcExpenseLineRow } from "../../types";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { loadableClass } from "../ui/Loadable";
import { Pill } from "../ui/Pill";
import { PillPicker } from "../ui/PillPicker";
import { expenseLineCategoryTargetId } from "../../ccExpenseLineBuckets";
import { assignableCcExpenseCategories, ccExpenseCategoryPathLabel } from "../../ccExpenseCategories";
import { ExpensePurchaseNoteInput } from "./ExpensePurchaseNoteInput";
import { ExpenseBigGroupPicker } from "./ExpenseBigGroupPicker";
import { ExpenseOriginIcon } from "./ExpenseOriginIcon";
import { ExpenseLinePiecesDialog } from "./ExpenseLinePiecesDialog";
import {
  ExpenseRowMoreButton,
  ExpenseVendorLabel,
  ExpenseVendorPanelLink,
  Joined,
  useExpenseVendorLinkLabel,
} from "./ExpenseVendorLabel";
import {
  useAssignCcExpenseLineCategory,
  useDeleteCcPurchaseMutation,
  useDeleteCcStatementLineMutation,
  useAnnulCcPurchaseMutation,
  useUndoCcAnnulledPurchaseMutation,
  useUpdateCcPurchaseCuotasMutation,
  useMakeStatementLineInstallmentMutation,
  usePostVendorBranchChoiceMutation,
  useHeldCardRefundCandidates,
  useLinkCardRefundMutation,
  useUnlinkCardRefundMutation,
} from "../../queries/hooks";
import { nextSeenKeys } from "../../rowArrivalAnimation";
import { ROW_ARRIVED_ATTR, useRowArrivalAnimation } from "./useRowArrivalAnimation";
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
  // Ordering compares every line in one unit; pesos is the one every line has a value in.
  return (
    lineDate(b).localeCompare(lineDate(a)) ||
    b.occurred_on.localeCompare(a.occurred_on) ||
    Math.abs(linePesos(b)) - Math.abs(linePesos(a))
  );
}

export function sortCreditCardExpenseLinesByAmountDesc(
  a: FlowCcExpenseLineRow,
  b: FlowCcExpenseLineRow
): number {
  return linePesos(b) - linePesos(a) || b.occurred_on.localeCompare(a.occurred_on);
}

type SortKey = "date" | "amount" | "category";
export type ExpenseLinesSort = { key: SortKey; direction: "asc" | "desc" };
type SortState = ExpenseLinesSort | null;

/**
 * Sorts by the column's value; ties keep the incoming order. «No category» stays last in both
 * directions (it is the absence of a category, not a label).
 */
function sortLines(
  lines: readonly FlowCcExpenseLineRow[],
  sort: SortState,
  unit: string,
  categoryLabel: (line: FlowCcExpenseLineRow) => string | null,
  dateOf: (line: FlowCcExpenseLineRow) => string = lineDate
): readonly FlowCcExpenseLineRow[] {
  if (!sort) return lines;
  const sign = sort.direction === "asc" ? 1 : -1;
  return lines
    .map((line, index) => ({ line, index }))
    .sort((a, b) => {
      let cmp: number;
      if (sort.key === "date") cmp = sign * dateOf(a.line).localeCompare(dateOf(b.line));
      else if (sort.key === "amount") cmp = sign * (lineValueIn(a.line, unit) - lineValueIn(b.line, unit));
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

/**
 * The unit the lines on screen were requested in (their `converted` figures): the shown payload's
 * own `unit`, which during a unit switch is the held payload's, not the picker's. Set by every
 * lines table (`unit`, required) and by {@link ExpenseLinesUnitScope}; there is no fallback.
 */
const LinesUnitContext = createContext<string | null>(null);

/** Sets the lines' unit for the rows below that are not inside a lines table (a candidates list). */
export function ExpenseLinesUnitScope({ unit, children }: { unit: string; children: ReactNode }) {
  return <LinesUnitContext.Provider value={unit}>{children}</LinesUnitContext.Provider>;
}

/** The unit an expense row formats its `converted` figure in; a row drawn outside one fails. */
function useLinesUnit(): string {
  const unit = useContext(LinesUnitContext);
  if (unit == null) throw new Error("an expense row is drawn outside a lines table or ExpenseLinesUnitScope (no unit)");
  return unit;
}

/**
 * A money amount in its own currency and, when the display unit is another currency, its value in
 * the unit in parentheses («US$13,30 ($13.083)»; «≈» at today's rate). Two spans: in a list narrower
 * than 450 px the row shows only the value in the unit (`.amountOwn` and the parentheses hidden).
 */
export function MoneyAmount({
  money,
}: {
  money: { amount: { value: number; currency: string }; converted: FlowCcExpenseLineRow["converted"] };
}) {
  const unit = useLinesUnit();
  const parts = lineAmountParts(money, unit);
  if (!parts.converted) return <span className={styles.amountOwn}>{parts.own}</span>;
  return (
    <>
      <span className={styles.amountOwn}>{parts.own}</span>
      <span className={styles.amountConverted}>
        <span className={styles.amountParen}> (</span>
        {parts.converted.live ? "≈ " : ""}
        {parts.converted.text}
        <span className={styles.amountParen}>)</span>
      </span>
    </>
  );
}

/** The separator between the parts of a row's text: drawn by the row, never part of a string. */
/**
 * The amount, with a cuota's detail in superscript («3/6 · $270.000»). A plan's full-price row has
 * none: its cuota count is in the ⓘ card.
 */
function LineAmount({ line }: { line: FlowCcExpenseLineRow }) {
  let sup: string[] | null = null;
  if (
    line.line_role !== "installment_purchase_total" &&
    line.installment_flag &&
    line.nro_cuota_current != null &&
    line.nro_cuota_total != null
  ) {
    const cuota = `${line.nro_cuota_current}/${line.nro_cuota_total}`;
    sup =
      line.line_role === "installment_cuota" && line.installment_total_clp != null
        ? [cuota, formatCardBillingPesos(line.installment_total_clp)]
        : [cuota];
  }
  return (
    <span className={cn("mono", styles.amount)}>
      <MoneyAmount money={line} />
      {sup ? (
        <sup className={styles.amountSup}>
          <Joined parts={sup} />
        </sup>
      ) : null}
    </span>
  );
}

/** A failed row action's message, kept beside the control that ran it (cleared by the next try). */
function useActionError() {
  const [error, setError] = useState<string | null>(null);
  const onError = useCallback((err: unknown) => setError(err instanceof Error ? err.message : String(err)), []);
  const clear = useCallback(() => setError(null), []);
  return { error, onError, clear };
}

type RowActions = {
  onEditPieces: (line: FlowCcExpenseLineRow) => void;
  onEditManual?: (line: FlowCcExpenseLineRow) => void;
  enableCheckingNotes: boolean;
};

/** Delete for a card-feed / pasted line: confirm, then the server removes it. */
function DeleteLineButton({ line }: { line: FlowCcExpenseLineRow }) {
  const { t } = useTranslation();
  const unit = useLinesUnit();
  const del = useDeleteCcStatementLineMutation({ accountId: line.account_id });
  const [confirming, setConfirming] = useState(false);
  const failure = useActionError();
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={del.isPending}
        aria-label={t("accountDetail.creditCard.facturacionDeleteLineAria")}
        onClick={() => {
          failure.clear();
          setConfirming(true);
        }}
      >
        {t("accountDetail.creditCard.facturacionDeleteLine")}
      </Button>
      <ConfirmDialog
        open={confirming}
        title={t("accountDetail.creditCard.facturacionDeleteConfirmTitle")}
        message={t("accountDetail.creditCard.facturacionDeleteConfirmBody", {
          merchant: shownNameText(line.name),
          amount: formatLineAmount(line, unit),
        })}
        confirmLabel={t("accountDetail.creditCard.facturacionDeleteConfirmAction")}
        cancelLabel={t("accountDetail.creditCard.facturacionDeleteConfirmCancel")}
        confirmDisabled={del.isPending}
        error={failure.error}
        onConfirm={() =>
          del.mutate(line.statement_line_id, {
            onSuccess: () => setConfirming(false),
            onError: failure.onError,
          })
        }
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

/** «Anulada por el banco»: the bank dropped this unbilled purchase; the day it did, entered here. */
function AnnulPurchaseControl({ line }: { line: FlowCcExpenseLineRow }) {
  const { t } = useTranslation();
  const annul = useAnnulCcPurchaseMutation({ accountId: line.account_id });
  const [day, setDay] = useState(() => chileTodayYmd());
  const failure = useActionError();
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(day);
  const submit = () => {
    if (!valid) return;
    failure.clear();
    annul.mutate({ lineId: line.statement_line_id, annulledOn: day }, { onError: failure.onError });
  };
  return (
    <div className={styles.panelBigGroup}>
      <span className="muted">{t("expenses.creditCard.lineRow.annulled.action")}</span>
      <Input
        type="text"
        inputMode="numeric"
        value={day}
        placeholder="YYYY-MM-DD"
        aria-label={t("expenses.creditCard.lineRow.annulled.dateLabel")}
        aria-invalid={!valid || undefined}
        disabled={annul.isPending}
        onChange={(e) => setDay(e.target.value.trim())}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        style={{ width: "8.5rem" }}
      />
      <Button size="sm" disabled={!valid || annul.isPending} onClick={submit}>
        {t("expenses.creditCard.lineRow.annulled.confirm")}
      </Button>
      {!valid ? <span className="error">{t("expenses.creditCard.lineRow.annulled.dateInvalid")}</span> : null}
      {failure.error ? <span className="error" role="alert">{failure.error}</span> : null}
    </div>
  );
}

/** Undo for an annulment the user marked: confirm, then the purchase is listed again. */
function UndoAnnulmentButton({ line, annulId }: { line: FlowCcExpenseLineRow; annulId: number }) {
  const { t } = useTranslation();
  const undo = useUndoCcAnnulledPurchaseMutation({ accountId: line.account_id });
  const [confirming, setConfirming] = useState(false);
  const failure = useActionError();
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={undo.isPending}
        onClick={() => {
          failure.clear();
          setConfirming(true);
        }}
      >
        {t("expenses.creditCard.lineRow.annulled.undo")}
      </Button>
      <ConfirmDialog
        open={confirming}
        title={t("expenses.creditCard.lineRow.annulled.undoConfirmTitle")}
        message={t("expenses.creditCard.lineRow.annulled.undoConfirmBody", { merchant: shownNameText(line.name) })}
        confirmLabel={t("expenses.creditCard.lineRow.annulled.undo")}
        cancelLabel={t("accountDetail.creditCard.facturacionDeleteConfirmCancel")}
        confirmDisabled={undo.isPending}
        error={failure.error}
        onConfirm={() =>
          undo.mutate(annulId, {
            onSuccess: () => setConfirming(false),
            onError: failure.onError,
          })
        }
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

/** The installment count, entered right where the row asks for it. */
function CuotasInline({ line }: { line: FlowCcExpenseLineRow }) {
  const { t } = useTranslation();
  const make = useMakeStatementLineInstallmentMutation({ accountId: line.account_id });
  const [value, setValue] = useState("");
  const failure = useActionError();
  const parsed = parseNumberInput(value);
  const count = parsed.ok ? parsed.value : null;
  const valid = count != null && Number.isInteger(count) && count >= 2;
  const submit = () => {
    if (!valid || count == null) return;
    failure.clear();
    make.mutate({ lineId: line.statement_line_id, cuotas_totales: count }, { onError: failure.onError });
  };
  return (
    <div className={styles.panelBigGroup}>
      <Input
        type="text"
        inputMode="numeric"
        value={value}
        placeholder={t("accountDetail.creditCard.makeInstallmentDialogCuotasLabel")}
        aria-label={t("accountDetail.creditCard.makeInstallmentDialogCuotasLabel")}
        aria-invalid={!parsed.ok || undefined}
        disabled={make.isPending}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        style={{ width: "7rem" }}
      />
      <Button size="sm" disabled={!valid || make.isPending} onClick={submit}>
        {t("accountDetail.creditCard.makeInstallmentDialogConfirm")}
      </Button>
      {!parsed.ok ? <span className="error">{parsed.message}</span> : null}
      {failure.error ? <span className="error" role="alert">{failure.error}</span> : null}
    </div>
  );
}

/** A manual plan's count, changed in place, and «Quitar cuotas» to turn it back into one charge. */
function PlanCuotasControls({ line }: { line: FlowCcExpenseLineRow }) {
  const { t } = useTranslation();
  const purchaseId = line.installment_purchase_id;
  const update = useUpdateCcPurchaseCuotasMutation({ accountId: line.account_id });
  const remove = useDeleteCcPurchaseMutation({ accountId: line.account_id });
  const [value, setValue] = useState(line.nro_cuota_total != null ? String(line.nro_cuota_total) : "");
  const [confirming, setConfirming] = useState(false);
  if (purchaseId == null) {
    throw new Error(`expense line ${line.statement_line_id} can edit its plan but names none`);
  }
  const parsed = parseNumberInput(value);
  const count = parsed.ok ? parsed.value : null;
  const valid = count != null && Number.isInteger(count) && count >= 2 && count !== line.nro_cuota_total;
  const busy = update.isPending || remove.isPending;
  const { error: failureText, onError, clear } = useActionError();
  const submit = () => {
    if (!valid || count == null) return;
    clear();
    update.mutate({ purchaseId, cuotas_totales: count }, { onError });
  };
  return (
    <div className={styles.panelBigGroup}>
      <Input
        type="text"
        inputMode="numeric"
        value={value}
        aria-label={t("accountDetail.creditCard.makeInstallmentDialogCuotasLabel")}
        aria-invalid={!parsed.ok || undefined}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        style={{ width: "7rem" }}
      />
      <Button size="sm" disabled={!valid || busy} onClick={submit}>
        {t("expenses.creditCard.lineRow.planCountSave")}
      </Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
        {t("expenses.creditCard.lineRow.planRemove")}
      </Button>
      {!parsed.ok ? <span className="error">{parsed.message}</span> : null}
      {failureText && !confirming ? <span className="error" role="alert">{failureText}</span> : null}
      <ConfirmDialog
        open={confirming}
        title={t("expenses.creditCard.lineRow.planRemoveConfirmTitle")}
        message={t("expenses.creditCard.lineRow.planRemoveConfirmBody", { merchant: shownNameText(line.name) })}
        confirmLabel={t("expenses.creditCard.lineRow.planRemove")}
        cancelLabel={t("accountDetail.creditCard.facturacionDeleteConfirmCancel")}
        confirmDisabled={busy}
        error={failureText}
        onConfirm={() => remove.mutate(purchaseId, { onSuccess: () => setConfirming(false), onError })}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}

/**
 * A card credit's «Reembolso de…» (`cardRefundLinks.ts` on the server): the one same-merchant
 * purchase the server suggests, for one confirm; else a picker of the purchases it may refund; a
 * credit the user linked shows its purchase's day and may be unlinked. The server decides what it
 * may do (`can_link_refund`).
 */
function RefundLinkControl({ line }: { line: FlowCcExpenseLineRow }) {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const [open, setOpen] = useState(false);
  const link = useLinkCardRefundMutation();
  const unlink = useUnlinkCardRefundMutation();
  // Held across a unit switch while open (dimmed, in its own unit).
  const candidates = useHeldCardRefundCandidates("expenseRow.refundCandidates", displayUnit, line.account_id, line.statement_line_id, open);
  const busy = link.isPending || unlink.isPending;
  const { error: failureText, onError, clear } = useActionError();
  const failureNode = failureText ? (
    <p className="error" role="alert">
      {failureText}
    </p>
  ) : null;
  const linkTo = (purchaseLineId: number) => {
    clear();
    link.mutate(
      { account_id: line.account_id, line_id: line.statement_line_id, purchase_line_id: purchaseLineId },
      { onSuccess: () => setOpen(false), onError }
    );
  };

  if (line.refund_link_broken) {
    return (
      <div className={styles.panelBigGroup}>
        <span className="error">{t("expenses.creditCard.lineRow.refund.broken")}</span>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => unlink.mutate({ account_id: line.account_id, line_id: line.statement_line_id }, { onError })}
        >
          {t("expenses.creditCard.lineRow.refund.unlink")}
        </Button>
        {failureNode}
      </div>
    );
  }

  if (line.refund_of?.manual) {
    return (
      <div className={styles.panelBigGroup}>
        <span className="muted">{t("expenses.creditCard.lineRow.refund.label")}</span>
        <span className="mono muted">{line.refund_of.purchase_date}</span>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => unlink.mutate({ account_id: line.account_id, line_id: line.statement_line_id }, { onError })}
        >
          {t("expenses.creditCard.lineRow.refund.unlink")}
        </Button>
        {failureNode}
      </div>
    );
  }

  const suggestion = line.refund_suggestion;
  const loadError = candidates.error;
  return (
    <div className={styles.refundLink}>
      {!open ? (
        <div className={styles.panelBigGroup}>
          {suggestion ? (
            <>
              <span className="muted">{t("expenses.creditCard.lineRow.refund.suggestion")}</span>
              <span>{shownNameText(suggestion.name)}</span>
              <span className="mono muted">{suggestion.purchase_date}</span>
              <span className="mono">
                <MoneyAmount money={{ amount: suggestion.amount, converted: null }} />
              </span>
              <Button size="sm" disabled={busy} onClick={() => linkTo(suggestion.line_id)}>
                {t("expenses.creditCard.lineRow.refund.confirm")}
              </Button>
            </>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
            {suggestion ? t("expenses.creditCard.lineRow.refund.other") : t("expenses.creditCard.lineRow.refund.pick")}
          </Button>
        </div>
      ) : (
        <div className={loadableClass(candidates.loading)}>
          {loadError ? (
            <p className="error">{loadError instanceof Error ? loadError.message : t("common.loadFailed")}</p>
          ) : candidates.data && candidates.data.candidates.length === 0 ? (
            <p className="muted">{t("expenses.creditCard.lineRow.refund.empty")}</p>
          ) : (
            candidates.data ? (
              // The candidates' own unit (held across a switch), not the lines table's.
              <ExpenseLinesUnitScope unit={candidates.data.unit}>
                <div role="list" aria-label={t("expenses.creditCard.lineRow.refund.pickAria")} className={styles.refundCandidates}>
                  {candidates.data.candidates.map((c) => (
                    <button
                      key={c.line_id}
                      type="button"
                      role="listitem"
                      className={cn(styles.refundCandidate, c.merchant_match && styles.refundCandidateMatch)}
                      disabled={busy}
                      onClick={() => linkTo(c.line_id)}
                    >
                      <span className="mono muted">{c.purchase_date}</span>
                      <span className={styles.refundCandidateName}>{shownNameText(c.name)}</span>
                      <span className="mono">
                        <MoneyAmount money={c} />
                      </span>
                    </button>
                  ))}
                </div>
              </ExpenseLinesUnitScope>
            ) : null
          )}
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            {t("expenses.creditCard.lineRow.refund.close")}
          </Button>
        </div>
      )}
      {failureNode}
    </div>
  );
}

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
  date,
  hideOrigin = false,
  hideDate = false,
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
  /** The date the row shows instead of the line's purchase date (a list ordered by another day). */
  date?: string;
  /** No origin cell (and so no bulk-select checkbox). */
  hideOrigin?: boolean;
  /** No date cell (a list grouped under day headers). */
  hideDate?: boolean;
}) {
  const { t } = useTranslation();
  const selection = useCreditCardExpenseLinesSelection();
  const linkLabel = useExpenseVendorLinkLabel(ln);
  // A payslip deduction's category is the deduction's own: no picker, no bulk select, no group.
  const fixedCategory = ln.source === "payslip";
  const canSelect = !hideOrigin && selectable && selection != null && !fixedCategory && !ln.annulment;
  const selected = canSelect && selection.isSelected(ln);

  // What the row may do is the server's call (`can_*`, `expenseLineShapes.ts`); the demo keeps
  // deletions closed on top of it.
  const canDelete = !DEMO_EDITS_LIMITED && ln.can_delete === true;
  const { annulled, annulment } = ln;
  // A pasted / fed one-shot charge may be marked annulled by the bank; its mark, when the user's, undone.
  const canAnnul = canDelete && !annulled && !annulment && !ln.installment_flag && linePesos(ln) > 0;
  const canUndoAnnul = !DEMO_EDITS_LIMITED && annulled?.basis === "manual";
  const canMakeInstallment = ln.can_make_installment === true;
  const canEditInstallment = ln.can_edit_installment === true;
  const canEditPieces = ln.can_edit_pieces === true;
  const hasPieces = ln.piece_seq != null || ln.pieces_remainder === true;
  const canEditManual = actions.onEditManual != null && ln.source === "manual" && ln.statement_line_id > 0;
  const showNoteInput =
    !DEMO_EDITS_LIMITED &&
    Boolean(ln.purchase_key) &&
    (ln.source === "cc" || (actions.enableCheckingNotes && ln.source === "checking"));
  const noteStatementLineId =
    ln.statement_line_id > 0 ? ln.statement_line_id : ln.category_statement_line_id ?? undefined;
  // The demo leaves branch picks closed (they write a catalog row every visitor would see).
  const branchChoices = DEMO_EDITS_LIMITED ? null : ln.branch_choices;
  const canLinkRefund = !DEMO_EDITS_LIMITED && ln.can_link_refund === true;
  // A suggested purchase waits on one confirm.
  const needsAction =
    ln.cuota_purchase_kind != null ||
    branchChoices != null ||
    (canLinkRefund && (ln.refund_suggestion != null || ln.refund_link_broken === true));
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
    canEditInstallment ||
    canAnnul ||
    canUndoAnnul ||
    canLinkRefund ||
    canDelete;
  const merchant = shownNameText(ln.name);

  return (
    <div
      role="listitem"
      className={cn(
        styles.row,
        hideOrigin && (hideDate ? styles.rowBare : styles.rowNoOrigin),
        selected && styles.rowSelected,
        canSelect && styles.rowSelectable
      )}
    >
      {hideOrigin ? null : (
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
      )}
      {hideDate ? null : <div className={cn("mono", "muted", styles.date)}>{date ?? lineDate(ln)}</div>}
      <div className={styles.pills}>
        {bigGroupOnRow ? (
          <ExpenseBigGroupPicker purchaseKey={ln.purchase_key} value={ln.big_group_slug} groups={bigGroups} />
        ) : null}
        {annulled ? (
          <Pill
            size="small"
            label={t("expenses.creditCard.lineRow.annulled.badge", { date: annulled.annulled_on })}
            backgroundColor="#6b7280"
          />
        ) : null}
        {annulment ? (
          <Pill size="small" label={t("expenses.creditCard.lineRow.annulled.annulmentBadge")} backgroundColor="#6b7280" />
        ) : null}
        {showCategoryControls && !fixedCategory && !annulment ? (
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
                  {canMakeInstallment ? <CuotasInline line={ln} /> : null}
                </>
              ) : null}
            </div>
          ) : null}
          {canMakeInstallment && !ln.cuota_purchase_kind ? <CuotasInline line={ln} /> : null}
          {canEditInstallment ? <PlanCuotasControls line={ln} /> : null}
          {branchChoices ? <BranchChoice choices={branchChoices} /> : null}
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
          {canLinkRefund ? <RefundLinkControl line={ln} /> : null}
          {canAnnul ? <AnnulPurchaseControl line={ln} /> : null}
          {canEditPieces || canEditManual || canDelete || canUndoAnnul ? (
            <div className={styles.panelActions}>
              {canUndoAnnul && annulled ? <UndoAnnulmentButton line={ln} annulId={annulled.annulled_purchase_id} /> : null}
              {canEditPieces ? (
                <Button variant="ghost" size="sm" onClick={() => actions.onEditPieces(ln)}>
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
              {canDelete ? <DeleteLineButton line={ln} /> : null}
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
 * A row of the list that is not an expense line (an income credit on the home «Últimos
 * movimientos»): the same grid and cells — origin icon, date, pills, vendor, amount — with no ⋯.
 */
export function ExpenseListStaticRow({
  origin,
  date,
  pills,
  vendor,
  amount,
  panel,
  moreAriaLabel,
}: {
  origin: ReactNode;
  date: string;
  pills: ReactNode;
  /** The vendor cell: an `ExpenseVendorLabel` with `className={expenseListVendorClassName}`. */
  vendor: ReactNode;
  amount: ReactNode;
  /** The row's extras, opened by its ⋯ button (none: no button). */
  panel?: ReactNode;
  moreAriaLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div role="listitem" className={styles.row}>
      <div className={styles.origin}>
        <span className={styles.originIcon}>{origin}</span>
      </div>
      <div className={cn("mono", "muted", styles.date)}>{date}</div>
      <div className={styles.pills}>{pills}</div>
      {vendor}
      <div className={styles.amountCell}>
        <span className={cn("mono", styles.amount)}>{amount}</span>
      </div>
      <div className={styles.more}>
        {panel != null ? (
          <ExpenseRowMoreButton
            expanded={expanded}
            ariaLabel={moreAriaLabel ?? ""}
            onClick={() => setExpanded((e) => !e)}
          />
        ) : null}
      </div>
      {panel != null && expanded ? <div className={styles.panel}>{panel}</div> : null}
    </div>
  );
}

/** The cell class a static row's vendor label takes (the expense rows' vendor styling). */
export const expenseListVendorClassName = styles.vendor;

/**
 * One row of a list given in its own order (`items`): an expense line, drawn as the Expenses page
 * draws it with `on` as its date, or a row of another kind (`ExpenseListStaticRow`).
 */
export type ExpenseListItem =
  | { kind: "expense"; on?: string; line: FlowCcExpenseLineRow; arrivalKey?: string }
  | { kind: "custom"; key: string; node: ReactNode; arrivalKey?: string };

/**
 * What makes a row "the same row" for the arrival animation: the server's arrival key (the row's
 * flow, which a re-import or a cartola replacing the daily row keeps), else the row key.
 */
function arrivalKeyOf(item: ExpenseListItem): string {
  return item.arrivalKey ?? (item.kind === "custom" ? item.key : expenseLineRowKey(item.line));
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
  lines = [],
  items,
  categories,
  emptyLabel,
  showCategoryControls = true,
  showBigGroupControls = false,
  bigGroups = [],
  collapsedVisibleRows,
  showMoreLabel,
  showLessLabel,
  onEditManual,
  enableCheckingNotes = false,
  hideHeader = false,
  hideOrigin = false,
  hideDate = false,
  defaultSort = null,
  dateOf,
  loading,
  animateArrivals = false,
  unit: unitProp,
}: {
  lines?: readonly FlowCcExpenseLineRow[];
  /**
   * The rows in their own order, expense lines and rows of other kinds interleaved; replaces
   * `lines` (no sort header, no sorting).
   */
  items?: readonly ExpenseListItem[];
  categories: readonly CcExpenseCategoryDto[];
  emptyLabel: string;
  showCategoryControls?: boolean;
  showBigGroupControls?: boolean;
  bigGroups?: readonly CcExpenseBigGroupDto[];
  collapsedVisibleRows?: number;
  showMoreLabel?: string;
  showLessLabel?: string;
  /** Edit or delete a manual expense line (row extras). */
  onEditManual?: (line: FlowCcExpenseLineRow) => void;
  /** Show note inputs for cuenta corriente (checking) rows — expenses tab only. */
  enableCheckingNotes?: boolean;
  /** No sort header: the rows keep the order they come in (a short list such as «Últimos gastos»). */
  hideHeader?: boolean;
  /** Rows without the origin icon (and without bulk selection). */
  hideOrigin?: boolean;
  /** Rows without their date (a list of one day). */
  hideDate?: boolean;
  /** The sort the list starts in (its header shows it); none keeps the incoming order. */
  defaultSort?: ExpenseLinesSort | null;
  /** The day a row shows and the date sort reads, when not the line's purchase date. */
  dateOf?: (line: FlowCcExpenseLineRow) => string;
  /** Lines still loading: the header renders with no rows (not the empty label), dimmed. */
  loading?: boolean;
  /**
   * A row whose key was not shown before fades in with a tint and the rows below slide down on
   * desktop (`items` only; first data and value-only refetches animate nothing).
   */
  animateArrivals?: boolean;
  /**
   * The unit the lines were requested in (the shown payload's `unit`, never the picker's); rows
   * below read it. Null only while there are no lines (nothing shown yet).
   */
  unit: string | null;
}) {
  const { t, i18n } = useTranslation();
  const listRef = useRowArrivalAnimation(animateArrivals && items != null);
  const [arrival, setArrival] = useState<{ keys: string; seen: ReadonlySet<string> | null; arrived: ReadonlySet<string> }>({
    keys: "",
    seen: null,
    arrived: new Set(),
  });
  const keysSignature = (items ?? []).map(arrivalKeyOf).join("\n");
  // Adjusting state while rendering: the arrivals are the keys this list has never shown, kept for the render that commits them.
  if (keysSignature !== arrival.keys) {
    const next = nextSeenKeys(arrival.seen, keysSignature === "" ? [] : keysSignature.split("\n"));
    setArrival({ keys: keysSignature, seen: next.seen, arrived: next.arrived });
  }
  const arrivedKeys = arrival.arrived;
  const selection = useCreditCardExpenseLinesSelection();
  const [sort, setSort] = useState<SortState>(defaultSort);
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  // «Desglosar» lives in the row on every surface: the table mounts the pieces dialog once.
  const [piecesLine, setPiecesLine] = useState<FlowCcExpenseLineRow | null>(null);

  const categoryLabelBySlug = useMemo(
    () => new Map(categories.map((c) => [c.slug, ccExpenseCategoryPathLabel(c)])),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- i18n.language: the labels translate at render (no cached t()).
    [categories, i18n.language]
  );
  const unit = unitProp;
  const rowCount = items != null ? items.length : lines.length;
  if (rowCount > 0 && unit == null) throw new Error("CreditCardExpenseLinesTable: lines drawn without the unit they were requested in");
  const sorted = useMemo(
    () =>
      // No unit only with no lines (checked above): nothing to sort.
      unit == null
        ? lines
        : sortLines(lines, sort, unit, (ln) => {
            const slug = lineCategorySlug(ln);
            return slug ? (categoryLabelBySlug.get(slug) ?? slug) : null;
          }, dateOf),
    [categoryLabelBySlug, lines, sort, unit, dateOf]
  );

  if (rowCount === 0 && !loading) {
    return <p className="muted" style={{ margin: 0 }}>{emptyLabel}</p>;
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
    onEditPieces: setPiecesLine,
    onEditManual,
    enableCheckingNotes,
  };
  const anySelected = selection != null && selection.selectedKeys.size > 0;

  return (
    <LinesUnitContext.Provider value={unit}>
    <div className={cn(styles.wrap, loading && loadableClass(true))}>
      <div
        className={cn(
          styles.list,
          anySelected && styles.listHasSelection
        )}
      >
        {hideHeader || items != null ? null : (
        <div className={cn(styles.header, hideOrigin && styles.headerNoOrigin)}>
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
        )}
        <div role="list" ref={listRef}>
          {(items ?? visible.map((line): ExpenseListItem => ({ kind: "expense", line }))).map((item) => {
            const rowKey = item.kind === "custom" ? item.key : expenseLineRowKey(item.line);
            const wrap = (node: ReactNode) =>
              animateArrivals && items != null ? (
                <div
                  key={rowKey}
                  role="none"
                  className={styles.arrivalRow}
                  {...(arrivedKeys.has(arrivalKeyOf(item)) ? { [ROW_ARRIVED_ATTR]: "" } : {})}
                >
                  {node}
                </div>
              ) : (
                <Fragment key={rowKey}>{node}</Fragment>
              );
            if (item.kind === "custom") return wrap(item.node);
            const ln = item.line;
            const key = rowKey;
            return wrap(
              <ExpenseLineRow
                line={ln}
                date={item.on ?? dateOf?.(ln)}
                categories={categories}
                bigGroups={bigGroups}
                showCategoryControls={showCategoryControls}
                showBigGroupControls={showBigGroupControls}
                selectable={showCategoryControls}
                actions={actions}
                expanded={expandedKeys.has(key)}
                onToggleExpanded={() => toggleExpanded(key)}
                hideOrigin={hideOrigin}
                hideDate={hideDate}
              />
            );
          })}
        </div>
      </div>
      <ExpenseLinePiecesDialog line={piecesLine} categories={categories} onClose={() => setPiecesLine(null)} />
      {hidden > 0 ? (
        <Button variant="ghost" onClick={() => setShowAll((s) => !s)}>
          {showAll
            ? (showLessLabel ?? t("table.showLess"))
            : (showMoreLabel ?? t("table.showMoreRows", { count: hidden }))}
        </Button>
      ) : null}
    </div>
    </LinesUnitContext.Provider>
  );
}
