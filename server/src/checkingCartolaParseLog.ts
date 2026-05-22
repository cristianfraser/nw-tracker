import { insertAppMessage } from "./appMessages.js";
import type {
  CartolaParseNote,
  CartolaSkippedRow,
  ParsedCheckingCartola,
} from "./checkingCartolaParse.js";

export type CheckingCartolaFileImportLog = {
  file: string;
  period_month: string;
  status: "imported" | "skipped_already_imported" | "parse_error" | "dry_run";
  movements_parsed: number;
  movements_imported: number;
  skipped_rows: CartolaSkippedRow[];
  parse_notes?: CartolaParseNote[];
  saldo_final_clp: number | null;
  saldo_inicial_clp: number | null;
  error?: string;
};

export type CheckingCartolaImportRunLog = {
  account_id: number;
  dry_run: boolean;
  wiped: boolean;
  files: CheckingCartolaFileImportLog[];
};

export function formatSkippedRow(s: CartolaSkippedRow): string {
  const parts: string[] = [`reason=${s.reason}`];
  if (s.sheet_row != null) parts.push(`row=${s.sheet_row}`);
  if (s.fecha) parts.push(`fecha=${s.fecha}`);
  if (s.document_no) parts.push(`doc=${s.document_no}`);
  if (s.amount_clp != null) parts.push(`amount=${s.amount_clp}`);
  if (s.description) parts.push(`desc=${s.description.slice(0, 60)}`);
  if (s.detail) parts.push(s.detail);
  return parts.join(" ");
}

export function formatCheckingCartolaImportLogBody(log: CheckingCartolaImportRunLog): string {
  const lines: string[] = [];
  lines.push(
    `Account ${log.account_id}${log.wiped ? " (wiped before import)" : ""}${log.dry_run ? " [dry-run]" : ""}.`
  );
  const imported = log.files.filter((f) => f.status === "imported");
  const errors = log.files.filter((f) => f.status === "parse_error");
  const skippedMonths = log.files.filter((f) => f.status === "skipped_already_imported");
  const totalMovements = imported.reduce((n, f) => n + f.movements_imported, 0);
  const totalParseSkips = log.files.reduce((n, f) => n + f.skipped_rows.length, 0);
  lines.push(
    `Imported ${imported.length} file(s), ${totalMovements} movement(s). ` +
      `Already imported: ${skippedMonths.length}. Errors: ${errors.length}. Parse skips: ${totalParseSkips}.`
  );

  for (const f of log.files) {
    if (f.status === "parse_error") {
      lines.push(`\nERROR ${f.file}: ${f.error ?? "unknown"}`);
      continue;
    }
    if (f.status !== "imported" && f.status !== "dry_run") continue;
    lines.push(
      `\n${f.file} (${f.period_month}): ${f.movements_imported} movement(s), ${f.skipped_rows.length} row(s) skipped in parse.`
    );
    for (const sk of f.skipped_rows) {
      lines.push(`  - ${formatSkippedRow(sk)}`);
    }
    for (const n of f.parse_notes ?? []) {
      lines.push(`  - note: row=${n.sheet_row} ${n.message}`);
    }
  }

  const dupSkips = log.files.flatMap((f) =>
    f.skipped_rows.filter((s) => s.reason === "duplicate_in_cartola")
  );
  if (dupSkips.length) {
    lines.push(`\nDuplicate-in-cartola skips (${dupSkips.length}):`);
    for (const sk of dupSkips) {
      lines.push(`  - ${formatSkippedRow(sk)}`);
    }
  }

  return lines.join("\n");
}

export function insertCheckingCartolaImportRunLog(log: CheckingCartolaImportRunLog): void {
  if (log.dry_run) return;
  const title = `Checking cartola import ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`;
  const body = formatCheckingCartolaImportLogBody(log);
  insertAppMessage("log", title, body);
}

export function logCheckingCartolaImportRun(log: CheckingCartolaImportRunLog): void {
  const prefix = log.dry_run ? "[dry-run] " : "";
  console.log(
    `${prefix}Checking cartola import (account ${log.account_id})${log.wiped ? " after wipe" : ""}.`
  );

  for (const f of log.files) {
    if (f.status === "parse_error") {
      console.error(`  ERROR ${f.file}: ${f.error ?? "unknown"}`);
      continue;
    }
    if (f.status === "skipped_already_imported") {
      console.log(
        `  SKIP (already imported) ${f.file} (${f.period_month}): ${f.movements_parsed} movement(s) in file, ` +
          `${f.skipped_rows.length} row(s) skipped in parse.`
      );
      for (const sk of f.skipped_rows) {
        console.log(`    skip: ${formatSkippedRow(sk)}`);
      }
      continue;
    }
    const tag = f.status === "dry_run" ? "WOULD IMPORT" : "IMPORTED";
    console.log(
      `  ${tag} ${f.file} (${f.period_month}): ${f.movements_imported} movement(s) imported, ` +
        `${f.movements_parsed} parsed, ${f.skipped_rows.length} row(s) skipped in parse, ` +
        `saldo cartola ref ${f.saldo_final_clp ?? "—"} CLP.`
    );
    for (const sk of f.skipped_rows) {
      console.log(`    skip: ${formatSkippedRow(sk)}`);
    }
    for (const n of f.parse_notes ?? []) {
      console.log(`    note: row=${n.sheet_row} ${n.message}`);
    }
  }

  const imported = log.files.filter((f) => f.status === "imported" || f.status === "dry_run");
  const errors = log.files.filter((f) => f.status === "parse_error");
  const skippedMonths = log.files.filter((f) => f.status === "skipped_already_imported");
  const totalSkippedRows = log.files.reduce((n, f) => n + f.skipped_rows.length, 0);
  console.log(
    `${prefix}Summary: ${imported.length} file(s) processed, ${skippedMonths.length} month(s) already imported, ` +
      `${errors.length} error(s), ${totalSkippedRows} parse skip(s) logged.`
  );
  insertCheckingCartolaImportRunLog(log);
}

export function fileLogFromCartola(
  file: string,
  cartola: ParsedCheckingCartola,
  opts: { status: CheckingCartolaFileImportLog["status"]; movements_imported?: number }
): CheckingCartolaFileImportLog {
  return {
    file,
    period_month: cartola.period_month,
    status: opts.status,
    movements_parsed: cartola.movements.length,
    movements_imported: opts.movements_imported ?? cartola.movements.length,
    skipped_rows: cartola.skipped,
    parse_notes: cartola.notes,
    saldo_final_clp: cartola.saldo_final_clp,
    saldo_inicial_clp: cartola.saldo_inicial_clp,
  };
}
