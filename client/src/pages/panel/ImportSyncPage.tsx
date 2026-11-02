import { useTranslation } from "react-i18next";
import { PageGridTile } from "../../components/layout/PageGridTile";
import { MessagesTable } from "../../components/messages/MessagesTable";
import { AvailableDocumentsTable } from "../../components/sync/AvailableDocumentsTable";
import { GenericUniqueMerchantsPanel } from "../../components/sync/GenericUniqueMerchantsPanel";
import { IngestRunsPanel } from "../../components/sync/IngestRunsPanel";
import { JobQueuePanel } from "../../components/sync/JobQueuePanel";
import { SyncLogStatusPanel } from "../../components/sync/SyncLogStatusPanel";
import {
  useGenericUniqueMerchants,
  useImportSyncDocumentCoverage,
  useIngestRunsStatus,
  useJobQueue,
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
    data: ingestRuns,
    error: ingestRunsError,
    isPending: ingestRunsPending,
  } = useIngestRunsStatus();
  const { data: jobQueue, error: jobQueueError, isPending: jobQueuePending } = useJobQueue();
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
        : ingestRunsError instanceof Error
          ? ingestRunsError.message
          : jobQueueError instanceof Error
            ? jobQueueError.message
            : coverageError instanceof Error
            ? coverageError.message
            : genericMerchantsError instanceof Error
              ? genericMerchantsError.message
              : logsError || syncStatusError || ingestRunsError || jobQueueError || coverageError || genericMerchantsError
                ? t("common.loadFailed")
                : null;

  if (err) {
    return <p className="error">{err}</p>;
  }

  return (
    <>
      <PageGridTile id="ingest-runs">
        <h2 className="flow-section-title">{t("importSync.ingestRunsTitle")}</h2>
        <IngestRunsPanel status={ingestRuns} loading={ingestRunsPending} />
        <h3>{t("importSync.jobs.title")}</h3>
        <JobQueuePanel queue={jobQueue} loading={jobQueuePending} />
      </PageGridTile>

      <PageGridTile id="sync-log">
        <h2 className="flow-section-title">
          {t("importSync.syncLogTitle")}
        </h2>
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
      </PageGridTile>

      <PageGridTile id="documents">
        <h2 className="flow-section-title">
          {t("importSync.availableDocumentsTitle")}
        </h2>
        <AvailableDocumentsTable data={coverage} loading={coveragePending} />
      </PageGridTile>

      <PageGridTile id="unique-merchants">
        <h2 className="flow-section-title">
          {t("importSync.genericUniqueMerchantsTitle")}
        </h2>
        <GenericUniqueMerchantsPanel
          merchants={genericMerchants?.merchants ?? []}
          loading={genericMerchantsPending}
        />
      </PageGridTile>
    </>
  );
}
