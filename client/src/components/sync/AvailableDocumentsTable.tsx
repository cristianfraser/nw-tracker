import { Link } from "react-router-dom";
import { formatMonthLabelFromYm } from "../../formatMonthLabel";
import { useTranslation } from "../../i18n";
import { absolutePathToFileUrl } from "../../localFileUrl";
import type { ImportSyncDocumentCoverageResponse } from "../../types";
import { Table } from "../ui/Table";
import styles from "./AvailableDocumentsTable.module.css";

export function AvailableDocumentsTable({
  data,
}: {
  data: ImportSyncDocumentCoverageResponse;
}) {
  const { t } = useTranslation();
  const { months, accounts, cells } = data;

  if (accounts.length === 0) {
    return <p className="muted">{t("importSync.availableDocumentsEmpty")}</p>;
  }

  return (
    <Table
      tableClassName={styles.matrixTable}
      wrapStyle={{ marginTop: "0.5rem" }}
      header={
        <thead>
          <tr>
            <th>{t("importSync.colMonth")}</th>
            {accounts.map((acc) => (
              <th key={acc.account_id} className={styles.accountCol} title={acc.label}>
                <Link to={`/account/${acc.account_id}`} className={styles.accountLink}>
                  {acc.label}
                </Link>
              </th>
            ))}
          </tr>
        </thead>
      }
    >
      {months.map((ym, monthIdx) => (
        <tr key={ym}>
          <td className="mono">{formatMonthLabelFromYm(ym)}</td>
          {accounts.map((acc, accIdx) => {
            const cell = cells[monthIdx]?.[accIdx];
            const imported = cell?.imported === true;
            const filePath = cell?.file_path ?? null;
            const ariaLabel = imported
              ? t("importSync.importedYes", { account: acc.label, month: ym })
              : t("importSync.importedNo", { account: acc.label, month: ym });
            const mark = imported ? "✓" : "✗";
            return (
              <td key={acc.account_id} className={styles.cell}>
                {imported && filePath ? (
                  <a
                    href={absolutePathToFileUrl(filePath)}
                    className={styles.ok}
                    title={filePath}
                    aria-label={ariaLabel}
                  >
                    {mark}
                  </a>
                ) : (
                  <span
                    className={imported ? styles.ok : styles.missing}
                    aria-label={ariaLabel}
                  >
                    {mark}
                  </span>
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </Table>
  );
}
