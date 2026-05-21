import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { AppMessageRow } from "../api";
import { Table } from "../components/Table";
import { SyncLogStatusPanel } from "../components/SyncLogStatusPanel";
import { useMarkMessagesReadMutation, useMessages, useSyncStatus } from "../queries/hooks";

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
  const markRead = useMarkMessagesReadMutation();
  const {
    data: notificationsData,
    error: notificationsError,
    isPending: notificationsPending,
  } = useMessages("notification");
  const { data: logsData, error: logsError, isPending: logsPending } = useMessages("log");
  const {
    data: syncStatus,
    error: syncStatusError,
    isPending: syncStatusPending,
  } = useSyncStatus();

  useEffect(() => {
    markRead.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mark read once on mount
  }, []);

  const notifications = notificationsData?.messages ?? [];
  const logs = logsData?.messages ?? [];
  const err =
    markRead.error instanceof Error
      ? markRead.error.message
      : notificationsError instanceof Error
        ? notificationsError.message
        : logsError instanceof Error
          ? logsError.message
          : syncStatusError instanceof Error
            ? syncStatusError.message
            : markRead.error || notificationsError || logsError || syncStatusError
              ? t("common.loadFailed")
              : null;

  if (notificationsPending || logsPending || syncStatusPending) {
    return <p className="muted">{t("common.loading")}</p>;
  }

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
      {syncStatus ? <SyncLogStatusPanel status={syncStatus} /> : null}
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
