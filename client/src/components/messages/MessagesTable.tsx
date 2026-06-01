import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { AppMessageRow } from "../../api";
import { Modal } from "../ui/Modal";
import { Table } from "../ui/Table";

/** Legacy log titles appended ` YYYY-MM-DD HH:MM:SS UTC` (now stored in `created_at` only). */
const LEGACY_LOG_TITLE_TIMESTAMP = / \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/;

const MAX_DETAIL_LINES = 5;

const showMoreDetailBtnStyle: CSSProperties = {
  margin: "0.25rem 0 0",
  padding: "0.15rem 0",
  border: "none",
  background: "none",
  cursor: "pointer",
  font: "inherit",
  fontSize: "0.82rem",
  color: "var(--muted)",
  textDecoration: "underline",
  textUnderlineOffset: "2px",
};

function logTitleForDisplay(title: string): string {
  return title.replace(LEGACY_LOG_TITLE_TIMESTAMP, "");
}

function formatWhen(iso: string): string {
  const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("es-CL", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function detailLineCount(body: string): number {
  if (!body) return 0;
  return body.split(/\r?\n/).length;
}

function detailFirstLines(body: string, maxLines: number): string {
  const lines = body.split(/\r?\n/);
  if (lines.length <= maxLines) return body;
  return lines.slice(0, maxLines).join("\n");
}

function MessageBodyPre({ body }: { body: string }) {
  return <pre className="messages-body-pre">{body}</pre>;
}

function MessageDetailCell({
  body,
  title,
  createdAt,
}: {
  body: string;
  title: string;
  createdAt: string;
}) {
  const { t } = useTranslation();
  const [modalOpen, setModalOpen] = useState(false);
  const lines = detailLineCount(body);
  const truncated = lines > MAX_DETAIL_LINES;
  const displayBody = truncated ? detailFirstLines(body, MAX_DETAIL_LINES) : body;
  const displayTitle = logTitleForDisplay(title);

  return (
    <>
      <MessageBodyPre body={displayBody} />
      {truncated ? (
        <button
          type="button"
          className="muted"
          style={showMoreDetailBtnStyle}
          onClick={() => setModalOpen(true)}
        >
          {t("messages.showMoreDetail")}
        </button>
      ) : null}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={displayTitle}
        subtitle={formatWhen(createdAt)}
        closeAriaLabel={t("messages.detailModalClose")}
      >
        <MessageBodyPre body={body} />
      </Modal>
    </>
  );
}

export function MessagesTable({
  rows,
  showReadAt,
  emptyLabel,
  showMoreLabel,
  showLessLabel,
  colDate,
  colTitle,
  colDetail,
  colRead,
}: {
  rows: AppMessageRow[];
  showReadAt: boolean;
  emptyLabel: string;
  showMoreLabel: string;
  showLessLabel: string;
  colDate: string;
  colTitle: string;
  colDetail: string;
  colRead: string;
}) {
  return (
    <Table
      collapsedVisibleRows={5}
      showMoreLabel={showMoreLabel}
      showLessLabel={showLessLabel}
      header={
        <thead>
          <tr>
            <th style={{ width: "11rem" }}>{colDate}</th>
            <th>{colTitle}</th>
            <th>{colDetail}</th>
            {showReadAt ? <th style={{ width: "7rem" }}>{colRead}</th> : null}
          </tr>
        </thead>
      }
    >
      {rows.length === 0 ? (
        <tr>
          <td colSpan={showReadAt ? 4 : 3} className="muted">
            {emptyLabel}
          </td>
        </tr>
      ) : (
        rows.map((r) => (
          <tr key={r.id}>
            <td className="muted" style={{ whiteSpace: "nowrap", verticalAlign: "top" }}>
              {formatWhen(r.created_at)}
            </td>
            <td style={{ verticalAlign: "top", fontWeight: r.read_at ? 400 : 600 }}>
              {logTitleForDisplay(r.title)}
            </td>
            <td style={{ verticalAlign: "top" }}>
              <MessageDetailCell body={r.body} title={r.title} createdAt={r.created_at} />
            </td>
            {showReadAt ? (
              <td className="muted" style={{ verticalAlign: "top" }}>
                {r.read_at ? formatWhen(r.read_at) : "—"}
              </td>
            ) : null}
          </tr>
        ))
      )}
    </Table>
  );
}
