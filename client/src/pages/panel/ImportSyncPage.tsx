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

  if (err) {
    return <p className="error">{err}</p>;
  }

  return (
    <>

      <h2 className="flow-section-title">{t("importSync.syncLogTitle")}</h2>
      <SyncLogStatusPanel status={syncStatus} loading={syncStatusPending} />
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
        loading={logsPending}
      />

      <h2 className="flow-section-title" style={{ marginTop: "2rem" }}>
        {t("importSync.availableDocumentsTitle")}
      </h2>
      <AvailableDocumentsTable data={coverage} loading={coveragePending} />

      <h2 className="flow-section-title" style={{ marginTop: "2rem" }}>
        {t("importSync.genericUniqueMerchantsTitle")}
      </h2>
      <GenericUniqueMerchantsPanel
        merchants={genericMerchants?.merchants ?? []}
        loading={genericMerchantsPending}
      />
    </>
  );
}
