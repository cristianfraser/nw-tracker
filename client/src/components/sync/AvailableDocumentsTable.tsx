import { useState } from "react";
import { Link } from "react-router-dom";
import { apiHref } from "../../api";
import { formatMonthShortLabel } from "../../formatDateLabel";
import { useTranslation } from "../../i18n";
import type {
  ImportSyncDocumentAccount,
  ImportSyncDocumentCell,
  ImportSyncDocumentCellState,
  ImportSyncDocumentCoverageResponse,
  ImportSyncDocumentYear,
} from "../../types";
import { cn } from "../../cn";
import { OpenRow, OpenRows } from "../ui/OpenRows";
import {
  availableDocumentsColumnsHaveSplit,
  buildAvailableDocumentsColumns,
  type AvailableDocumentsColumn,
} from "./availableDocumentsColumns";
import { DocumentViewerModal, type DocumentViewerTarget } from "./DocumentViewerModal";
import { documentClickOpensViewer } from "./documentViewerOpen";
import styles from "./AvailableDocumentsTable.module.css";

type T = (key: string, opts?: Record<string, string | number>) => string;
/** Opens the viewer on a cell's document. */
type OpenDocument = (target: DocumentViewerTarget) => void;
/** Every state with a mark: before the column's first document and after a retired card's last there is none. */
type ShownState = Exclude<ImportSyncDocumentCellState, "before_first" | "after_last">;

const MARK_CLASS: Record<ShownState, string> = {
  imported: styles.markImported,
  imported_no_file: styles.markNoFile,
  no_movements: styles.markNoMovements,
  file_not_imported: styles.markFileOnly,
  missing: styles.markMissing,
  not_due: styles.markNotDue,
};

/** The legend, in the order a reader meets the marks. */
const LEGEND: [ShownState, string][] = [
  ["imported", "importSync.docs.legendImported"],
  ["imported_no_file", "importSync.docs.legendNoFile"],
  ["no_movements", "importSync.docs.legendNoMovements"],
  ["file_not_imported", "importSync.docs.legendFileOnly"],
  ["missing", "importSync.docs.legendMissing"],
  ["not_due", "importSync.docs.legendNotDue"],
];

function Mark({ state }: { state: ShownState }) {
  return <span className={cn(styles.mark, MARK_CLASS[state])} aria-hidden="true" />;
}

function currencySlotLabel(
  currency: "clp" | "usd", // convention-ok: the statement PDF corpus is filed in clp/ and usd/ folders per card
  t: T
): string {
  return currency === "clp" // convention-ok: the statement PDF corpus is filed in clp/ and usd/ folders per card
    ? t("importSync.ccStatementCurrencyClp")
    : t("importSync.ccStatementCurrencyUsd");
}

/** A column's name with its currency slot: «Card 1234 (USD)». */
function columnName(acc: ImportSyncDocumentAccount, t: T): string {
  return acc.cc_statement_currency != null ? `${acc.label} (${currencySlotLabel(acc.cc_statement_currency, t)})` : acc.label;
}

function cellLabel(state: ShownState, imported: boolean, account: string, month: string, t: T): string {
  switch (state) {
    case "imported":
      return t("importSync.importedYes", { account, month });
    case "imported_no_file":
      return t("importSync.importedUnlinked", { account, month });
    case "no_movements": {
      const noMovements = t("importSync.cartolaSinMovimientosOnFile", { account, month });
      return imported ? `${t("importSync.importedYes", { account, month })} — ${noMovements}` : noMovements;
    }
    case "file_not_imported":
      return t("importSync.docs.fileNotImported", { account, month });
    case "missing":
      return t("importSync.importedNo", { account, month });
    case "not_due":
      return t("importSync.docs.notDue", { account, month });
  }
}

function CoverageCell({
  acc,
  cell,
  month,
  className,
  onOpen,
  t,
}: {
  acc: ImportSyncDocumentAccount;
  cell: ImportSyncDocumentCell;
  month: string;
  className?: string;
  onOpen: OpenDocument;
  t: T;
}) {
  // Before the column's first document, or after the last one of a column that ends there, there
  // is nothing to have or to miss: an empty cell.
  if (cell.state === "before_first" || cell.state === "after_last") return <td className={cn(styles.cell, className)} />;
  const name = columnName(acc, t);
  const label = cellLabel(cell.state, cell.imported, name, month, t);
  const doc = cell.document;
  return (
    <td className={cn(styles.cell, className)}>
      {doc ? (
        // A link, so a modified or middle click opens the file in a tab; a plain click opens the viewer.
        <a
          href={apiHref(doc.view_href)}
          target="_blank"
          rel="noreferrer"
          className={styles.cellLink}
          title={`${doc.file_name}\n${label}`}
          aria-label={label}
          aria-haspopup="dialog"
          onClick={(e) => {
            if (!documentClickOpensViewer(e)) return;
            e.preventDefault();
            onOpen({ columnName: name, month, document: doc });
          }}
        >
          <Mark state={cell.state} />
        </a>
      ) : (
        <span className={styles.cellMark} title={label} role="img" aria-label={label}>
          <Mark state={cell.state} />
        </span>
      )}
    </td>
  );
}

function AccountHeaderLink({ accountId, label }: { accountId: number; label: string }) {
  return (
    <Link to={`/account/${accountId}`} className={styles.accountLink}>
      {label}
    </Link>
  );
}

function YearHeader({ columns, t }: { columns: AvailableDocumentsColumn[]; t: T }) {
  const split = availableDocumentsColumnsHaveSplit(columns);
  return (
    <thead>
      <tr>
        <th rowSpan={split ? 2 : 1} className={styles.monthCol}>
          <span className="visually-hidden">{t("importSync.colMonth")}</span>
        </th>
        {columns.map((col) =>
          col.type === "single" ? (
            <th key={`single-${col.accountIndex}`} rowSpan={split ? 2 : 1} className={styles.accountCol} scope="col">
              <AccountHeaderLink accountId={col.account.account_id} label={col.account.label} />
            </th>
          ) : (
            <th key={`split-${col.accountId}`} colSpan={2} className={styles.accountCol} scope="colgroup">
              <AccountHeaderLink accountId={col.accountId} label={col.label} />
            </th>
          )
        )}
      </tr>
      {split ? (
        <tr>
          {columns.flatMap((col) =>
            col.type !== "cc_split"
              ? []
              : [
                  <th key={`${col.accountId}-usd`} className={styles.slotCol} scope="col">
                    {t("importSync.ccStatementCurrencyUsd")}
                  </th>,
                  <th key={`${col.accountId}-clp`} className={styles.slotCol} scope="col">
                    {t("importSync.ccStatementCurrencyClp")}
                  </th>,
                ]
          )}
        </tr>
      ) : null}
    </thead>
  );
}

/** One year's months × columns: a mark per document. Narrow frames turn the column names upright. */
function YearMatrix({
  year,
  data,
  columns,
  onOpen,
  t,
}: {
  year: ImportSyncDocumentYear;
  data: ImportSyncDocumentCoverageResponse;
  columns: AvailableDocumentsColumn[];
  onOpen: OpenDocument;
  t: T;
}) {
  const { months, accounts, cells } = data;
  return (
    <table className={styles.matrix}>
      <YearHeader columns={columns} t={t} />
      <tbody>
        {year.month_indexes.map((monthIdx) => {
          const ym = months[monthIdx]!;
          const cellAt = (accountIndex: number, className?: string) => (
            <CoverageCell
              key={accountIndex}
              acc={accounts[accountIndex]!}
              cell={cells[monthIdx]![accountIndex]!}
              month={ym}
              className={className}
              onOpen={onOpen}
              t={t}
            />
          );
          return (
            <tr key={ym}>
              <th scope="row" className={styles.monthCol}>
                {formatMonthShortLabel(ym)}
              </th>
              {columns.map((col) => (col.type === "single" ? cellAt(col.accountIndex) : [cellAt(col.usdIndex), cellAt(col.clpIndex)]))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Which monthly documents (cartolas, card statements) are imported and on disk: one line per year
 * — how many columns have every month, and the incomplete ones by name — that opens into that
 * year's months. The server builds the years and decides each cell's state; a month before a
 * column's first document, or after the last one of a column that ends there (a retired card's),
 * is empty, the month in progress with no document yet reads «not due», and none is counted.
 */
export function AvailableDocumentsTable({
  data,
  loading,
}: {
  data: ImportSyncDocumentCoverageResponse | undefined;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  // One viewer for the whole matrix, open on the clicked cell's document.
  const [viewing, setViewing] = useState<DocumentViewerTarget | null>(null);
  const accounts = data?.accounts ?? [];
  const columns = buildAvailableDocumentsColumns(accounts);

  // The empty copy is for a loaded matrix with no accounts.
  if (data && accounts.length === 0) {
    return <p className="muted">{t("importSync.availableDocumentsEmpty")}</p>;
  }

  return (
    <div>
      <ul className={styles.legend}>
        {LEGEND.map(([state, key]) => (
          <li key={state}>
            <Mark state={state} /> {t(key)}
          </li>
        ))}
      </ul>
      <OpenRows loading={loading}>
        {(data?.years ?? []).map((year, i) => {
          const incomplete = year.incomplete_columns.map((col) => {
            const c = year.columns[col]!;
            return `${columnName(accounts[col]!, t)} ${c.imported}/${c.counted}`;
          });
          return (
            <OpenRow
              key={year.year}
              title={<span className={styles.year}>{year.year}</span>}
              status={
                <span className="muted">
                  {year.columns_counted === 0
                    ? t("importSync.docs.nothingDue")
                    : year.columns_complete === year.columns_counted
                      ? t("importSync.docs.allComplete", { n: year.columns_counted })
                      : t("importSync.docs.someComplete", { complete: year.columns_complete, n: year.columns_counted })}
                </span>
              }
              first={incomplete.length > 0 ? <span className={styles.incomplete}>{incomplete.join(" · ")}</span> : null}
              defaultOpen={i === 0}
            >
              {data ? (
                <YearMatrix
                  year={year}
                  data={data}
                  // A column with no document by this year (or none from it on, ending at its last) has nothing to show in it.
                  columns={columns.filter((col) =>
                    col.type === "single"
                      ? year.columns[col.accountIndex] != null
                      : year.columns[col.usdIndex] != null || year.columns[col.clpIndex] != null
                  )}
                  onOpen={setViewing}
                  t={t}
                />
              ) : null}
            </OpenRow>
          );
        })}
      </OpenRows>
      {viewing ? <DocumentViewerModal target={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}
