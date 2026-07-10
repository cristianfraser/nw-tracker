import { Link } from "react-router-dom";
import { formatYearMonthLabel } from "../../formatDateLabel";
import { useTranslation } from "../../i18n";
import { absolutePathToFileUrl } from "../../localFileUrl";
import type {
  ImportSyncDocumentAccount,
  ImportSyncDocumentCell,
  ImportSyncDocumentCoverageResponse,
} from "../../types";
import { Table } from "../ui/Table";
import {
  availableDocumentsColumnsHaveSplit,
  buildAvailableDocumentsColumns,
  type AvailableDocumentsColumn,
} from "./availableDocumentsColumns";
import styles from "./AvailableDocumentsTable.module.css";

function currencySlotLabel(
  currency: "clp" | "usd",
  t: (key: string) => string
): string {
  return currency === "clp"
    ? t("importSync.ccStatementCurrencyClp")
    : t("importSync.ccStatementCurrencyUsd");
}

function columnAriaAccount(
  acc: ImportSyncDocumentAccount,
  t: (key: string) => string
): string {
  const slot =
    acc.cc_statement_currency != null
      ? currencySlotLabel(acc.cc_statement_currency, t)
      : "";
  return slot ? `${acc.label} (${slot})` : acc.label;
}

function CoverageCell({
  acc,
  cell,
  month,
  className,
  t,
}: {
  acc: ImportSyncDocumentAccount;
  cell: ImportSyncDocumentCell | undefined;
  month: string;
  className?: string;
  t: (key: string, opts?: Record<string, string>) => string;
}) {
  const imported = cell?.imported === true;
  const filePath = cell?.file_path ?? null;
  const hasFile = Boolean(filePath);
  const sinMovimientos = cell?.file_sin_movimientos === true;
  const ariaAccount = columnAriaAccount(acc, t);
  const sinMovTitle = t("importSync.cartolaSinMovimientosOnFile", {
    account: ariaAccount,
    month,
  });
  const ariaLabel = imported
    ? hasFile
      ? sinMovimientos
        ? `${t("importSync.importedYes", { account: ariaAccount, month })} — ${sinMovTitle}`
        : t("importSync.importedYes", { account: ariaAccount, month })
      : t("importSync.importedUnlinked", { account: ariaAccount, month })
    : hasFile && sinMovimientos
      ? sinMovTitle
      : t("importSync.importedNo", { account: ariaAccount, month });

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
  const sinMovMark = (
    <span className={styles.sinMovimientos} aria-hidden title={sinMovTitle}>
      ○
    </span>
  );

  const marks = (
    <>
      {imported ? checkMark : null}
      {sinMovimientos ? sinMovMark : null}
      {!imported ? crossMark : null}
      {imported && !hasFile ? crossMark : null}
    </>
  );

  return (
    <td className={className ?? styles.cell}>
      {hasFile ? (
        <a
          href={absolutePathToFileUrl(filePath!)}
          className={styles.cellLink}
          title={sinMovimientos ? `${filePath!}\n${sinMovTitle}` : filePath!}
          aria-label={ariaLabel}
        >
          {marks}
        </a>
      ) : (
        <span
          className={imported ? styles.cellDual : styles.cellMissing}
          aria-label={ariaLabel}
        >
          {marks}
        </span>
      )}
    </td>
  );
}

function DocumentsTableHeader({
  columns,
  t,
}: {
  columns: AvailableDocumentsColumn[];
  t: (key: string) => string;
}) {
  const splitLayout = availableDocumentsColumnsHaveSplit(columns);

  if (!splitLayout) {
    return (
      <thead>
        <tr>
          <th>{t("importSync.colMonth")}</th>
          {columns.map((col) => {
            if (col.type !== "single") return null;
            return (
              <th key={col.account.account_id} className={styles.accountCol}>
                <AccountHeaderLink account={col.account} />
              </th>
            );
          })}
        </tr>
      </thead>
    );
  }

  return (
    <thead>
      <tr>
        <th rowSpan={2} className={styles.monthCol}>
          {t("importSync.colMonth")}
        </th>
        {columns.map((col) => {
          if (col.type === "single") {
            return (
              <th key={col.account.account_id} rowSpan={2} className={styles.accountCol}>
                <AccountHeaderLink account={col.account} />
              </th>
            );
          }
          return (
            <th
              key={`split-${col.accountId}`}
              colSpan={2}
              className={styles.groupAccountCol}
              scope="colgroup"
            >
              <AccountHeaderLink accountId={col.accountId} label={col.label} />
            </th>
          );
        })}
      </tr>
      <tr>
        {columns.flatMap((col) => {
          if (col.type !== "cc_split") return [];
          return [
            <th
              key={`${col.accountId}-usd`}
              className={`${styles.slotCol} ${styles.slotColUsd}`}
              scope="col"
            >
              {t("importSync.ccStatementCurrencyUsd")}
            </th>,
            <th
              key={`${col.accountId}-clp`}
              className={`${styles.slotCol} ${styles.slotColClp}`}
              scope="col"
            >
              {t("importSync.ccStatementCurrencyClp")}
            </th>,
          ];
        })}
      </tr>
    </thead>
  );
}

function AccountHeaderLink({
  account,
  accountId,
  label,
}: {
  account?: ImportSyncDocumentAccount;
  accountId?: number;
  label?: string;
}) {
  const id = account?.account_id ?? accountId;
  const name = account?.label ?? label ?? "";
  if (id == null) return <span>{name}</span>;
  return (
    <Link to={`/account/${id}`} className={styles.accountLink}>
      {name}
    </Link>
  );
}

export function AvailableDocumentsTable({
  data,
}: {
  data: ImportSyncDocumentCoverageResponse;
}) {
  const { t } = useTranslation();
  const { months, accounts, cells } = data;
  const columns = buildAvailableDocumentsColumns(accounts);

  if (accounts.length === 0) {
    return <p className="muted">{t("importSync.availableDocumentsEmpty")}</p>;
  }

  return (
    <Table
      tableClassName={styles.matrixTable}
      wrapStyle={{ marginTop: "0.5rem" }}
      header={<DocumentsTableHeader columns={columns} t={t} />}
    >
      {months.map((ym, monthIdx) => (
        <tr key={ym}>
          <td className={`mono ${styles.monthCol}`}>{formatYearMonthLabel(ym)}</td>
          {columns.map((col) => {
            if (col.type === "single") {
              const acc = col.account;
              const cell = cells[monthIdx]?.[col.accountIndex];
              return (
                <CoverageCell
                  key={String(acc.account_id)}
                  acc={acc}
                  cell={cell}
                  month={ym}
                  t={t}
                />
              );
            }
            const usdAcc = accounts[col.usdIndex]!;
            const clpAcc = accounts[col.clpIndex]!;
            return (
              <SplitCurrencyCells
                key={`split-${col.accountId}`}
                month={ym}
                usdAcc={usdAcc}
                clpAcc={clpAcc}
                usdCell={cells[monthIdx]?.[col.usdIndex]}
                clpCell={cells[monthIdx]?.[col.clpIndex]}
                t={t}
              />
            );
          })}
        </tr>
      ))}
    </Table>
  );
}

function SplitCurrencyCells({
  month,
  usdAcc,
  clpAcc,
  usdCell,
  clpCell,
  t,
}: {
  month: string;
  usdAcc: ImportSyncDocumentAccount;
  clpAcc: ImportSyncDocumentAccount;
  usdCell: ImportSyncDocumentCell | undefined;
  clpCell: ImportSyncDocumentCell | undefined;
  t: (key: string, opts?: Record<string, string>) => string;
}) {
  return (
    <>
      <CoverageCell
        acc={usdAcc}
        cell={usdCell}
        month={month}
        className={`${styles.cell} ${styles.splitCell} ${styles.slotColUsd}`}
        t={t}
      />
      <CoverageCell
        acc={clpAcc}
        cell={clpCell}
        month={month}
        className={`${styles.cell} ${styles.splitCell} ${styles.slotColClp}`}
        t={t}
      />
    </>
  );
}
