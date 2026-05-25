import {
  finishCartolaImportRun,
  importCartolaList,
  isCheckingCartolaMonthImported,
  type ImportCheckingCartolasResult,
  wipeCheckingAccountData,
} from "./checkingCartolaImport.js";
import { pdfEntryToParsedCartola } from "./checkingCartolaPdfImport.js";
import type { CheckingCartolaFileImportLog } from "./checkingCartolaParseLog.js";
import {
  loadCuentaVistaCartolasFromPdfJson,
  runParseCuentaVistaCartolaPdfs,
} from "./cuentaVistaCartolaPdfImport.js";
import { cuentaVistaAccountId } from "./movementBalanceCashAccounts.js";

export { cuentaVistaAccountId };

function logParseError(file: string, e: unknown): CheckingCartolaFileImportLog {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`  PARSE ERROR ${file}: ${msg}`);
  return {
    file,
    period_month: "",
    status: "parse_error",
    movements_parsed: 0,
    movements_imported: 0,
    skipped_rows: [],
    saldo_final_clp: null,
    saldo_inicial_clp: null,
    error: msg,
  };
}

/** Import cuenta vista cartolas from PDF JSON (runs parser unless `skipPdfParse`). */
export function importCuentaVistaCartolasFromPdfs(opts?: {
  accountId?: number;
  wipe?: boolean;
  dryRun?: boolean;
  skipPdfParse?: boolean;
  pdfsDir?: string;
}): ImportCheckingCartolasResult {
  const accountId = opts?.accountId ?? cuentaVistaAccountId();
  const fileLogs: CheckingCartolaFileImportLog[] = [];

  if (opts?.wipe && !opts?.dryRun) {
    const w = wipeCheckingAccountData(accountId);
    console.log(
      `Wiped cuenta vista (account ${accountId}): ${w.movements} movement(s), ${w.valuations} valuation(s), ${w.imports} import record(s).`
    );
  } else if (opts?.wipe && opts?.dryRun) {
    console.log(`[dry-run] Would wipe movements/valuations/imports for account ${accountId}.`);
  }

  try {
    if (!opts?.skipPdfParse) {
      if (opts?.pdfsDir) {
        process.env.CFRASER_CUENTA_VISTA_PDFS_DIR = opts.pdfsDir;
      }
      runParseCuentaVistaCartolaPdfs();
    }
    const pdfData = loadCuentaVistaCartolasFromPdfJson();
    const pdfCartolas: { cartola: ReturnType<typeof pdfEntryToParsedCartola>; label: string }[] =
      [];
    for (const entry of pdfData.cartolas) {
      const label = `pdf:${entry.source_file}`;
      if (entry.parse_status !== "ok") {
        fileLogs.push({
          file: label,
          period_month: entry.period_month ?? "",
          status: "parse_error",
          movements_parsed: entry.movements?.length ?? 0,
          movements_imported: 0,
          skipped_rows: entry.skipped ?? [],
          saldo_final_clp: entry.saldo_final_clp,
          saldo_inicial_clp: entry.saldo_inicial_clp,
          error: entry.parse_error ?? `PDF ${entry.parse_status}`,
        });
        continue;
      }
      try {
        pdfCartolas.push({ cartola: pdfEntryToParsedCartola(entry), label });
      } catch (e) {
        fileLogs.push(logParseError(label, e));
      }
    }
    importCartolaList(accountId, pdfCartolas, opts ?? {}, fileLogs);
  } catch (e) {
    fileLogs.push(logParseError("cuenta-vista-pdf", e));
  }

  return finishCartolaImportRun(accountId, opts ?? {}, fileLogs, "cuenta vista");
}

export function cuentaVistaCartolaMonthImported(
  periodMonth: string,
  accountId = cuentaVistaAccountId()
): boolean {
  return isCheckingCartolaMonthImported(accountId, periodMonth);
}
