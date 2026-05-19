import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type AppMessageRow } from "../api";
import { Table } from "../components/Table";

function formatWhen(iso: string): string {
  const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("es-CL", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function MessageBody({ body }: { body: string }) {
  return (
    <pre className="messages-body-pre">{body}</pre>
  );
}

function MessagesTable({
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
            <td style={{ verticalAlign: "top", fontWeight: r.read_at ? 400 : 600 }}>{r.title}</td>
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

export function MessagesPage() {
  const { t } = useTranslation();
  const [notifications, setNotifications] = useState<AppMessageRow[]>([]);
  const [logs, setLogs] = useState<AppMessageRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await api.markMessagesRead();
        const [n, l] = await Promise.all([api.messages("notification"), api.messages("log")]);
        if (!cancelled) {
          setNotifications(n.messages);
          setLogs(l.messages);
          window.dispatchEvent(new Event("nw-messages-read"));
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : t("common.loadFailed"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  if (err) {
    return <p className="error">{err}</p>;
  }

  return (
    <>
      <h1>{t("messages.pageTitle")}</h1>
      <p className="muted">{t("messages.pageHint")}</p>

      <h2 className="flow-section-title">{t("messages.notificationsTitle")}</h2>
      <MessagesTable
        rows={notifications}
        showReadAt
        emptyLabel={t("messages.notificationsEmpty")}
        showMoreLabel={t("messages.showMore")}
        showLessLabel={t("messages.showLess")}
        colDate={t("messages.colDate")}
        colTitle={t("messages.colTitle")}
        colDetail={t("messages.colDetail")}
        colRead={t("messages.colRead")}
      />

      <h2 className="flow-section-title" style={{ marginTop: "2rem" }}>
        {t("messages.logsTitle")}
      </h2>
      <MessagesTable
        rows={logs}
        showReadAt={false}
        emptyLabel={t("messages.logsEmpty")}
        showMoreLabel={t("messages.showMore")}
        showLessLabel={t("messages.showLess")}
        colDate={t("messages.colDate")}
        colTitle={t("messages.colTitle")}
        colDetail={t("messages.colDetail")}
        colRead={t("messages.colRead")}
      />
    </>
  );
}
