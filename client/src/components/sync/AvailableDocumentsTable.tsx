import { Link } from "react-router-dom";
import { formatMonthLabelFromYm } from "../../formatMonthLabel";
import { useTranslation } from "../../i18n";
import { absolutePathToFileUrl } from "../../localFileUrl";
import type {
  ImportSyncDocumentAccount,
  ImportSyncDocumentCoverageResponse,
} from "../../types";
import { Table } from "../ui/Table";
import styles from "./AvailableDocumentsTable.module.css";

function columnKey(acc: ImportSyncDocumentAccount): string {
  return acc.cc_statement_currency
    ? `${acc.account_id}-${acc.cc_statement_currency}`
    : String(acc.account_id);
}

function currencySlotLabel(
  acc: ImportSyncDocumentAccount,
  t: (key: string) => string
): string {
  if (acc.cc_statement_currency === "clp") {
    return t("importSync.ccStatementCurrencyClp");
  }
  if (acc.cc_statement_currency === "usd") {
    return t("importSync.ccStatementCurrencyUsd");
  }
  return "";
}

function columnAriaAccount(
  acc: ImportSyncDocumentAccount,
  t: (key: string) => string
): string {
  const slot = currencySlotLabel(acc, t);
  return slot ? `${acc.label} (${slot})` : acc.label;
}

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
            {accounts.map((acc) => {
              const slot = currencySlotLabel(acc, t);
              return (
                <th
                  key={columnKey(acc)}
                  className={slot ? styles.splitAccountCol : styles.accountCol}
                  title={columnAriaAccount(acc, t)}
                >
                  <Link
                    to={`/account/${acc.account_id}`}
                    className={styles.accountLink}
                  >
                    {acc.label}
                  </Link>
                  {slot ? (
                    <span className={styles.currencySlot}>{slot}</span>
                  ) : null}
                </th>
              );
            })}
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
            const hasFile = Boolean(filePath);
            const ariaAccount = columnAriaAccount(acc, t);
            const ariaLabel = imported
              ? hasFile
                ? t("importSync.importedYes", { account: ariaAccount, month: ym })
                : t("importSync.importedUnlinked", {
                    account: ariaAccount,
                    month: ym,
                  })
              : t("importSync.importedNo", { account: ariaAccount, month: ym });
            const checkMark = (
              <span className={styles.ok} aria-hidden>
                ✓
              </span>
            );
            const crossMark = (
              <span className={styles.missing} aria-hidden>
                ✗
              </span>
            );
            return (
              <td key={columnKey(acc)} className={styles.cell}>
                {imported && hasFile ? (
                  <a
                    href={absolutePathToFileUrl(filePath!)}
                    className={styles.cellLink}
                    title={filePath!}
                    aria-label={ariaLabel}
                  >
                    {checkMark}
                  </a>
                ) : imported ? (
                  <span className={styles.cellDual} aria-label={ariaLabel}>
                    {checkMark}
                    {crossMark}
                  </span>
                ) : (
                  <span className={styles.cellMissing} aria-label={ariaLabel}>
                    {crossMark}
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
