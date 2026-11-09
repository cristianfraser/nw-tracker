import { cn } from "../../cn";
import { useTranslation } from "../../i18n";
import { Pill } from "../ui/Pill";
import styles from "./FlowRows.module.css";

/** One movement as the list draws it (every string already formatted). */
export type FlowRowItem = {
  key: string;
  date: string;
  type: string;
  /** The accounts cell: names either side of the arrow; null when the page or the outside world is that side. */
  accounts: FlowAccountsCell;
  amount: string;
  /** Units moved («12,4 acciones»), drawn small after the amount. */
  units: string | null;
  note: string | null;
};

export type FlowAccountsCell = { left: string | null; arrow: "→" | "←" | null; right: string | null };

/**
 * What the accounts cell reads. On an account's page (`account`) the page's account is not
 * named: the arrow says whether money left (→) or arrived (←), then the other account when
 * there is one. On a group or the dashboard (`group`) it always reads origin → target: a
 * transfer from → to (shown once when both are on the page), money arriving from outside
 * «→ account», money leaving «account →».
 */
export function flowAccountsCell(
  mode: "account" | "group",
  row: {
    account_name: string;
    from_account_name: string | null;
    to_account_name: string | null;
    counterpart_account_name: string | null;
    money_direction: "in" | "out" | null;
  }
): FlowAccountsCell {
  if (row.money_direction == null) return { left: mode === "group" ? row.account_name : null, arrow: null, right: null };
  if (mode === "account") {
    return { left: null, arrow: row.money_direction === "out" ? "→" : "←", right: row.counterpart_account_name };
  }
  if (row.from_account_name != null && row.to_account_name != null) {
    return { left: row.from_account_name, arrow: "→", right: row.to_account_name };
  }
  return row.money_direction === "in"
    ? { left: null, arrow: "→", right: row.account_name }
    : { left: row.account_name, arrow: "→", right: null };
}

/**
 * The flows list, one rendering at every width (no desktop table beside mobile cards), styled
 * like the detalle and expense rows. While every row fits on one line the rows share the list's
 * columns (a subgrid of it) under a header line: date, type, accounts (`flowAccountsCell`),
 * amount, note. Below the list's breakpoint (a container query on its frame, wider for a list
 * that names both accounts: `FlowRows.module.css`) a row is three lines: date and type with the
 * amount on the right; the accounts; the note.
 */
export function FlowRows({
  rows,
  accountsLabel,
  emptyMessage,
  bothAccounts,
  placeholderRows = 0,
}: {
  rows: readonly FlowRowItem[];
  /** The rows name both accounts (a group's list): they need more room before wrapping. */
  bothAccounts: boolean;
  /** Header of the accounts column («Cuentas» with the row's account shown, «Cuenta contraparte» without). */
  accountsLabel: string;
  /** Shown when there are no rows; null while loading. */
  emptyMessage: string | null;
  /**
   * Blank rows to draw while there are no rows yet (one page while loading): each has a real
   * row's cells, so the list takes its loaded height and nothing below it moves when data lands.
   */
  placeholderRows?: number;
}) {
  const { t } = useTranslation();
  return (
    <div className={bothAccounts ? styles.frameWide : styles.frameNarrow}>
      <div role="list" className={styles.list}>
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
        {rows.length === 0
          ? Array.from({ length: placeholderRows }, (_, i) => (
              <div key={`placeholder-${i}`} role="listitem" aria-hidden="true" className={styles.row}>
                <span className={cn("mono", styles.date)}>{"\u00a0"}</span>
                <span className={styles.type}>
                  <Pill size="small" uppercase={false} label={"\u00a0"} backgroundColor="transparent" textColor="transparent" />
                </span>
                <span className={styles.accounts}>{"\u00a0"}</span>
                <span className={cn("mono", styles.amount)}>{"\u00a0"}</span>
                <span className={styles.note}>{"\u00a0"}</span>
              </div>
            ))
          : null}
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
              <FlowAccounts cell={row.accounts} />
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
    </div>
  );
}

/** The two sides of the accounts cell and the arrow between them; an unnamed side is left out. */
function FlowAccounts({ cell }: { cell: FlowAccountsCell }) {
  return (
    <>
      {cell.left ? <span>{cell.left}</span> : null}
      {cell.arrow ? (
        <span className={styles.arrow} aria-hidden="true">
          {cell.arrow}
        </span>
      ) : null}
      {cell.right ? <span>{cell.right}</span> : null}
    </>
  );
}
