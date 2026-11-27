/**
 * The inbox pipeline's two cartola steps (`pipelineMain.ts`): which documents they send, and how a
 * failure counts. An ordinary run sends the cartolas the organizer filed in this run plus the ones
 * still pending (`santander/cartolaPending.ts`: refused or unreadable before), each format by its
 * own list — an empty list sends none of that format, so a PDF arriving alone never sends the xlsx
 * history. `--checking` / `--cuenta-vista` send every document on disk (the explicit cross-check of
 * the history). A failing cartola step never stops the pipeline: the rest runs and the pipeline
 * exits non-zero at the end (`deferStepFailure`).
 */

export type CheckingCartolaStepInput = {
  force: boolean;
  skipCheckingPdf: boolean;
  skipPdfParse: boolean;
  dryRun: boolean;
  /** Xlsx basenames the organizer filed this run. */
  xlsxFiled: readonly string[];
  /** PDF basenames the organizer filed this run. */
  pdfFiled: readonly string[];
  /** Documents still pending (refused or unreadable before). */
  pending: readonly string[];
};

const isXlsx = (doc: string) => /\.xlsx$/i.test(doc);
const unique = (docs: readonly string[]) => [...new Set(docs)];

/** The arguments of `import:checking-cartolas` for this run, or null when there is nothing to send. */
export function checkingCartolaStepArgs(o: CheckingCartolaStepInput): string[] | null {
  const args = ["run", "import:checking-cartolas", "-w", "nw-tracker-ingest", "--"];
  if (o.force) {
    if (o.skipCheckingPdf) args.push("--xlsx-only");
  } else {
    const xlsx = unique([...o.xlsxFiled, ...o.pending.filter(isXlsx)]);
    const pdf = o.skipCheckingPdf ? [] : unique([...o.pdfFiled, ...o.pending.filter((d) => !isXlsx(d))]);
    if (xlsx.length === 0 && pdf.length === 0) return null;
    args.push(`--only-xlsx=${xlsx.join(",")}`);
    if (pdf.length > 0) args.push(`--only-pdf=${pdf.join(",")}`);
    else args.push("--xlsx-only");
  }
  if (o.skipPdfParse) args.push("--skip-pdf-parse");
  if (o.dryRun) args.push("--dry-run");
  return args;
}

export type CuentaVistaCartolaStepInput = {
  force: boolean;
  skipPdfParse: boolean;
  dryRun: boolean;
  pdfFiled: readonly string[];
  pending: readonly string[];
};

/** The arguments of `import:cuenta-vista-cartolas` for this run, or null when there is nothing to send. */
export function cuentaVistaCartolaStepArgs(o: CuentaVistaCartolaStepInput): string[] | null {
  const args = ["run", "import:cuenta-vista-cartolas", "-w", "nw-tracker-ingest", "--"];
  if (!o.force) {
    const pdf = unique([...o.pdfFiled, ...o.pending]);
    if (pdf.length === 0) return null;
    args.push(`--only-pdf=${pdf.join(",")}`);
  }
  if (o.skipPdfParse) args.push("--skip-pdf-parse");
  if (o.dryRun) args.push("--dry-run");
  return args;
}

/** A step whose failure is reported at the end, not by stopping the pipeline: the first non-zero code is kept. */
export function deferStepFailure(deferred: number, code: number): number {
  return deferred !== 0 ? deferred : code;
}
