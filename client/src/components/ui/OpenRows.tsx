import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "../../cn";
import { loadableClass } from "./Loadable";
import styles from "./OpenRows.module.css";

export type StatusTone = "ok" | "active" | "bad" | "muted";

const TONE_CLASS: Record<StatusTone, string> = {
  ok: styles.toneOk,
  active: styles.toneActive,
  bad: styles.toneBad,
  muted: styles.toneMuted,
};

/** A row's state as one coloured word (ok, running, failed…). */
export function StatusWord({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return <span className={cn(styles.statusWord, TONE_CLASS[tone])}>{children}</span>;
}

/** The label / value pairs of an opened row. An entry with no value is left out. */
export function RowFacts({ facts }: { facts: [label: string, value: ReactNode][] }) {
  const shown = facts.filter(([, value]) => value != null && value !== "");
  if (shown.length === 0) return null;
  return (
    <dl className={styles.facts}>
      {shown.map(([label, value]) => (
        <div key={label} className={styles.fact}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A list of one-line rows that open in place (the app messages, the usage lists, and every panel of the import
 * sync page). One rendering at every width: wide, the list is the grid and each line a subgrid of
 * it, so the cells line up down the list; under 40rem of its own frame a line becomes two or three.
 */
export function OpenRows({
  children,
  loading,
  empty,
  leadInline,
}: {
  children: ReactNode;
  loading?: boolean;
  /** Shown instead of the rows once loaded with none. */
  empty?: ReactNode;
  /**
   * Narrow frames: the lead (a date) stays right of the title instead of taking its own line.
   * For lists whose rows carry no status and no action (the messages).
   */
  leadInline?: boolean;
}) {
  return (
    <div className={loadableClass(loading, styles.frame, leadInline && styles.leadInline)} aria-busy={loading || undefined}>
      <div className={styles.list} role="list">
        {empty != null ? (
          <div className={cn(styles.empty, "muted")} role="listitem">
            {empty}
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

/**
 * One row: lead (a date, in mono), title, status word, a muted first line that cuts with «…»,
 * an action, and — when it has `children` — a chevron: the line is then a button that opens the
 * children under it. The action sits beside the toggle, never inside it (a button cannot hold
 * another), in the same grid row.
 */
export function OpenRow({
  lead,
  title,
  titleStrong,
  status,
  first,
  hideFirstWhenOpen,
  action,
  children,
  defaultOpen = false,
}: {
  lead?: ReactNode;
  title: ReactNode;
  titleStrong?: boolean;
  status?: ReactNode;
  first?: ReactNode;
  /** The opened row repeats the first line (a message's whole body): hide it while open. */
  hideFirstWhenOpen?: boolean;
  action?: ReactNode;
  children?: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const openable = children != null && children !== false;
  const isOpen = openable && open;
  const hasLead = lead != null;
  const hasStatus = status != null;
  // An empty first line is no first line: the title keeps the track and nothing describes the row.
  const hasFirst = first != null && first !== "";
  const showFirst = hasFirst && !(isOpen && hideFirstWhenOpen);
  const hasAction = action != null && action !== false;
  // Wide layout: a cell this row lacks gives its track (and gap) to its neighbour.
  // Tracks: lead | title | status | first | action | chevron.
  const cellColumns = {
    "--title-col": `${hasLead ? 2 : 1} / ${hasStatus || hasFirst ? 3 : hasAction ? 5 : 6}`,
    "--first-col": `${hasStatus ? 4 : 3} / ${hasAction ? 5 : 6}`,
  } as CSSProperties;
  const cells = (
    <>
      {hasLead ? (
        <span className={styles.lead} id={`${id}-lead`}>
          {lead}
        </span>
      ) : null}
      <span className={cn(styles.title, titleStrong && styles.strong)} id={`${id}-title`}>
        {title}
      </span>
      {hasStatus ? (
        <span className={styles.status} id={`${id}-status`}>
          {status}
        </span>
      ) : null}
      {showFirst ? (
        <span className={styles.first} id={`${id}-first`}>
          {first}
        </span>
      ) : null}
      {openable ? (
        <span className={styles.chevron} aria-hidden="true">
          ›
        </span>
      ) : null}
    </>
  );
  return (
    <div className={cn(styles.row, isOpen && styles.open)} role="listitem" style={cellColumns}>
      <div className={styles.line}>
        {openable ? (
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={isOpen}
            aria-controls={isOpen ? `${id}-body` : undefined}
            aria-labelledby={cn(`${id}-title`, hasStatus && `${id}-status`, hasLead && `${id}-lead`)}
            aria-describedby={showFirst ? `${id}-first` : undefined}
            onClick={() => setOpen((o) => !o)}
          >
            {cells}
          </button>
        ) : (
          <div className={cn(styles.toggle, styles.static)}>{cells}</div>
        )}
        {hasAction ? <span className={styles.action}>{action}</span> : null}
      </div>
      {isOpen ? (
        <div className={styles.body} id={`${id}-body`}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
