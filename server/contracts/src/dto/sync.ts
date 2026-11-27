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
  | "stocks_london"
  | "yahoo_fx_usd"
  | "fx_pairs"
  | "crypto_eod";

export type SyncSourceDisplayStatus = "ok" | "stale" | "disabled";

export type SyncSourceDayKind = "open" | "weekend" | "holiday";

export interface SyncSourceWallTime {
  ymd: string;
  hour: number;
  minute: number;
  timeZone: "America/Santiago" | "America/New_York" | "Europe/London";
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

export type CcStatementCoverageCurrency = "clp" | "usd"; // convention-ok: the statement PDF corpus is filed in clp/ and usd/ folders per card

export interface ImportSyncDocumentAccount {
  account_id: number;
  label: string;
  document_kind: ImportSyncDocumentKind;
  /** CLP/USD column when this card has at least one USD PDF statement. */
  cc_statement_currency?: CcStatementCoverageCurrency;
}

/**
 * What a month's cell shows (server-decided); `before_first` = before the column's first document,
 * `not_due` = the month in progress with no document yet. Neither counts in a year's figures.
 */
export type ImportSyncDocumentCellState =
  | "imported"
  | "imported_no_file"
  | "no_movements"
  | "file_not_imported"
  | "missing"
  | "not_due"
  | "before_first";

/** How the page shows a document: the browser's PDF viewer, or a table of the workbook's rows. */
export type ImportSyncDocumentPreviewKind = "pdf" | "sheet";

/** A month's source file on the server's disk, as the page opens it (server-built links). */
export type ImportSyncDocumentRef = {
  /** The file's name on disk (no folder). */
  file_name: string;
  /** The file itself, `Content-Disposition: inline` (a PDF shows in the browser). */
  view_href: string;
  /** The same file as an attachment. */
  download_href: string;
} & (
  | { preview_kind: "pdf"; sheet_href: null }
  /** `sheet_href`: `GET` → `ImportSyncSheetPreviewResponse`. */
  | { preview_kind: "sheet"; sheet_href: string }
);

/**
 * `GET /api/import-sync/documents/:accountId/:month/sheet` — a workbook's cells, every sheet
 * (hidden ones too), at least one. A text cell is its text; a number cell is the raw number (the
 * page formats it with the user's separators); a date cell is `YYYY-MM-DD` (`YYYY-MM-DD HH:MM`
 * when it carries a time, `HH:MM` alone for a time of day); an empty cell is "". A merged range shows in its top-left cell only.
 * Rows may differ in length.
 */
export interface ImportSyncSheetPreviewResponse {
  file_name: string;
  sheets: { name: string; rows: (string | number)[][] }[];
}

export interface ImportSyncDocumentCell {
  imported: boolean;
  /** The month's source PDF/XLSX when it is on the server's disk. */
  document: ImportSyncDocumentRef | null;
  /** PDF text includes `** CARTOLA SIN MOVIMIENTOS **`. */
  file_sin_movimientos?: boolean;
  state: ImportSyncDocumentCellState;
}

/** One year of the matrix: its months and, per column, the months counted and imported. */
export interface ImportSyncDocumentYear {
  year: number;
  /** Indexes into `months` / `cells` of this year's months, newest first. */
  month_indexes: number[];
  /**
   * Per column of `accounts`; null = the column has no document by this year. `counted` 0 = its
   * only month this year is the one in progress.
   */
  columns: ({ counted: number; imported: number } | null)[];
  /** Columns with a counted month this year, and those with every counted month imported. */
  columns_counted: number;
  columns_complete: number;
  /** The columns short of a month this year, in column order. */
  incomplete_columns: number[];
}

/** `GET /api/import-sync/document-coverage` */
export interface ImportSyncDocumentCoverageResponse {
  months: string[];
  accounts: ImportSyncDocumentAccount[];
  cells: ImportSyncDocumentCell[][];
  /** The matrix by year, newest first. */
  years: ImportSyncDocumentYear[];
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
  /** How many of `recent` the page shows before «Show more…». */
  recent_shown: number;
}
