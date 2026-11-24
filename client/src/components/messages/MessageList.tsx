import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppMessageRow } from "../../api";
import { cn } from "../../cn";
import { formatDateTimeLabel } from "../../formatDateLabel";
import { loadableClass } from "../ui/Loadable";
import { Button } from "@crfrsr/ui";
import styles from "./MessageList.module.css";

/** Messages shown before «Mostrar más…». */
const COLLAPSED_ROWS = 5;

function formatWhen(iso: string): string {
  const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return formatDateTimeLabel(d);
}

function firstLine(body: string): string {
  return body.split(/\r?\n/, 1)[0] ?? "";
}

function MessageRow({ row, showReadAt }: { row: AppMessageRow; showReadAt: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const id = useId();
  /* Unread when the list was fetched. Opening the notifications page marks every message read on
     the server, but the list keeps what was new on arrival (the bold), so an open message never
     says «unread»: only a read time when there is one. */
  const isNew = showReadAt && !row.read_at;
  return (
    <div className={cn(styles.row, open && styles.open)} role="listitem">
      <button
        type="button"
        className={styles.line}
        aria-expanded={open}
        aria-controls={open ? `${id}-body` : undefined}
        aria-labelledby={`${id}-title ${id}-date`}
        aria-describedby={open ? undefined : `${id}-first`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.date} id={`${id}-date`}>
          {formatWhen(row.created_at)}
        </span>
        <span className={cn(styles.title, isNew && styles.unread)} id={`${id}-title`}>
          {row.title}
          {isNew ? <span className="visually-hidden">{` (${t("messages.new")})`}</span> : null}
        </span>
        {/* Open, the whole detail is right below: the first line would show twice. */}
        {open ? null : (
          <span className={styles.first} id={`${id}-first`}>
            {firstLine(row.body)}
          </span>
        )}
        <span className={styles.chevron} aria-hidden="true">
          ›
        </span>
      </button>
      {open ? (
        <div className={styles.body} id={`${id}-body`}>
          <pre className={styles.pre}>{row.body}</pre>
          {showReadAt && row.read_at ? (
            <div className={styles.readAt}>{t("messages.readAt", { when: formatWhen(row.read_at) })}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * App messages (notifications, the sync log): one line per message — date, title, the detail's
 * first line — that opens into its whole detail. One rendering at every width (a container query
 * puts the first line under the title when narrow), so there is no desktop/phone pair to keep.
 */
export function MessageList({
  rows,
  showReadAt,
  emptyLabel,
  showMoreLabel,
  showLessLabel,
  loading,
}: {
  rows: AppMessageRow[];
  /** Notifications: titles unread on arrival are bold and an open message says when it was read. */
  showReadAt: boolean;
  emptyLabel: string;
  showMoreLabel: string;
  showLessLabel: string;
  loading?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasHidden = rows.length > COLLAPSED_ROWS;
  const shown = hasHidden && !expanded ? rows.slice(0, COLLAPSED_ROWS) : rows;
  return (
    <div className={loadableClass(loading, styles.frame)} aria-busy={loading || undefined}>
      <div className={styles.list} role="list">
        {rows.length === 0 ? (
          loading ? null : (
            <div className={cn(styles.empty, "muted")} role="listitem">
              {emptyLabel}
            </div>
          )
        ) : (
          shown.map((r) => <MessageRow key={r.id} row={r} showReadAt={showReadAt} />)
        )}
      </div>
      {hasHidden ? (
        <Button variant="ghost" onClick={() => setExpanded((e) => !e)}>
          {expanded ? showLessLabel : showMoreLabel}
        </Button>
      ) : null}
    </div>
  );
}
