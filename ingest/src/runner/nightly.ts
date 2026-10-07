import type { SantanderFetchOutcome } from "nw-tracker-contracts";
import { npmRun, type StepRunner } from "./steps.js";

/**
 * The nightly bank run — `daily-run.sh`'s sequence, step for step (same labels, same commands,
 * same gates). The server decided that it runs now (22:00, or the first moment after a wake);
 * nothing here second-guesses that.
 */

export type NightlyOptions = {
  dryRun: boolean;
  /** NW_TRACKER_STATEMENT_JSON_APPLY=1: write the facturaciones no PDF owns. */
  statementJsonApply: boolean;
  /** NW_TRACKER_FULL_REIMPORT=1: the inbox pipeline's whole-corpus pass. */
  fullReimport: boolean;
  /** NW_TRACKER_FINTUAL_APPLY=1: Fintual mail movements and Acciones breakdowns write. */
  fintualApply: boolean;
  /** NW_TRACKER_RACIONAL_APPLY=1: Racional mail movements and the crawl import write. */
  racionalApply: boolean;
  /** The broker e-mail check named Racional (`cfraser/.broker-email-decision.json`). */
  racionalNeeded: () => boolean;
  /** The server's request to read AFP UNO's certificates tonight, and why; null = not tonight. */
  afpUnoFetch: { reason: string } | null;
  /** NW_TRACKER_AFP_UNO_APPLY=1: the certificates' missing rows are written. */
  afpUnoApply: boolean;
  /** The server's request to import the payslips tonight (reading the payroll portal first when
   *  `fetch`), and why; null = not tonight. */
  payslips: { fetch: boolean; reason: string } | null;
};

export type NightlyResult = { santander: SantanderFetchOutcome | null };

export async function runNightly(x: StepRunner, o: NightlyOptions): Promise<NightlyResult> {
  const dry = (label: string) => `${label} (dry run)`;
  let santander: SantanderFetchOutcome | null = null;

  // 1. Santander web session — daily movements (card + checking) plus the facturación JSON.
  if (o.dryRun) {
    x.note("=== (dry run) skipping fetch:santander");
  } else {
    const fetched = await x.step("fetch Santander", npmRun("fetch:santander", "--background"));
    santander = { mode: "nightly", outcome: fetched.ok ? "ok" : "failed", note: null };
  }

  // 1b–1e. Documents out of Gmail: Santander's monthly PDFs, Lider boletas, the BCI Lider
  // statement, Fintual's Acciones documents, Apple's receipts and subscription notices.
  // Ledger-keyed, so a no-op except when mail landed.
  for (const [label, script] of [
    ["Santander e-mail documents", "fetch:santander-docs"],
    ["Lider boletas", "fetch:lider-boletas"],
    ["Lider statement e-mail", "fetch:lider-statements"],
    ["Fintual Acciones documents", "fetch:fintual-docs"],
    ["Apple receipts e-mail", "fetch:apple-mail"],
  ] as const) {
    if (o.dryRun) await x.step(dry(label), npmRun(script, "--dry-run"));
    else await x.step(label, npmRun(script));
  }

  // 2. Inbox pipeline.
  if (o.dryRun) await x.step(dry("inbox pipeline"), npmRun("import:cfraser-inbox", "--dry-run"));
  else if (o.fullReimport) await x.step("inbox pipeline (full re-reconcile)", npmRun("import:cfraser-inbox", "--full"));
  else await x.step("inbox pipeline", npmRun("import:cfraser-inbox"));

  // 3. The card movements step 1 staged; 3b the second payment-mirror pass (a same-day payment's
  // card evidence only lands with the feed); 3c the bank's own cupo against the app's.
  if (o.dryRun) {
    await x.step(dry("Santander movements"), npmRun("import:santander-movements", "--dry-run"));
    await x.step(dry("Convert CC payment mirrors after card feed"), npmRun("convert:cc-payment-mirrors", "--dry-run"));
  } else {
    await x.step("Santander movements", npmRun("import:santander-movements"));
    await x.step("Convert CC payment mirrors after card feed", npmRun("convert:cc-payment-mirrors"));
    await x.step("CC bank cupo check", npmRun("check:cc-bank-cupo"));
  }

  // 3c'. Santander's transfer mails of the last weeks: who each checking transfer went to or came
  // from (the checking rows of the day are in by now; a later row pairs on a later night).
  if (o.dryRun) await x.step(dry("Santander transfer mails"), npmRun("import:santander-transfer-mails", "--dry-run"));
  else await x.step("Santander transfer mails", npmRun("import:santander-transfer-mails"));

  // 3c''. Payment processors' receipts (Flow, Pago Fácil): who a «PAGOS.FLOW.CL» / «PAGO FACIL»
  // charge actually paid. The card lines they pair with are in by now.
  if (o.dryRun) await x.step(dry("Payment receipt mails"), npmRun("import:payment-receipt-mails", "--dry-run"));
  else await x.step("Payment receipt mails", npmRun("import:payment-receipt-mails"));

  // 3d. Apple's mails, once the card lines they explain are in: which app each charge paid for.
  if (o.dryRun) await x.step(dry("Apple receipts"), npmRun("import:apple-mail", "--dry-run"));
  else await x.step("Apple receipts", npmRun("import:apple-mail"));

  // 4. Broker e-mail: the change detector, and the Fintual / Racional mail imports.
  if (o.dryRun) {
    await x.step(dry("broker e-mail check"), npmRun("check:broker-emails"));
    await x.step(dry("Fintual e-mail movements"), npmRun("import:fintual-emails"));
    await x.step(dry("Racional e-mail movements"), npmRun("import:racional-emails"));
  } else {
    await x.step("fetch broker e-mail", npmRun("fetch:emails"));
    await x.step("broker e-mail check", npmRun("check:broker-emails"));
    await applyOrReport(x, "Fintual e-mail movements", "import:fintual-emails", o.fintualApply);
    await applyOrReport(x, "Fintual Acciones dividend breakdowns", "import:fintual-acciones", o.fintualApply);
    await applyOrReport(x, "Racional e-mail movements", "import:racional-emails", o.racionalApply);
  }

  // 5. Racional, only when the e-mail check asked for it.
  if (o.dryRun) {
    await x.step(dry("Racional movements"), npmRun("import:racional-movements"));
  } else if (o.racionalNeeded()) {
    x.note("e-mail reported new Racional activity — fetching");
    await x.step("fetch Racional", npmRun("fetch:racional", "--background"));
    await applyOrReport(x, "Racional movements", "import:racional-movements", o.racionalApply);
  } else {
    x.note("=== Racional (skipped — no e-mail said anything moved)");
  }

  // 5b. AFP UNO, every night: the balance, and the certificates when its cuotas moved.
  if (o.afpUnoFetch == null) {
    x.note("=== AFP UNO (not tonight)");
  } else if (o.dryRun) {
    x.note(`=== (dry run) skipping fetch:afp-uno (${o.afpUnoFetch.reason})`);
  } else {
    x.note(`AFP UNO: ${o.afpUnoFetch.reason}`);
    if (o.afpUnoApply) await x.step("AFP UNO (apply)", npmRun("fetch:afp-uno", "--background", "--apply"));
    else await x.step("AFP UNO (report only)", npmRun("fetch:afp-uno", "--background"));
  }

  // 5c. Payslips, when the server asks: the portal from the 1st until last month's payslip is in,
  // the import alone while the newest one waits for its deposit (the cartola pairs it).
  if (o.payslips == null) {
    x.note("=== payslips (not tonight)");
  } else if (o.dryRun) {
    x.note(`=== (dry run) skipping payslips (${o.payslips.reason})`);
  } else {
    x.note(`payslips: ${o.payslips.reason}`);
    if (o.payslips.fetch) await x.step("fetch Buk payslips", npmRun("fetch:buk-payslips", "--background"));
    await x.step("parse payslips", npmRun("parse:payroll-liquidaciones"));
    // Not strict: an unpaired payslip is the normal state until the month's cartola arrives.
    await x.step("import payslips", npmRun("import:payroll-liquidaciones", "--no-strict"));
  }

  // 6. Statement JSON: cross-check, and (when enabled) write the facturaciones no PDF owns.
  if (o.dryRun || !o.statementJsonApply) {
    await x.step("Santander statements (report only)", npmRun("import:santander-statements"));
  } else {
    await x.step("Santander statements (apply)", npmRun("import:santander-statements", "--apply"));
  }

  return { santander };
}

/** `<label> (apply)` with `--apply`, or `<label> (report only)` — the shell runners' naming. */
export async function applyOrReport(x: StepRunner, label: string, script: string, apply: boolean): Promise<void> {
  if (apply) await x.step(`${label} (apply)`, npmRun(script, "--apply"));
  else await x.step(`${label} (report only)`, npmRun(script));
}
