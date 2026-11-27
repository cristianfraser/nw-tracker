// A replaced month read in other text carries its categories and names (registers the hook).
import "./checkingRestatementCarry.js";
import { describeRestatementCarry, restatementCarryIsEmpty } from "./checkingRestatementHook.js";
import type { BankAccountStatement, BankAccountStatementsApplyDetails, BankAccountStatementsPayload } from "nw-tracker-contracts";
import {
  checkingAccountId,
  finishCartolaImportRun,
  importCartolaList,
  prunePhantomBoundaryMonthCartolaImports,
  pruneStaleCartolaMonthImportsForSourceFile,
} from "./checkingCartolaImport.js";
import type { ParsedCheckingCartola } from "./checkingCartolaParse.js";
import type { CheckingCartolaFileImportLog } from "./checkingCartolaParseLog.js";
import { cartolaCalendarMonths, splitCuentaVistaCartolaByCalendarMonth } from "./cuentaVistaCartolaSplit.js";
import { cuentaVistaAccountId } from "./movementBalanceCashAccounts.js";
import type { ImportFlowItem, SkippedImportFlowItem } from "./checkingPartialMovementsImport.js";
import { movementWrite } from "./movementWrites.js";

/**
 * A bank account's statements (`bank_account.statements`: cartolas the feeder read from the
 * monthly xlsx or PDF) → its ledger (`importCartolaList` + `finishCartolaImportRun`): a period not
 * imported yet is imported when the ledger agrees with its printed balances
 * (`checkingCartolaLedgerGuard.ts`), one imported already only refreshes its printed balances, is
 * cross-checked by a second document covering the whole month (`checkingCartolaCrossCheck.ts`) or
 * is replaced by a fuller partial one, a phantom boundary month is skipped, and the anchor stays
 * pinned. Each statement is applied in its own savepoint: a refused one writes nothing and is
 * reported (`refused`, its `problems`) while the others import.
 *
 * The cuenta vista prints periods that straddle calendar months, so each of its statements is
 * split by month (`splitCuentaVistaCartolaByCalendarMonth`) after the months its document no
 * longer covers are pruned. A month imported again (forced, or from a fuller cartola) is restated
 * in place (`importCheckingCartola`): its rows keep their ids and flows.
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

/**
 * The one apply path of a bank account's cartolas — the ingest kind and both account-page uploads
 * (`accountImports.ts`) — inside one movement write (the expense deposit links re-sync once).
 * `flows` collects the rows each imported cartola wrote or skipped, for an upload's result view.
 */
export function applyBankAccountStatements(
  payload: BankAccountStatementsPayload,
  flows?: { inserted: ImportFlowItem[]; skipped: SkippedImportFlowItem[] }
): BankAccountStatementsApplyDetails {
  return movementWrite(() => applyStatements(payload, flows));
}

function applyStatements(
  payload: BankAccountStatementsPayload,
  flows?: { inserted: ImportFlowItem[]; skipped: SkippedImportFlowItem[] }
): BankAccountStatementsApplyDetails {
  const accountId = bankStatementAccountId(payload.account);
  const vista = payload.account.product === "demand_deposit";
  const fileLogs: CheckingCartolaFileImportLog[] = [];
  prunePhantomBoundaryMonthCartolaImports(accountId);

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
    pruneStaleCartolaMonthImportsForSourceFile(accountId, cartola.source_file, cartolaCalendarMonths(cartola));
    for (const slice of splitCuentaVistaCartolaByCalendarMonth(cartola)) {
      list.push({ cartola: slice, label: `${label}|${slice.period_month}` });
    }
  }
  // A forced re-import imports each month again in place (its rows restated); a cuenta vista
  // document forces only the months it owns (a straddle slice of a month another document holds
  // stays that document's). A dry run is the ingest receiver's rollback.
  importCartolaList(accountId, list, { dryRun: false, forceReimport: payload.force_reimport, forceSameFileOnly: vista }, fileLogs, flows);
  const result = finishCartolaImportRun(accountId, { dryRun: false }, fileLogs, vista ? "cuenta vista" : undefined);

  const refused = fileLogs.filter((f) => f.status === "refused");
  const confirmed = fileLogs.filter((f) => f.status === "confirmed");
  const report = [
    `${vista ? "cuenta vista" : "checking"}: ${result.filesImported.length} file(s) imported, ` +
      `${result.filesSkipped.length} month(s) already in DB, ${confirmed.length} confirmed by a second document, ` +
      `${refused.length} refused, ${result.errors.length} error(s)`,
    ...result.errors.map((e) => `  ${e.file}: ${e.error}`),
    ...refused.flatMap((f) => [`  REFUSED ${f.file} (${f.period_month}), nothing written:`, ...(f.problems ?? []).map((p) => `    ${p}`)]),
    // A month imported again in place whose rows read in other text: what the carry kept.
    ...fileLogs.flatMap((f) =>
      f.restatement_carry && !restatementCarryIsEmpty(f.restatement_carry)
        ? [`  ${f.file} (${f.period_month}) read in other text:`, ...describeRestatementCarry(f.restatement_carry).map((l) => `  ${l}`)]
        : []
    ),
  ];
  return {
    account_id: accountId,
    files: fileLogs.map((f) => ({
      file: f.file,
      period_month: f.period_month,
      status: f.status,
      movements_parsed: f.movements_parsed,
      movements_imported: f.movements_imported,
      error: f.error ?? null,
      problems: f.problems ?? [],
    })),
    report,
  };
}
