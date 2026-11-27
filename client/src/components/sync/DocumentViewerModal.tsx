import { useState } from "react";
import { apiHref } from "../../api";
import { formatGroupedDecimalExact } from "../../format";
import { formatYearMonthLabel } from "../../formatDateLabel";
import { useTranslation } from "../../i18n";
import { useImportSyncSheetPreview } from "../../queries/hooks";
import { queryLoadError, queryShowsLoading } from "../../queries/pageShapeReady";
import type { ImportSyncDocumentRef, ImportSyncSheetPreviewResponse } from "../../types";
import { Loadable } from "../ui/Loadable";
import { Modal } from "../ui/Modal";
import styles from "./DocumentViewerModal.module.css";

/** The cell a viewer shows: its column's name, its month and the server's links to the file. */
export type DocumentViewerTarget = {
  columnName: string;
  month: string;
  document: ImportSyncDocumentRef;
};

type Sheet = ImportSyncSheetPreviewResponse["sheets"][number];

/**
 * A sheet's rows as plain cells. Bank workbooks open with banner and metadata lines, so no row is
 * taken for a header. A number cell is formatted at render in the user's separators, right-aligned;
 * a text cell (dates included, already `YYYY-MM-DD`) prints as it is. A row whose only content is
 * one text cell (a title, a notice line) runs over the empty cells after it, as a spreadsheet
 * draws it, and wraps there: it never sets a column's width.
 */
function SheetTable({ sheet }: { sheet: Sheet }) {
  const { t } = useTranslation();
  if (sheet.rows.length === 0) return <p className={`muted ${styles.note}`}>{t("importSync.viewer.sheetEmpty")}</p>;
  // Rows may differ in length: every row is drawn as wide as the widest.
  const width = sheet.rows.reduce((w, row) => Math.max(w, row.length), 0);
  return (
    <table className={styles.sheet}>
      <tbody>
        {sheet.rows.map((row, r) => {
          const filled = row.flatMap((cell, i) => (cell === "" ? [] : [i]));
          const only = filled.length === 1 ? filled[0] : null;
          const spill = only != null && typeof row[only] === "string" && only < width - 1 ? only : null;
          const end = spill == null ? width : spill + 1;
          return (
            <tr key={r}>
              {Array.from({ length: end }, (_, i) => {
                const cell = row[i] ?? "";
                if (i === spill) {
                  return (
                    <td key={i} colSpan={width - i}>
                      <div className={styles.spill}>{cell}</div>
                    </td>
                  );
                }
                return typeof cell === "number" ? (
                  <td key={i} className={styles.number}>
                    {formatGroupedDecimalExact(cell)}
                  </td>
                ) : (
                  <td key={i}>{cell}</td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** A workbook's sheets, fetched while the viewer is open; tabs only when there is more than one. */
function SheetPreview({ sheetHref }: { sheetHref: string }) {
  const { t } = useTranslation();
  const q = useImportSyncSheetPreview(sheetHref);
  const [shown, setShown] = useState(0);
  const loadError = queryLoadError(q);
  if (loadError) {
    return (
      <p className={`error ${styles.note}`} role="alert">
        {loadError instanceof Error ? loadError.message : t("common.loadFailed")}
      </p>
    );
  }
  // The server sends at least one sheet; before it answers there is none to draw.
  const sheets = q.data?.sheets ?? [];
  const sheet = sheets[shown];
  return (
    <Loadable loading={queryShowsLoading(q)} className={styles.sheetFrame}>
      {sheets.length > 1 ? (
        <div className={`surface-controls ${styles.tabs}`}>
          <span className="surface-controls__set" role="group" aria-label={t("importSync.viewer.sheetsLabel")}>
            {sheets.map((s, i) => (
              <button
                key={`${i}-${s.name}`}
                type="button"
                className={i === shown ? "is-on" : undefined}
                aria-pressed={i === shown}
                onClick={() => setShown(i)}
              >
                {s.name}
              </button>
            ))}
          </span>
        </div>
      ) : null}
      <div className={styles.sheetScroll}>{sheet ? <SheetTable sheet={sheet} /> : null}</div>
    </Loadable>
  );
}

/**
 * A month's source document in a tall dialog: a PDF in the browser's own viewer, a workbook as a
 * table of its cells. Download (and, for a PDF, a new tab) stay at hand below. Mounted only
 * while open, so neither the frame nor the sheet request outlives it.
 */
export function DocumentViewerModal({ target, onClose }: { target: DocumentViewerTarget; onClose: () => void }) {
  const { t } = useTranslation();
  const { document: doc } = target;
  return (
    <Modal
      open
      onClose={onClose}
      title={t("importSync.viewer.title", { account: target.columnName, month: formatYearMonthLabel(target.month) })}
      subtitle={doc.file_name}
      className={styles.dialog}
      bodyClassName={styles.body}
      closeAriaLabel={t("common.close")}
      footer={
        <div className={styles.actions}>
          {doc.preview_kind === "pdf" ? (
            <a
              href={apiHref(doc.view_href)}
              target="_blank"
              rel="noreferrer"
              className={`crfrsr-btn crfrsr-btn--secondary crfrsr-btn--sm ${styles.action}`}
            >
              {t("importSync.viewer.openInTab")}
            </a>
          ) : null}
          <a href={apiHref(doc.download_href)} download className={`crfrsr-btn crfrsr-btn--primary crfrsr-btn--sm ${styles.action}`}>
            {t("importSync.viewer.download")}
          </a>
        </div>
      }
    >
      {doc.preview_kind === "pdf" ? (
        <iframe className={styles.frame} src={apiHref(doc.view_href)} title={t("importSync.viewer.pdfFrameTitle", { file: doc.file_name })} />
      ) : (
        <SheetPreview sheetHref={doc.sheet_href} />
      )}
    </Modal>
  );
}
