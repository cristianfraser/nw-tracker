export type SyncSourceId =
  | "afp_uno"
  | "fintual"
  | "fintual_rn_composition"
  | "sbif_usd"
  | "sbif_eur"
  | "sbif_uf"
  | "sbif_utm"
  | "sbif_ipc"
  | "stocks_nyse"
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

export interface SyncSourceStatusRow {
  source: SyncSourceId;
  status: SyncSourceDisplayStatus;
  stale: boolean;
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

export interface CcExpenseGenericUniqueMerchantRow {
  id: number;
  merchant_key: string;
  sort_order: number;
}

/** `GET /api/import-sync/generic-unique-merchants` */
export interface GenericUniqueMerchantsResponse {
  merchants: CcExpenseGenericUniqueMerchantRow[];
}

/** `POST|PATCH /api/import-sync/generic-unique-merchants` */
export interface GenericUniqueMerchantMutationResponse {
  row: CcExpenseGenericUniqueMerchantRow;
  backfill: { inserted: number; merchant_rules_removed: number };
}

/** `GET /api/sync/status` */
export interface SyncStatusResponse {
  chile: { ymd: string; hour: number; minute: number; monthKey: string };
  stale: SyncSourceId[];
  sources: SyncSourceStatusRow[];
  scheduler: SyncSchedulerStatus;
  /** ISO-ish timestamp from latest sync log row (`app_messages`, kind=log). */
  last_sync_at: string | null;
}
