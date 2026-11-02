import { useRef } from "react";
import { cn } from "../../cn";
import { useTranslation } from "../../i18n";
import { Pill } from "../ui/Pill";
import { useWrapWhenOverflowing } from "../ui/useWrapWhenOverflowing";
import styles from "./FlowRows.module.css";

/** One movement as the list draws it (every string already formatted). */
export type FlowRowItem = {
  key: string;
  date: string;
  type: string;
  /** The row's own account; null on a single-account page, where the page names it. */
  account: string | null;
  counterpart: string | null;
  /** The money's direction from the row's account: → it left, ← it arrived. */
  direction: "out" | "in" | null;
  amount: string;
  /** Units moved («12,4 acciones»), drawn small after the amount. */
  units: string | null;
  note: string | null;
};

const ARROW = { out: "→", in: "←" } as const;

/**
 * The flows list, one rendering at every width (no desktop table beside mobile cards), styled
 * like the detalle and expense rows. While every row fits on one line the rows share the list's
 * columns (a subgrid of it) under a header line: date, type, accounts, amount, note. When they do
 * not (measured), a row is three lines: date and type with the amount on the right; the accounts;
 * the note.
 */
export function FlowRows({
  rows,
  accountsLabel,
  emptyMessage,
}: {
  rows: readonly FlowRowItem[];
  /** Header of the accounts column («Cuentas» with the row's account shown, «Cuenta contraparte» without). */
  accountsLabel: string;
  /** Shown when there are no rows; null while loading (header only). */
  emptyMessage: string | null;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  useWrapWhenOverflowing(listRef, styles.wrapped!);

  return (
    <div ref={listRef} role="list" className={styles.list}>
      <div className={styles.header} aria-hidden="true">
        <span>{t("accountDetail.flowDateColumn")}</span>
        <span>{t("accountDetail.flowTypeColumn")}</span>
        <span>{accountsLabel}</span>
        <span className={styles.headerAmount}>{t("accountDetail.flowAmountColumn")}</span>
        <span>{t("accountDetail.flowNoteColumn")}</span>
      </div>
      {rows.length === 0 && emptyMessage ? (
        <div role="listitem" className={cn("muted", styles.empty)}>
          {emptyMessage}
        </div>
      ) : null}
      {rows.map((row) => (
        <div key={row.key} role="listitem" className={styles.row}>
          <span className={cn("mono", styles.date)}>{row.date}</span>
          <span className={styles.type}>
            <Pill
              size="small"
              uppercase={false}
              label={row.type}
              backgroundColor="var(--surface2)"
              textColor="var(--text)"
            />
          </span>
          <span className={styles.accounts}>
            <FlowAccounts row={row} />
          </span>
          <span className={cn("mono", styles.amount)}>
            {row.amount}
            {row.units ? (
              <sup className={styles.units} title={t("accountDetail.flowUnitsColumn")}>
                {row.units}
              </sup>
            ) : null}
          </span>
          <span className={cn("muted", styles.note)} title={row.note ?? undefined}>
            {row.note}
          </span>
        </div>
      ))}
    </div>
  );
}

/** «Cuenta corriente → santander ·0781», «Fintual USD ← SPY»; the arrow alone leads on an account's own page. */
function FlowAccounts({ row }: { row: FlowRowItem }) {
  const arrow = row.direction ? ARROW[row.direction] : null;
  if (!row.counterpart) return row.account ? <>{row.account}</> : null;
  return (
    <>
      {row.account ? <span className={styles.account}>{row.account}</span> : null}
      <span className={styles.arrow} aria-hidden={arrow ? undefined : true}>
        {arrow ?? "·"}
      </span>
      <span className={styles.counterpart}>{row.counterpart}</span>
    </>
  );
}
