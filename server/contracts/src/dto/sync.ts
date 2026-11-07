export type SyncSourceId =
  | "afp_uno"
  | "afc_cic"
  | "fintual"
  | "fintual_official_serie"
  | "fintual_rn_composition"
  | "cmf_rn_portfolio"
  | "sbif_usd"
  | "sbif_eur"
  | "sbif_uf"
  | "sbif_utm"
  | "sbif_ipc"
  | "stocks_nyse"
  | "stocks_santiago"
  | "yahoo_fx_usd"
  | "crypto_eod";

export type SyncSourceDisplayStatus = "ok" | "stale" | "disabled";

export type SyncSourceDayKind = "open" | "weekend" | "holiday";

export interface SyncSourceWallTime {
  ymd: string;
  hour: number;
  minute: number;
  timeZone: "America/Santiago" | "America/New_York";
}

/** A stale source that holds everything its publisher has: the publisher is the one behind. */
export interface SyncPublisherLag {
  expected_ymd: string;
  published_ymd: string;
  last_checked_at: string;
}

export interface SyncSourceStatusRow {
  source: SyncSourceId;
  status: SyncSourceDisplayStatus;
  stale: boolean;
  publisher_lag: SyncPublisherLag | null;
  next_sync: SyncSourceWallTime | null;
  next_sync_imminent: boolean;
  today_day_kind: SyncSourceDayKind;
}

export interface SyncSchedulerStatus {
  enabled: boolean;
  interval_ms: number;
  in_flight: boolean;
  next_check_at: string | null;
}

export type ImportSyncDocumentKind =
  | "checking_cartola"
  | "cuenta_vista_cartola"
  | "cc_statement";

export type CcStatementCoverageCurrency = "clp" | "usd";

export interface ImportSyncDocumentAccount {
  account_id: number;
  label: string;
  document_kind: ImportSyncDocumentKind;
  /** CLP/USD column when this card has at least one USD PDF statement. */
  cc_statement_currency?: CcStatementCoverageCurrency;
}

export interface ImportSyncDocumentCell {
  imported: boolean;
  /** Absolute local path to the source PDF/XLSX when present on disk. */
  file_path: string | null;
  /** PDF text includes `** CARTOLA SIN MOVIMIENTOS **`. */
  file_sin_movimientos?: boolean;
}

/** `GET /api/import-sync/document-coverage` */
export interface ImportSyncDocumentCoverageResponse {
  months: string[];
  accounts: ImportSyncDocumentAccount[];
  cells: ImportSyncDocumentCell[][];
}

export interface ExpenseGenericUniqueMerchantRow {
  id: number;
  merchant_key: string;
  sort_order: number;
}

/** `GET /api/import-sync/generic-unique-merchants` */
export interface GenericUniqueMerchantsResponse {
  merchants: ExpenseGenericUniqueMerchantRow[];
}

/** `POST|PATCH /api/import-sync/generic-unique-merchants` */
export interface GenericUniqueMerchantMutationResponse {
  row: ExpenseGenericUniqueMerchantRow;
  backfill: { inserted: number; merchant_rules_removed: number };
}

/** `GET /api/sync/status` */
export interface SyncStatusResponse {
  chile: { ymd: string; hour: number; minute: number; monthKey: string };
  stale: SyncSourceId[];
  /**
   * The sources whose accounts the dashboard dims: our own staleness always, a publisher's lag
   * only from 18:00 Chile (the cuota is overdue) until it lands.
   */
  stale_dimming: SyncSourceId[];
  sources: SyncSourceStatusRow[];
  scheduler: SyncSchedulerStatus;
  /** ISO-ish timestamp from latest sync log row (`app_messages`, kind=log). */
  last_sync_at: string | null;
}

export type IngestRunKind = "nightly" | "hourly";

export type IngestRunStatus = "requested" | "done" | "failed" | "lost" | "skipped" | "not_started";

export interface IngestRunSummary {
  id: number;
  kind: IngestRunKind;
  status: IngestRunStatus;
  reason: string;
  requested_at: string | null;
  finished_at: string | null;
  failed_steps: number | null;
  error: string | null;
}

/** `GET /api/import-sync/ingest-runs`: the run in flight, the latest run of each kind and its next slot. */
export interface IngestRunsStatusResponse {
  scheduler_enabled: boolean;
  in_flight: IngestRunSummary | null;
  kinds: { kind: IngestRunKind; latest: IngestRunSummary | null; next_slot_at: string }[];
}

/** Why a queued job waits (server-decided; the page words it). */
export type JobWaitView =
  | { code: "not_before"; at: string }
  | { code: "resource"; resource: string; held_by: { id: number; kind_slug: string } }
  | { code: "exclusive"; held_by: { id: number; kind_slug: string } }
  | { code: "draining"; for_job: { id: number; kind_slug: string } };

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "superseded" | "lost";

/** One job of the queue, as the import sync page shows it. */
export interface JobView {
  id: number;
  kind_slug: string;
  status: JobStatus;
  reason: string;
  enqueued_by: string;
  resources: string[];
  worker: string | null;
  created_at: string;
  not_before: string | null;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
  lease_expires_at: string | null;
  error: string | null;
  waiting: JobWaitView | null;
  ingest_run: { id: number; status: string; failed_steps: number | null } | null;
  can_cancel: boolean;
  can_retry: boolean;
}

/** `GET /api/import-sync/jobs`: the job queue (docs/job-queue-plan.md). */
export interface JobQueueResponse {
  scheduler_enabled: boolean;
  running: JobView[];
  queued: JobView[];
  recent: JobView[];
}
