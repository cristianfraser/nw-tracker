import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppMessageRow } from "../../api";
import { formatWhen } from "../../storedInstant";
import { loadableClass } from "../ui/Loadable";
import { OpenRow, OpenRows } from "../ui/OpenRows";
import { Button } from "@crfrsr/ui";
import styles from "./MessageList.module.css";

/** Messages shown before «Mostrar más…». */
const COLLAPSED_ROWS = 5;

function firstLine(body: string): string {
  return body.split(/\r?\n/, 1)[0] ?? "";
}

function MessageRow({ row, showReadAt }: { row: AppMessageRow; showReadAt: boolean }) {
  const { t } = useTranslation();
  /* Unread when the list was fetched. Opening the notifications page marks every message read on
     the server, but the list keeps what was new on arrival (the bold), so an open message never
     says «unread»: only a read time when there is one. */
  const isNew = showReadAt && !row.read_at;
  return (
    <OpenRow
      lead={formatWhen(row.created_at)}
      title={
        <>
          {row.title}
          {isNew ? <span className="visually-hidden">{` (${t("messages.new")})`}</span> : null}
        </>
      }
      titleStrong={isNew}
      first={firstLine(row.body)}
      // Open, the whole detail is right below: the first line would show twice.
      hideFirstWhenOpen
    >
      <pre className={styles.pre}>{row.body}</pre>
      {showReadAt && row.read_at ? (
        <div className={styles.readAt}>{t("messages.readAt", { when: formatWhen(row.read_at) })}</div>
      ) : null}
    </OpenRow>
  );
}

/**
 * App messages (notifications, the sync log): one line per message — date, title, the detail's
 * first line — that opens into its whole detail. The rows are the shared `OpenRows` (one rendering
 * at every width), which the import sync panels use too.
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
    <div className={loadableClass(loading)} aria-busy={loading || undefined}>
      <OpenRows leadInline empty={rows.length === 0 && !loading ? emptyLabel : undefined}>
        {shown.map((r) => (
          <MessageRow key={r.id} row={r} showReadAt={showReadAt} />
        ))}
      </OpenRows>
      {hasHidden ? (
        <Button variant="ghost" onClick={() => setExpanded((e) => !e)}>
          {expanded ? showLessLabel : showMoreLabel}
        </Button>
      ) : null}
    </div>
  );
}
