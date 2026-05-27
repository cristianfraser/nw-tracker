import type { AppMessageRow } from "../../api";
import { Table } from "../ui/Table";

/** Legacy log titles appended ` YYYY-MM-DD HH:MM:SS UTC` (now stored in `created_at` only). */
const LEGACY_LOG_TITLE_TIMESTAMP = / \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/;

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

function MessageBody({ body }: { body: string }) {
  return <pre className="messages-body-pre">{body}</pre>;
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
              <MessageBody body={r.body} />
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
