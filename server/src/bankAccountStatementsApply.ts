import type { BankAccountStatement, BankAccountStatementsApplyDetails, BankAccountStatementsPayload } from "nw-tracker-contracts";
import {
  checkingAccountId,
  deleteCheckingCartolaImportsForSourceFile,
  finishCartolaImportRun,
  importCartolaList,
  prunePhantomBoundaryMonthCartolaImports,
  pruneStaleCartolaMonthImportsForSourceFile,
} from "./checkingCartolaImport.js";
import type { ParsedCheckingCartola } from "./checkingCartolaParse.js";
import type { CheckingCartolaFileImportLog } from "./checkingCartolaParseLog.js";
import { cartolaCalendarMonths, splitCuentaVistaCartolaByCalendarMonth } from "./cuentaVistaCartolaSplit.js";
import { cuentaVistaAccountId } from "./movementBalanceCashAccounts.js";

/**
 * A bank account's statements (`bank_account.statements`: cartolas the feeder read from the
 * monthly xlsx or PDF) → its ledger, as the cartola import has always done it
 * (`importCartolaList` + `finishCartolaImportRun`): a period not imported yet is imported, one
 * imported already only refreshes its printed balances or replaces an empty import, a phantom
 * boundary month is skipped, and the run re-derives the account's opening anchor.
 *
 * The cuenta vista prints periods that straddle calendar months, so each of its statements is
 * split by month (`splitCuentaVistaCartolaByCalendarMonth`) after the months its document no
 * longer covers are pruned.
 */

/** The import log names a PDF statement `pdf:<file>`, as the cartola import always has. */
function logLabel(document: string): string {
  return document.toLowerCase().endsWith(".pdf") ? `pdf:${document}` : document;
}

export function parsedCartolaFromStatement(statement: BankAccountStatement): ParsedCheckingCartola {
  return {
    source_file: statement.document,
    period_month: statement.period_month,
    period_from: statement.period_from,
    period_to: statement.period_to,
    saldo_inicial_clp: statement.opening_balance,
    saldo_final_clp: statement.closing_balance,
    month_saldo_final_clp: statement.month_closing_balances ?? undefined,
    movements: statement.movements.map((m) => ({
      occurred_on: m.date,
      amount_clp: m.amount,
      branch: m.branch,
      description: m.description,
      document_no: m.document_no,
    })),
    skipped: statement.skipped_rows,
    notes: statement.notes,
  };
}

export function bankStatementAccountId(account: BankAccountStatementsPayload["account"]): number {
  if (account.issuer !== "santander") throw new Error(`No bank account mapped for issuer ${account.issuer}`);
  return account.product === "checking" ? checkingAccountId() : cuentaVistaAccountId();
}

export function applyBankAccountStatements(payload: BankAccountStatementsPayload): BankAccountStatementsApplyDetails {
  const accountId = bankStatementAccountId(payload.account);
  const vista = payload.account.product === "demand_deposit";
  const dryRun = !payload.apply;
  const fileLogs: CheckingCartolaFileImportLog[] = [];
  if (!dryRun) prunePhantomBoundaryMonthCartolaImports(accountId);

  for (const u of payload.unreadable) {
    fileLogs.push({
      file: logLabel(u.document),
      period_month: "",
      status: "parse_error",
      movements_parsed: 0,
      movements_imported: 0,
      skipped_rows: [],
      saldo_final_clp: null,
      saldo_inicial_clp: null,
      error: u.error,
    });
  }

  const list: { cartola: ParsedCheckingCartola; label: string }[] = [];
  for (const statement of payload.statements) {
    const cartola = parsedCartolaFromStatement(statement);
    const label = logLabel(statement.document);
    if (!vista) {
      list.push({ cartola, label });
      continue;
    }
    if (!dryRun) pruneStaleCartolaMonthImportsForSourceFile(accountId, cartola.source_file, cartolaCalendarMonths(cartola));
    if (payload.force_reimport && !dryRun) {
      const cleared = deleteCheckingCartolaImportsForSourceFile(accountId, cartola.source_file);
      if (cleared.imports > 0 || cleared.movements > 0) {
        console.log(`  cleared prior import for ${cartola.source_file}: ${cleared.movements} movement(s), ${cleared.imports} registry row(s)`);
      }
    }
    for (const slice of splitCuentaVistaCartolaByCalendarMonth(cartola)) {
      list.push({ cartola: slice, label: `${label}|${slice.period_month}` });
    }
  }
  // The cuenta vista already cleared a re-imported document's months above.
  importCartolaList(accountId, list, { dryRun, forceReimport: vista ? false : payload.force_reimport }, fileLogs);
  const result = finishCartolaImportRun(accountId, { dryRun }, fileLogs, vista ? "cuenta vista" : undefined);

  const report = [
    `${vista ? "cuenta vista" : "checking"}: ${result.filesImported.length} file(s) imported, ` +
      `${result.filesSkipped.length} month(s) already in DB, ${result.errors.length} error(s)`,
    ...result.errors.map((e) => `  ${e.file}: ${e.error}`),
  ];
  return {
    account_id: accountId,
    applied: !dryRun,
    files: fileLogs.map((f) => ({
      file: f.file,
      period_month: f.period_month,
      status: f.status,
      movements_parsed: f.movements_parsed,
      movements_imported: f.movements_imported,
      error: f.error ?? null,
    })),
    report,
  };
}
