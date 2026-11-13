import type { IngestRunRequest, LiderFetchOutcome, SantanderFetchOutcome } from "nw-tracker-contracts";
import { runLiderFetchAndImport } from "./liderState.js";
import { ingest, serverTask, type StepOutcome, type StepRunner } from "./steps.js";

/**
 * The nightly bank run. The server decided that it runs now (22:00, or the first moment after a
 * wake); nothing here second-guesses that. Gates read the steps' results (`StepResult`): the AFC
 * cartola mails staged, the broker mail naming Racional.
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
  /** The server's request to read AFP UNO's certificates tonight, and why; null = not tonight. */
  afpUnoFetch: { reason: string } | null;
  /** NW_TRACKER_AFP_UNO_APPLY=1: the certificates' missing rows are written. */
  afpUnoApply: boolean;
  /**
   * The server's request to read the AFC (balance + certificate) tonight, and why; null = not
   * tonight — unless a cartola mail was staged this run, which is read whatever the server said.
   * `expected_period`: the payroll month whose contribution the read looks for; `overdue` fails
   * the step when the certificate still lacks it.
   */
  afcFetch: { reason: string; expected_period?: string | null; overdue?: boolean } | null;
  /** NW_TRACKER_AFC_APPLY=1: the certificate's missing contributions and the cartolas' true-ups are written. */
  afcApply: boolean;
  /** The server's request to import the payslips tonight (reading the payroll portal first when
   *  `fetch`), and why; null = not tonight. */
  payslips: { fetch: boolean; reason: string } | null;
  /** The server's request to read MetLife's portal tonight (`quote` | `posted`), or null. */
  metlifeRead: IngestRunRequest["metlife_read"];
};

export type NightlyResult = { santander: SantanderFetchOutcome | null; lider: LiderFetchOutcome | null };

export async function runNightly(x: StepRunner, o: NightlyOptions): Promise<NightlyResult> {
  const dry = (label: string) => `${label} (dry run)`;
  let santander: SantanderFetchOutcome | null = null;
  let afcCartolasSaved = 0;

  // 1. Santander web session — daily movements (card + checking) plus the facturación JSON.
  if (o.dryRun) {
    x.note("=== (dry run) skipping fetch:santander");
  } else {
    const fetched = await x.step("fetch Santander", ingest("fetch:santander"));
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
    ["AFC cartolas e-mail", "fetch:afc-cartolas"],
  ] as const) {
    if (o.dryRun) await x.step(dry(label), ingest(script, "--dry-run"));
    else {
      const r = await x.step(label, ingest(script));
      if (script === "fetch:afc-cartolas") afcCartolasSaved = r.result.staged ?? 0;
    }
  }

  // 2. Inbox pipeline.
  if (o.dryRun) await x.step(dry("inbox pipeline"), ingest("import:cfraser-inbox", "--dry-run"));
  else if (o.fullReimport) await x.step("inbox pipeline (full re-reconcile)", ingest("import:cfraser-inbox", "--full"));
  else await x.step("inbox pipeline", ingest("import:cfraser-inbox"));

  // 3. The card movements step 1 staged; 3a Lider BCI's card listing (its own session, fetched and
  // imported here); 3b the second payment-mirror pass (a same-day payment's card evidence only
  // lands with the feeds); 3c the banks' own cupos against the app's.
  let lider: LiderFetchOutcome | null = null;
  if (o.dryRun) {
    await x.step(dry("Santander movements"), ingest("import:santander-movements", "--dry-run"));
    await x.step(dry("Santander USD movements"), ingest("import:checking-usd-movements", "--dry-run"));
    await runLiderFetchAndImport(x, "nightly", { dryRun: true });
    await x.step(dry("Convert CC payment mirrors after card feed"), serverTask("cc_payment_mirrors", "--dry-run"));
  } else {
    await x.step("Santander movements", ingest("import:santander-movements"));
    // The dollar account's capture from the same session: confirms its ledger rows, inserts nothing.
    await x.step("Santander USD movements", ingest("import:checking-usd-movements"));
    lider = (await runLiderFetchAndImport(x, "nightly", { dryRun: false })).outcome;
    await x.step("Convert CC payment mirrors after card feed", serverTask("cc_payment_mirrors"));
    await x.step("CC bank cupo check", serverTask("cc_bank_cupo_check"));
    // The mortgage cuota in the ledger against the card line that paid it (the feed just
    // imported): either side waiting past its deadline fails.
    await x.step("Mortgage card match check", serverTask("mortgage_card_match_check"));
  }

  // 3c'. Santander's transfer mails of the last weeks: who each checking transfer went to or came
  // from (the checking rows of the day are in by now; a later row pairs on a later night).
  if (o.dryRun) await x.step(dry("Transfer mails"), ingest("import:transfer-mails", "--dry-run"));
  else await x.step("Transfer mails", ingest("import:transfer-mails"));

  // 3c''. Payment processors' receipts (Flow, Pago Fácil): who a «PAGOS.FLOW.CL» / «PAGO FACIL»
  // charge actually paid. The card lines they pair with are in by now.
  if (o.dryRun) await x.step(dry("Payment receipt mails"), ingest("import:payment-receipt-mails", "--dry-run"));
  else await x.step("Payment receipt mails", ingest("import:payment-receipt-mails"));

  // 3c'''. Utility bills (ENEL, Metrogas): each becomes its place's bill row once the card or
  // checking charge that paid it is in (imported above), with the consumption it states.
  if (o.dryRun) await x.step(dry("Utility bill mails"), ingest("import:utility-bills", "--dry-run"));
  else await x.step("Utility bill mails", ingest("import:utility-bills"));

  // 3c''''. MetLife's receipts for cuotas paid online: the cuota's charge on the card that paid it.
  if (o.dryRun) await x.step(dry("MetLife receipts"), ingest("import:metlife-receipts", "--dry-run"));
  else await x.step("MetLife receipts", ingest("import:metlife-receipts"));
  // When the server asks: MetLife's portal (the cuota quoted, or the cuota a receipt says was paid).
  await runMetlifeRead(x, o.metlifeRead, o.dryRun);

  // 3d. Apple's mails, once the card lines they explain are in: which app each charge paid for.
  if (o.dryRun) await x.step(dry("Apple receipts"), ingest("import:apple-mail", "--dry-run"));
  else await x.step("Apple receipts", ingest("import:apple-mail"));

  // 4. Broker e-mail: the change detector, and the Fintual / Racional mail imports.
  let racionalNeeded = false;
  if (o.dryRun) {
    await x.step(dry("broker e-mail check"), ingest("check:broker-emails"));
    await x.step(dry("Fintual e-mail movements"), ingest("import:fintual-emails"));
    await x.step(dry("Racional e-mail movements"), ingest("import:racional-emails"));
  } else {
    await x.step("fetch broker e-mail", ingest("fetch:emails"));
    await x.step("broker e-mail check", ingest("check:broker-emails"));
    await applyOrReport(x, "Fintual e-mail movements", "import:fintual-emails", o.fintualApply);
    await applyOrReport(x, "Fintual Acciones dividend breakdowns", "import:fintual-acciones", o.fintualApply);
    await applyOrReport(x, "Fintual wallet interest", "import:fintual-wallet", o.fintualApply);
    const racionalMail = await applyOrReport(x, "Racional e-mail movements", "import:racional-emails", o.racionalApply);
    racionalNeeded = racionalMail.result.read_brokers?.includes("racional") ?? false;
  }

  // 5. Racional, only when the broker mail asked for it.
  if (o.dryRun) {
    await x.step(dry("Racional movements"), ingest("import:racional-movements"));
  } else if (racionalNeeded) {
    x.note("e-mail reported new Racional activity — fetching");
    await x.step("fetch Racional", ingest("fetch:racional"));
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
    if (o.afpUnoApply) await x.step("AFP UNO (apply)", ingest("fetch:afp-uno", "--apply"));
    else await x.step("AFP UNO (report only)", ingest("fetch:afp-uno"));
  }

  // 5b′. The AFC, when the server expects a contribution (from the 14th after a payroll month
  // until it is in the ledger) or a cartola mail was staged tonight: the stated balance (report
  // only) and the certificate of paid contributions, sent with the staged cartolas; a new
  // contribution is written at its pay date, a cartola's true-up at its saldo day.
  const afcFetch = o.afcFetch ?? (afcCartolasSaved > 0 ? { reason: `${afcCartolasSaved} cartola mail(s) staged tonight` } : null);
  if (afcFetch == null) {
    x.note("=== AFC (not tonight)");
  } else if (o.dryRun) {
    x.note(`=== (dry run) skipping fetch:afc (${afcFetch.reason})`);
  } else {
    x.note(`AFC: ${afcFetch.reason}`);
    const args = [...(o.afcApply ? ["--apply"] : [])];
    if (afcFetch.expected_period) args.push(`--expect=${afcFetch.expected_period}`);
    if (afcFetch.overdue) args.push("--overdue");
    await x.step(o.afcApply ? "AFC (apply)" : "AFC (report only)", ingest("fetch:afc", ...args));
  }

  // 5c. Payslips, when the server asks: the portal from the 1st until last month's payslip is in,
  // the import alone while the newest one waits for its deposit (the cartola pairs it).
  if (o.payslips == null) {
    x.note("=== payslips (not tonight)");
  } else if (o.dryRun) {
    x.note(`=== (dry run) skipping payslips (${o.payslips.reason})`);
  } else {
    x.note(`payslips: ${o.payslips.reason}`);
    if (o.payslips.fetch) await x.step("fetch Buk payslips", ingest("fetch:buk-payslips"));
    await x.step("parse payslips", ingest("parse:payroll-liquidaciones"));
    // The months' legal parameters the payslip checks read (Previred; only new months are fetched).
    await x.step("payroll parameters", ingest("import:previred-indicators"));
    // Not strict: an unpaired payslip is the normal state until the month's cartola arrives.
    await x.step("import payslips", ingest("import:payroll-liquidaciones", "--no-strict"));
  }

  // 6. Statement JSON: cross-check, and (when enabled) write the facturaciones no PDF owns.
  if (o.dryRun || !o.statementJsonApply) {
    await x.step("Santander statements (report only)", ingest("import:santander-statements"));
  } else {
    await x.step("Santander statements (apply)", ingest("import:santander-statements", "--apply"));
  }

  return { santander, lider };
}

/** `<label> (apply)` with `--apply`, or `<label> (report only)`. */
export function applyOrReport(x: StepRunner, label: string, script: string, apply: boolean): Promise<StepOutcome> {
  return apply ? x.step(`${label} (apply)`, ingest(script, "--apply")) : x.step(`${label} (report only)`, ingest(script));
}

/**
 * «MetLife read (<mode>)» when the server asked for one (`fetch:metlife --read`, `--dry-run` in a
 * dry run: the server rolls back what it would write). Returns what it wrote — paid cuotas plus a
 * new quote row — so the hourly poll counts it as activity.
 */
export async function runMetlifeRead(x: StepRunner, request: IngestRunRequest["metlife_read"], dryRun: boolean): Promise<number> {
  if (request == null) {
    x.note("=== MetLife read (not asked)");
    return 0;
  }
  x.note(`MetLife read: ${request.reason}`);
  const r = dryRun
    ? await x.step(`MetLife read (${request.mode}) (dry run)`, ingest("fetch:metlife", "--read", "--dry-run"))
    : await x.step(`MetLife read (${request.mode})`, ingest("fetch:metlife", "--read"));
  return (r.result.inserted ?? 0) + (r.result.staged ?? 0);
}
