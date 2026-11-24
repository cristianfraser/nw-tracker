import { useId, useState } from "react";
import { Button, Input } from "@crfrsr/ui";
import { cn } from "../../cn";
import { formatGroupedDecimalTrimmed, formatMoney, formatNumberInput, parseNumberInput } from "../../format";
import { formatYearMonthLabel } from "../../formatDateLabel";
import { expenseKindLabel, useTranslation } from "../../i18n";
import {
  useDeleteRealEstateExpenseEntryMutation,
  useUnmatchRealEstateExpenseMutation,
  useUpdateRealEstateBillMonthMutation,
  useUpdateRealEstateConsumptionMutation,
  useUpdateRealEstateMonthsCoveredMutation,
} from "../../queries/mutations";
import type { RealEstateBillSlot, RealEstateExpensesResponse } from "../../types";
import { ExpenseRowMoreButton } from "../credit-card/ExpenseVendorLabel";
import styles from "../flows/FlowMonthRows.module.css";

type PlaceBlock = RealEstateExpensesResponse["by_account"][string];

/** Kinds where a kWh / m³ reading makes sense (edit affordance shown). */
const CONSUMPTION_KINDS = new Set(["electricidad", "gas", "kwh"]);

function formatAmountCell(slot: RealEstateBillSlot): string {
  if (slot.kind === "kwh") {
    return slot.kwh != null ? `${formatGroupedDecimalTrimmed(slot.kwh)} kWh` : "—";
  }
  if (slot.display_amount <= 0 && slot.expected_amount <= 0) return "—";
  if (slot.link) return formatMoney({ value: slot.link.amount, currency: slot.link.currency });
  return formatMoney({ value: slot.expected_amount, currency: slot.currency });
}

function consumptionLabel(slot: RealEstateBillSlot): string | null {
  if (slot.kind === "kwh") return null; // the reading IS the amount cell
  const parts: string[] = [];
  if (slot.kwh != null) parts.push(`${formatGroupedDecimalTrimmed(slot.kwh)} kWh`);
  if (slot.m3 != null) parts.push(`${formatGroupedDecimalTrimmed(slot.m3)} m³`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Real payment date when it falls outside the billed month (late/skipped payments). */
function paidDateForSlot(slot: RealEstateBillSlot): string | null {
  const paid = slot.expense_entry_id == null ? slot.spent_on : (slot.link?.purchase_on ?? null);
  if (!paid) return null;
  return paid.slice(0, 7) === slot.bill_month ? null : paid;
}

function linkedPurchaseLabel(slot: RealEstateBillSlot, t: (key: string) => string): string {
  if (slot.kind === "kwh") return "—";
  if (slot.expense_entry_id == null) return t("expenses.realEstate.fromLedgerHint");
  if (!slot.link) return t("expenses.realEstate.unlinked");
  const parts = [
    slot.link.merchant ?? "—",
    slot.link.purchase_on ?? "",
    slot.link.origin_label,
    slot.link.source === "checking"
      ? t("expenses.creditCard.sourceChecking")
      : t("expenses.creditCard.sourceCreditCard"),
  ].filter(Boolean);
  return parts.join(" · ");
}

/**
 * One place's bills on /flows/expenses/real_estate: the server's billed months, newest first, each
 * under a heading with its total, a row per bill (kind, linked expense, amount, ⋯) with its notes
 * under it. The ⋯ opens the bill's actions and their editors under the row. One rendering at every
 * width; below the container breakpoint the linked expense moves under the kind and amount.
 */
export function RealEstateBillMonthList({
  block,
  onLink,
}: {
  block: PlaceBlock;
  onLink: (slot: RealEstateBillSlot) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.frame}>
      {block.months.length === 0 ? (
        <p className="muted">{t("expenses.emptyAccount")}</p>
      ) : (
        <div className={cn(styles.list, styles.bills)} role="list">
          {block.months.map((m) => (
            <div key={m.bill_month} role="listitem" style={{ display: "contents" }}>
              <div className={styles.month}>
                <span>{formatYearMonthLabel(m.bill_month)}</span>
                <span className="mono">{formatMoney({ value: m.total, currency: block.currency })}</span>
              </div>
              {m.slots.map((slot) => (
                <RealEstateBillRow
                  key={slot.expense_entry_id ?? `${slot.kind}|${slot.spent_on}`}
                  slot={slot}
                  onLink={onLink}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type Editing =
  | { kind: "consumption"; kwh: string; m3: string; error: string | null }
  | {
      kind: "billMonth";
      value: string;
      monthsCovered: number;
      error: string | null;
    };

function RealEstateBillRow({
  slot,
  onLink,
}: {
  slot: RealEstateBillSlot;
  onLink: (slot: RealEstateBillSlot) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const [editing, setEditing] = useState<Editing | null>(null);
  const unmatchMutation = useUnmatchRealEstateExpenseMutation();
  const consumptionMutation = useUpdateRealEstateConsumptionMutation();
  const billMonthMutation = useUpdateRealEstateBillMonthMutation();
  const monthsCoveredMutation = useUpdateRealEstateMonthsCoveredMutation();
  const deleteEntryMutation = useDeleteRealEstateExpenseEntryMutation();
  const entryId = slot.expense_entry_id;

  const saveConsumption = async () => {
    if (entryId == null || editing?.kind !== "consumption") return;
    const kwh = parseNumberInput(editing.kwh);
    const m3 = parseNumberInput(editing.m3);
    for (const input of [kwh, m3]) {
      if (!input.ok) {
        setEditing({ ...editing, error: input.message });
        return;
      }
    }
    await consumptionMutation.mutateAsync({
      expense_entry_id: entryId,
      kwh: kwh.ok ? kwh.value : null,
      m3: m3.ok ? m3.value : null,
    });
    setEditing(null);
  };

  const saveBillMonth = async () => {
    if (entryId == null || editing?.kind !== "billMonth") return;
    try {
      if (editing.value !== slot.bill_month) {
        await billMonthMutation.mutateAsync({ expense_entry_id: entryId, bill_month: editing.value });
      }
      if (editing.monthsCovered !== slot.months_covered) {
        await monthsCoveredMutation.mutateAsync({
          expense_entry_id: entryId,
          months_covered: editing.monthsCovered,
        });
      }
      setEditing(null);
    } catch (e) {
      setEditing({ ...editing, error: e instanceof Error ? e.message : t("common.loadFailed") });
    }
  };

  const paid = paidDateForSlot(slot);
  const consumption = consumptionLabel(slot);
  const notes: { key: string; text: string; warn?: boolean; title?: string }[] = [];
  if (slot.months_covered > 1) {
    notes.push({
      key: "covers",
      text: t("expenses.realEstate.coversHint", {
        from: formatYearMonthLabel(slot.covers_from),
        to: formatYearMonthLabel(slot.bill_month),
      }),
    });
  }
  if (paid) notes.push({ key: "paid", text: t("expenses.realEstate.paidOnHint", { date: paid }) });
  if (slot.mortgage_parts) {
    notes.push({
      key: "mortgage",
      text: t("expenses.realEstate.mortgagePartsHint", {
        amortization: formatMoney({ value: slot.mortgage_parts.amortization, currency: slot.currency }),
        extra: formatMoney({ value: slot.mortgage_parts.extra_amortization, currency: slot.currency }),
        carrying: formatMoney({ value: slot.mortgage_parts.carrying, currency: slot.currency }),
      }),
    });
  }
  if (slot.link && slot.expected_amount > 0 && slot.link.amount !== slot.expected_amount) {
    notes.push({
      key: "expected",
      text: t("expenses.realEstate.expectedHint", {
        amount: formatMoney({ value: slot.expected_amount, currency: slot.currency }),
      }),
    });
  }
  if (consumption) notes.push({ key: "consumption", text: consumption });
  if (slot.link) {
    notes.push({
      key: "source",
      text:
        slot.link.link_source === "auto"
          ? t("expenses.realEstate.linkSourceAuto")
          : t("expenses.realEstate.linkSourceManual"),
    });
  }
  const brokenText = slot.broken_link
    ? slot.broken_link.problem === "missing_purchase"
      ? t("expenses.realEstate.brokenLinkMissing")
      : t("expenses.realEstate.brokenLinkOutsideWindow")
    : null;
  if (slot.broken_link && brokenText) {
    notes.push({ key: "broken", text: brokenText, warn: true, title: slot.broken_link.purchase_key });
  }

  return (
    <div className={styles.row}>
      <span className={styles.kind}>{expenseKindLabel(slot.kind)}</span>
      <span className={cn(styles.linked, slot.link && styles.linkedLinked)}>
        {linkedPurchaseLabel(slot, t)}
      </span>
      <span className={cn("mono", styles.num, styles.amount)}>{formatAmountCell(slot)}</span>
      <span className={styles.billMore}>
        {entryId != null ? (
          <ExpenseRowMoreButton
            expanded={open}
            needsAction={slot.broken_link != null}
            needsActionTitle={brokenText ?? undefined}
            ariaLabel={t("expenses.realEstate.billActions", {
              kind: expenseKindLabel(slot.kind),
              month: formatYearMonthLabel(slot.bill_month),
            })}
            controls={open ? panelId : undefined}
            onClick={() => {
              setOpen((o) => !o);
              setEditing(null);
            }}
          />
        ) : null}
      </span>
      <span className={styles.notes}>
        {notes.map((n) => (
          <span key={n.key} className={n.warn ? styles.warn : undefined} title={n.title}>
            {n.text}
          </span>
        ))}
      </span>
      {open && entryId != null ? (
        <div id={panelId} className={styles.panel}>
          <div className={styles.panelActions}>
            {slot.can_link ? (
              slot.link || slot.broken_link ? (
                <Button
                  variant="secondary"
                  disabled={unmatchMutation.isPending}
                  onClick={() => void unmatchMutation.mutateAsync(entryId)}
                >
                  {t("expenses.realEstate.unlinkAction")}
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => onLink(slot)}>
                  {t("expenses.realEstate.linkAction")}
                </Button>
              )
            ) : null}
            {CONSUMPTION_KINDS.has(slot.kind) ? (
              <Button
                variant="secondary"
                onClick={() =>
                  setEditing({
                    kind: "consumption",
                    kwh: slot.kwh != null ? formatNumberInput(slot.kwh) : "",
                    m3: slot.m3 != null ? formatNumberInput(slot.m3) : "",
                    error: null,
                  })
                }
              >
                {t("expenses.realEstate.consumptionEditAction")}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              onClick={() =>
                setEditing({
                  kind: "billMonth",
                  value: slot.bill_month,
                  monthsCovered: slot.months_covered,
                  error: null,
                })
              }
            >
              {t("expenses.realEstate.billMonthEditAction")}
            </Button>
            <Button
              variant="secondary"
              disabled={deleteEntryMutation.isPending}
              onClick={() => {
                if (window.confirm(t("expenses.realEstate.deleteEntryConfirm"))) {
                  void deleteEntryMutation.mutateAsync(entryId);
                }
              }}
            >
              {t("expenses.realEstate.deleteEntryAction")}
            </Button>
          </div>
          {editing?.kind === "consumption" ? (
            <div className={styles.editor}>
              {slot.kind !== "gas" ? (
                <span className={styles.readingInput}>
                  <Input
                    type="text"
                    inputMode="decimal"
                    value={editing.kwh}
                    placeholder="kWh"
                    onChange={(e) => setEditing({ ...editing, kwh: e.target.value, error: null })}
                  />
                </span>
              ) : (
                <span className={styles.readingInput}>
                  <Input
                    type="text"
                    inputMode="decimal"
                    value={editing.m3}
                    placeholder="m³"
                    onChange={(e) => setEditing({ ...editing, m3: e.target.value, error: null })}
                  />
                </span>
              )}
              <Button disabled={consumptionMutation.isPending} onClick={() => void saveConsumption()}>
                {t("common.save")}
              </Button>
              <Button variant="secondary" onClick={() => setEditing(null)}>
                {t("common.cancel")}
              </Button>
              {editing.error ? <span className={cn("error", styles.small)}>{editing.error}</span> : null}
            </div>
          ) : null}
          {editing?.kind === "billMonth" ? (
            <div className={styles.editor}>
              <span className={styles.monthInput}>
                <Input
                  type="month"
                  value={editing.value}
                  onChange={(e) => setEditing({ ...editing, value: e.target.value, error: null })}
                />
              </span>
              <label className={styles.editor}>
                <span className="muted">{t("expenses.realEstate.monthsCoveredLabel")}</span>
                <select
                  value={editing.monthsCovered}
                  onChange={(e) =>
                    setEditing({ ...editing, monthsCovered: Number(e.target.value), error: null })
                  }
                >
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                disabled={billMonthMutation.isPending || monthsCoveredMutation.isPending}
                onClick={() => void saveBillMonth()}
              >
                {t("common.save")}
              </Button>
              <Button variant="secondary" onClick={() => setEditing(null)}>
                {t("common.cancel")}
              </Button>
              {editing.error ? <span className={cn("error", styles.small)}>{editing.error}</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
