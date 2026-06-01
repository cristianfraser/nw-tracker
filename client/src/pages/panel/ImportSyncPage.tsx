import { useTranslation } from "react-i18next";
import { MessagesTable } from "../../components/messages/MessagesTable";
import { AvailableDocumentsTable } from "../../components/sync/AvailableDocumentsTable";
import { GenericUniqueMerchantsPanel } from "../../components/sync/GenericUniqueMerchantsPanel";
import { SyncLogStatusPanel } from "../../components/sync/SyncLogStatusPanel";
import {
  useGenericUniqueMerchants,
  useImportSyncDocumentCoverage,
  useMessages,
  useSyncStatus,
} from "../../queries/hooks";

export function ImportSyncPage() {
  const { t } = useTranslation();
  const { data: logsData, error: logsError, isPending: logsPending } = useMessages("log");
  const {
    data: syncStatus,
    error: syncStatusError,
    isPending: syncStatusPending,
  } = useSyncStatus();
  const {
    data: coverage,
    error: coverageError,
    isPending: coveragePending,
  } = useImportSyncDocumentCoverage();
  const {
    data: genericMerchants,
    error: genericMerchantsError,
    isPending: genericMerchantsPending,
  } = useGenericUniqueMerchants();

  const logs = logsData?.messages ?? [];
  const err =
    logsError instanceof Error
      ? logsError.message
      : syncStatusError instanceof Error
        ? syncStatusError.message
        : coverageError instanceof Error
          ? coverageError.message
          : genericMerchantsError instanceof Error
            ? genericMerchantsError.message
            : logsError || syncStatusError || coverageError || genericMerchantsError
              ? t("common.loadFailed")
              : null;

  if (logsPending || syncStatusPending || coveragePending || genericMerchantsPending) {
    return <p className="muted">{t("common.loading")}</p>;
  }

  if (err) {
    return <p className="error">{err}</p>;
  }

  return (
    <>
      <p className="muted" style={{ marginBottom: "1rem" }}>
        {t("importSync.pageHint")}
      </p>

      <h2 className="flow-section-title">{t("importSync.syncLogTitle")}</h2>
      {syncStatus ? <SyncLogStatusPanel status={syncStatus} /> : null}
      <MessagesTable
        rows={logs}
        showReadAt={false}
        emptyLabel={t("importSync.logsEmpty")}
        showMoreLabel={t("importSync.showMore")}
        showLessLabel={t("importSync.showLess")}
        colDate={t("importSync.colDate")}
        colTitle={t("importSync.colTitle")}
        colDetail={t("importSync.colDetail")}
        colRead={t("importSync.colRead")}
      />

      <h2 className="flow-section-title" style={{ marginTop: "2rem" }}>
        {t("importSync.availableDocumentsTitle")}
      </h2>
      <p className="muted" style={{ fontSize: "var(--font-size-ui)", marginBottom: "0.5rem" }}>
        {t("importSync.availableDocumentsHint")}
      </p>
      {coverage ? <AvailableDocumentsTable data={coverage} /> : null}

      <h2 className="flow-section-title" style={{ marginTop: "2rem" }}>
        {t("importSync.genericUniqueMerchantsTitle")}
      </h2>
      {genericMerchants ? (
        <GenericUniqueMerchantsPanel merchants={genericMerchants.merchants} />
      ) : null}
    </>
  );
}
