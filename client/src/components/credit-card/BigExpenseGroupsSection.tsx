import { useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import { formatClp } from "../../format";
import type { CcExpenseBigGroupDto, CcExpenseCategoryDto, FlowCcExpenseLineRow } from "../../types";
import type { CcInstallmentGastosMode } from "../../ccExpensePeriodMonth";
import { bigGroupsWithUsage } from "../../ccExpenseBigGroupTotals";
import {
  useDeleteCcExpenseBigGroupMutation,
  useRenameCcExpenseBigGroupMutation,
} from "../../queries/hooks";
import { CreditCardExpenseLinesTable } from "./CreditCardExpenseLinesTable";

function BigGroupBlock({
  slug,
  label,
  totalClp,
  purchaseCount,
  lines,
  categories,
  bigGroups,
  excludedFromChart,
  onToggleExcluded,
}: {
  slug: string;
  label: string;
  totalClp: number;
  purchaseCount: number;
  lines: readonly FlowCcExpenseLineRow[];
  categories: readonly CcExpenseCategoryDto[];
  bigGroups: readonly CcExpenseBigGroupDto[];
  excludedFromChart: boolean;
  onToggleExcluded: () => void;
}) {
  const { t } = useTranslation();
  const rename = useRenameCcExpenseBigGroupMutation();
  const del = useDeleteCcExpenseBigGroupMutation();
  const [open, setOpen] = useState(false);

  const groupLines = useMemo(
    () => lines.filter((ln) => ln.big_group_slug === slug),
    [lines, slug]
  );

  const onRename = () => {
    const next = window.prompt(t("expenses.creditCard.bigGroups.renamePrompt"), label);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === label) return;
    rename.mutate({ slug, label: trimmed });
  };

  const onDelete = () => {
    if (
      !window.confirm(
        t("expenses.creditCard.bigGroups.deleteConfirm", { label, count: purchaseCount })
      )
    ) {
      return;
    }
    del.mutate(slug);
  };

  return (
    <section style={{ marginBottom: "1.25rem" }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "0.5rem 1rem",
          marginBottom: open ? "0.5rem" : 0,
        }}
      >
        <button
          type="button"
          className="muted"
          style={{ fontWeight: 600, fontSize: "1rem" }}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? "▾" : "▸"} {label}
          <span className="mono muted" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
            {formatClp(totalClp)} · {t("expenses.creditCard.bigGroups.purchaseCount", { count: purchaseCount })}
          </span>
        </button>
        <button type="button" className="muted" disabled={rename.isPending} onClick={onRename}>
          {t("expenses.creditCard.bigGroups.renameAction")}
        </button>
        <button
          type="button"
          className="muted"
          disabled={del.isPending || purchaseCount > 0}
          title={
            purchaseCount > 0
              ? t("expenses.creditCard.bigGroups.deleteBlockedHint")
              : undefined
          }
          onClick={onDelete}
        >
          {t("expenses.creditCard.bigGroups.deleteAction")}
        </button>
        <label className="radio-pill" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={excludedFromChart} onChange={onToggleExcluded} />
          {t("expenses.creditCard.bigGroups.chartFilterLabel")}
        </label>
      </div>
      {open ? (
        <CreditCardExpenseLinesTable
          lines={groupLines}
          categories={categories}
          bigGroups={bigGroups}
          showBigGroupControls
          emptyLabel={t("expenses.creditCard.bigGroups.emptyGroup")}
        />
      ) : null}
    </section>
  );
}

export function BigExpenseGroupsSection({
  lines,
  categories,
  bigGroups,
  installmentMode,
  isExcluded,
  toggleExcluded,
}: {
  lines: readonly FlowCcExpenseLineRow[];
  categories: readonly CcExpenseCategoryDto[];
  bigGroups: readonly CcExpenseBigGroupDto[];
  installmentMode: CcInstallmentGastosMode;
  isExcluded: (slug: string) => boolean;
  toggleExcluded: (slug: string) => void;
}) {
  const { t } = useTranslation();
  const usage = useMemo(
    () => bigGroupsWithUsage(lines, bigGroups, installmentMode),
    [bigGroups, installmentMode, lines]
  );

  if (usage.length === 0) {
    return null;
  }

  return (
    <section style={{ marginTop: "2rem", marginBottom: "1.5rem" }}>
      <h3 style={{ fontSize: "1.1rem", marginBottom: "0.35rem" }}>
        {t("expenses.creditCard.bigGroups.sectionTitle")}
      </h3>
      <p className="muted" style={{ fontSize: "var(--font-size-ui)", marginBottom: "0.75rem" }}>
        {t("expenses.creditCard.bigGroups.sectionHint")}
      </p>
      {usage.map((g) => (
        <BigGroupBlock
          key={g.slug}
          slug={g.slug}
          label={g.label}
          totalClp={g.total_clp}
          purchaseCount={g.purchase_count}
          lines={lines}
          categories={categories}
          bigGroups={bigGroups}
          excludedFromChart={isExcluded(g.slug)}
          onToggleExcluded={() => toggleExcluded(g.slug)}
        />
      ))}
    </section>
  );
}
