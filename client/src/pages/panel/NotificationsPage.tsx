import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { MessagesTable } from "../../components/messages/MessagesTable";
import { useMarkMessagesReadMutation, useMessages } from "../../queries/hooks";

export function NotificationsPage() {
  const { t } = useTranslation();
  const markRead = useMarkMessagesReadMutation();
  const {
    data: notificationsData,
    error: notificationsError,
    isPending: notificationsPending,
  } = useMessages("notification");

  useEffect(() => {
    markRead.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mark read once on mount
  }, []);

  const notifications = notificationsData?.messages ?? [];
  const err =
    markRead.error instanceof Error
      ? markRead.error.message
      : notificationsError instanceof Error
        ? notificationsError.message
        : markRead.error || notificationsError
          ? t("common.loadFailed")
          : null;

  if (notificationsPending) {
    return <p className="muted">{t("common.loading")}</p>;
  }

  if (err) {
    return <p className="error">{err}</p>;
  }

  return (
    <>
      <p className="muted" style={{ marginBottom: "1rem" }}>
        {t("notifications.pageHint")}
      </p>
      <MessagesTable
        rows={notifications}
        showReadAt
        emptyLabel={t("notifications.empty")}
        showMoreLabel={t("notifications.showMore")}
        showLessLabel={t("notifications.showLess")}
        colDate={t("notifications.colDate")}
        colTitle={t("notifications.colTitle")}
        colDetail={t("notifications.colDetail")}
        colRead={t("notifications.colRead")}
      />
    </>
  );
}
