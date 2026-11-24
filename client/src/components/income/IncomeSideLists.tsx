import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@crfrsr/ui";
import { DEMO_EDITS_LIMITED } from "../../demoEdits";
import { ccExpenseCategoryLabel, shownNameText, useTranslation } from "../../i18n";
import { formatFlowMoney } from "../../flowsDisplay";
import { formatIncomeMoney } from "../../incomeAggregates";
import type { DisplayUnit } from "../../queries/keys";
import type { FlowsIncomeResponse, ShownName, TransferCounterparty } from "../../types";
import {
  useForceIncludeIncomeMovementMutation,
  useIncomeRefundMutation,
  useRestoreIncomeMovementMutation,
} from "../../queries/mutations";
import { cn } from "../../cn";
import { TransferCounterpartyLine } from "../flows/TransferCounterpartyLine";
import { ChevronIcon } from "../ui/ChevronIcon";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { loadableClass } from "../ui/Loadable";
import { PaginatedTable, useClientPagination } from "../ui/PaginatedTable";
import { IncomeLineRow } from "./IncomeLineRow";
import styles from "./IncomeRows.module.css";

const PAGE_SIZE = 15;

type SideLine = {
  movement_id: number;
  account_id: number;
  account_label: string;
  received_on: string;
  amount: number | null;
  name: ShownName;
  transfer_counterparty?: TransferCounterparty;
};

type Target = { movement_id: number; name: ShownName; received_on: string };

/**
 * One of the income page's side lists, closed until asked for: its heading shows how many lines
 * it holds and their sum (the server's). Open, it lists the lines a page at a time.
 */
function SideSection<L extends SideLine>({
  title,
  hint,
  emptyLabel,
  rows,
  total,
  displayUnit,
  loading,
  detail,
  action,
}: {
  title: string;
  hint?: string;
  emptyLabel: string;
  rows: readonly L[];
  total: number;
  displayUnit: DisplayUnit;
  loading?: boolean;
  /** What stands in the kind column: the refund's category, the filter's reason, the note. */
  detail: (row: L) => ReactNode;
  action: (row: L) => ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { page, setPage, pageRows, total: count } = useClientPagination(rows, PAGE_SIZE);
  return (
    <section className={cn(styles.section, open && styles.sectionOpen)}>
      <button type="button" className={styles.sectionHead} aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronIcon className={styles.chevron} />
        <h3 className={styles.sectionTitle}>{title}</h3>
        <span className={loadableClass(loading, styles.small, styles.nowrap)}>
          {t("income.sideListCount", { count: rows.length })} · <span className="mono">{formatFlowMoney(total, displayUnit)}</span>
        </span>
      </button>
      {open ? (
        <div className={styles.sectionBody}>
          {hint ? <p className={cn("muted", styles.small)}>{hint}</p> : null}
          {rows.length === 0 && !loading ? (
            <p className="muted">{emptyLabel}</p>
          ) : (
            <PaginatedTable page={page} pageSize={PAGE_SIZE} total={count} onPageChange={setPage} loading={loading}>
              <div className={styles.frame}>
                <div className={cn(styles.list, styles.lines)}>
                  {pageRows.map((row) => (
                    <IncomeLineRow
                      key={row.movement_id}
                      date={row.received_on}
                      kind={detail(row)}
                      name={
                        <>
                          {shownNameText(row.name)}
                          <TransferCounterpartyLine counterparty={row.transfer_counterparty} />
                        </>
                      }
                      account={<Link to={`/account/${row.account_id}`}>{row.account_label}</Link>}
                      amount={formatIncomeMoney(row.amount, displayUnit)}
                      action={action(row)}
                    />
                  ))}
                </div>
              </div>
            </PaginatedTable>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The credits that are not income, each list collapsed: refunds of spending (back to income with
 * one click), credits a filter left out (include) and credits excluded by hand (restore).
 */
export function IncomeSideLists({
  data,
  displayUnit,
  loading,
}: {
  data: FlowsIncomeResponse | undefined;
  displayUnit: DisplayUnit;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const incomeRefund = useIncomeRefundMutation();
  const forceInclude = useForceIncludeIncomeMovementMutation();
  const restore = useRestoreIncomeMovementMutation();
  const [includeTarget, setIncludeTarget] = useState<Target | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<Target | null>(null);
  const totals = data?.list_totals ?? { refund_lines: 0, filtered_lines: 0, excluded_lines: 0 };
  const target = (row: SideLine): Target => ({ movement_id: row.movement_id, name: row.name, received_on: row.received_on });
  const confirmText = (key: string, tgt: Target | null) =>
    tgt ? t(key, { date: tgt.received_on, description: shownNameText(tgt.name) }) : "";

  return (
    <>
      <SideSection
        title={t("income.sectionRefunds")}
        hint={t("income.refundsHint")}
        emptyLabel={t("income.refundsEmpty")}
        rows={data?.refund_lines ?? []}
        total={totals.refund_lines}
        displayUnit={displayUnit}
        loading={loading}
        detail={(row) => <span className={styles.small}>{ccExpenseCategoryLabel(row.category_slug)}</span>}
        action={(row) => (
          <Button
            variant="secondary" size="sm"
            disabled={incomeRefund.isPending}
            onClick={() => incomeRefund.mutate({ movement_id: row.movement_id, refund: false })}
          >
            {t("income.backToIncome")}
          </Button>
        )}
      />
      <SideSection
        title={t("income.sectionFiltered")}
        emptyLabel={t("income.filteredEmpty")}
        rows={data?.filtered_lines ?? []}
        total={totals.filtered_lines}
        displayUnit={displayUnit}
        loading={loading}
        detail={(row) => <span className={cn("muted", styles.small)}>{t(`income.filterReason.${row.filter_reason}`)}</span>}
        action={(row) =>
          DEMO_EDITS_LIMITED ? null : (
            <Button variant="secondary" size="sm" disabled={forceInclude.isPending} onClick={() => setIncludeTarget(target(row))}>
              {t("income.includeLine")}
            </Button>
          )
        }
      />
      <SideSection
        title={t("income.sectionExcluded")}
        emptyLabel={t("income.excludedEmpty")}
        rows={data?.excluded_lines ?? []}
        total={totals.excluded_lines}
        displayUnit={displayUnit}
        loading={loading}
        detail={(row) => (row.note ? <span className={cn("muted", styles.small)}>{row.note}</span> : null)}
        action={(row) =>
          DEMO_EDITS_LIMITED ? null : (
            <Button variant="secondary" size="sm" disabled={restore.isPending} onClick={() => setRestoreTarget(target(row))}>
              {t("income.restoreLine")}
            </Button>
          )
        }
      />

      <ConfirmDialog
        open={includeTarget != null}
        title={t("income.includeConfirmTitle")}
        message={confirmText("income.includeConfirmMessage", includeTarget)}
        confirmLabel={t("income.includeConfirmAction")}
        cancelLabel={t("income.includeConfirmCancel")}
        onCancel={() => setIncludeTarget(null)}
        onConfirm={() => {
          if (!includeTarget) return;
          forceInclude.mutate(includeTarget.movement_id, { onSettled: () => setIncludeTarget(null) });
        }}
      />
      <ConfirmDialog
        open={restoreTarget != null}
        title={t("income.restoreConfirmTitle")}
        message={confirmText("income.restoreConfirmMessage", restoreTarget)}
        confirmLabel={t("income.restoreConfirmAction")}
        cancelLabel={t("income.restoreConfirmCancel")}
        onCancel={() => setRestoreTarget(null)}
        onConfirm={() => {
          if (!restoreTarget) return;
          restore.mutate(restoreTarget.movement_id, { onSettled: () => setRestoreTarget(null) });
        }}
      />
    </>
  );
}
