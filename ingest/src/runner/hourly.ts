import type { BankProductSummaryFetchStep, IngestRunRequest, LiderFetchOutcome, SantanderFetchOutcome } from "nw-tracker-contracts";
import { runLiderFetchAndImport } from "./liderState.js";
import { applyOrReport, runMetlifeRead } from "./nightly.js";
import { ingest, serverTask, type StepRunner } from "./steps.js";

/**
 * The hourly poll — the e-mail fetches and imports, plus the Santander balance poll when the
 * server asks for it: log in, send the product summary, read the movements of only
 * the products whose balance disagrees with the app, import them, and judge again (the check
 * notifies a difference the movements did not explain) — and Lider BCI's card listing when the
 * server asks. This poll only declines a bank session it
 * cannot safely open (the login is latched, or the bank was tried moments ago).
 */

export type HourlyOptions = {
  dryRun: boolean;
  fintualApply: boolean;
  racionalApply: boolean;
  santanderFetch: IngestRunRequest["santander_fetch"];
  /** A reason to decline the requested bank fetch, or null to go ahead (`santanderVeto`). */
  santanderVeto: () => string | null;
  /** Photos waiting in `cfraser/grocery-receipts/inbox` — the one input no fetch stages. */
  groceryInboxCount: () => number;
  /** The server's request to read MetLife's portal this hour (`quote` | `posted`), or null. */
  metlifeRead: IngestRunRequest["metlife_read"];
  /** The server's request to read Lider BCI's card site this hour, or null. */
  liderFetch: IngestRunRequest["lider_fetch"];
  /** A reason to decline the requested Lider read, or null to go ahead (`liderVeto`). */
  liderVeto: () => string | null;
};

export type HourlyResult = { santander: SantanderFetchOutcome | null; lider: LiderFetchOutcome | null; activity: boolean };

export async function runHourly(x: StepRunner, o: HourlyOptions): Promise<HourlyResult> {
  const fetches = [
    ["Santander e-mail documents", "fetch:santander-docs"],
    ["Lider statement e-mail", "fetch:lider-statements"],
    ["Lider boletas", "fetch:lider-boletas"],
    ["Fintual Acciones documents", "fetch:fintual-docs"],
    ["Apple receipts e-mail", "fetch:apple-mail"],
  ] as const;
  const saved: number[] = [];
  for (const [label, script] of fetches) {
    const r = o.dryRun
      ? await x.step(`${label} (dry run)`, ingest(script, "--dry-run"))
      : await x.step(label, ingest(script));
    saved.push(r.result.staged ?? 0);
  }
  const [sdSaved, lsSaved, lbSaved, fdSaved, amSaved] = saved as [number, number, number, number, number];
  // fetch:emails has no dry mode; --no-mark leaves the watermark alone (a safe re-read).
  const broker = o.dryRun
    ? await x.step("fetch broker e-mail (no-mark)", ingest("fetch:emails", "--no-mark"))
    : await x.step("fetch broker e-mail", ingest("fetch:emails"));
  const beMsgs = broker.result.staged ?? 0;

  // The one bank session a poll may open — only when the server asked for it.
  let santander: SantanderFetchOutcome | null = null;
  let listings: BankProductSummaryFetchStep[] = [];
  let differs = false;
  if (!o.dryRun && o.santanderFetch) {
    const { mode, reason } = o.santanderFetch;
    const veto = o.santanderVeto();
    if (veto) {
      x.note(`=== Santander ${mode} (declined — ${veto})`);
      santander = { mode, outcome: "vetoed", note: veto };
    } else {
      x.note(`${mode} — ${reason}`);
      const poll = await x.step("Santander balance poll", ingest("fetch:santander", "--balance-poll"));
      // `fetch` is absent when the poll never got the server's answer.
      const read = (poll.result.fetch as BankProductSummaryFetchStep[] | undefined) ?? null;
      listings = read ?? [];
      differs = poll.result.differs === true;
      santander = {
        mode,
        outcome: poll.ok ? "ok" : "failed",
        note: read == null ? "the server never answered" : read.length > 0 ? `read ${read.join(", ")}` : "every product agrees",
      };
      // What the session staged is imported even when a later listing failed.
      if (listings.includes("card-movements")) {
        await x.step("Santander movements (balance poll)", ingest("import:santander-movements"));
        await x.step("Convert CC payment mirrors (balance poll)", serverTask("cc_payment_mirrors"));
      }
      if (listings.includes("checking-usd-movements")) {
        await x.step("Santander USD movements (balance poll)", ingest("import:checking-usd-movements"));
      }
    }
  }

  // Lider BCI's card site, when the server asks: its open-cycle listing, imported at once (the
  // cupo check after the imports judges its capture).
  let lider: LiderFetchOutcome | null = null;
  let liderInserted = 0;
  let liderRead = false;
  if (!o.dryRun && o.liderFetch) {
    const veto = o.liderVeto();
    if (veto) {
      x.note(`=== Lider BCI (declined — ${veto})`);
      lider = { mode: "poll", outcome: "vetoed", note: veto };
    } else {
      x.note(`Lider BCI — ${o.liderFetch.reason}`);
      const read = await runLiderFetchAndImport(x, "poll", { dryRun: false });
      lider = read.outcome;
      liderInserted = read.inserted;
      liderRead = true;
    }
  }

  // Imports only when a fetch staged something new this hour (or a photo is waiting); anything
  // the gate misses is retried by the nightly, whose pipeline runs unconditionally.
  if (!o.dryRun) {
    const grocery = o.groceryInboxCount();
    // A balance poll that read the checking account drops its «últimos movimientos» xlsx in the inbox.
    const checkingRead = listings.includes("checking-movements");
    if (sdSaved > 0 || lsSaved > 0 || lbSaved > 0 || grocery > 0 || checkingRead) {
      await x.step("inbox pipeline", ingest("import:cfraser-inbox"));
    } else {
      x.note("=== inbox pipeline (skipped — nothing new staged)");
    }
    // After every import: a difference the bank's movements did not explain is notified, and a
    // new Lider capture is judged.
    if (differs) await x.step("CC bank cupo check (balance poll)", serverTask("cc_bank_cupo_check", "--recheck"));
    else if (liderRead) await x.step("CC bank cupo check (Lider BCI)", serverTask("cc_bank_cupo_check"));
    if (beMsgs > 0) {
      await applyOrReport(x, "Fintual e-mail movements", "import:fintual-emails", o.fintualApply);
      await applyOrReport(x, "Racional e-mail movements", "import:racional-emails", o.racionalApply);
    } else {
      x.note("=== Fintual e-mail movements (skipped — no new broker mail)");
      x.note("=== Racional e-mail movements (skipped — no new broker mail)");
    }
    if (fdSaved > 0) {
      await applyOrReport(x, "Fintual Acciones dividend breakdowns", "import:fintual-acciones", o.fintualApply);
    } else {
      x.note("=== Fintual Acciones dividend breakdowns (skipped — no new document)");
    }
    if (amSaved > 0) {
      await x.step("Apple receipts", ingest("import:apple-mail"));
    } else {
      x.note("=== Apple receipts (skipped — no new mail)");
    }
  }

  // Every hour: a transfer to or from the user's checking account is mailed the moment it is made,
  // and its movement is written from the mail until the 22:00 bank feed lists it.
  const transfers = o.dryRun
    ? await x.step("Transfer mails (dry run)", ingest("import:transfer-mails", "--days=2", "--dry-run"))
    : await x.step("Transfer mails", ingest("import:transfer-mails", "--days=2"));
  const mailMovements = transfers.result.inserted ?? 0;

  // Every hour: a utility bill or gastos comunes statement is stored the hour it is mailed (sent
  // only when the default window holds a new mail; the nightly sends the whole window).
  const bills = o.dryRun
    ? await x.step("Utility bill mails (dry run)", ingest("import:utility-bills", "--only-if-new", "--dry-run"))
    : await x.step("Utility bill mails", ingest("import:utility-bills", "--only-if-new"));
  const billMails = bills.result.staged ?? 0;

  // Every hour: MetLife's receipt for a cuota paid online, so its charge is on the card the hour
  // it is paid (the nightly sends the whole window).
  const metlife = o.dryRun
    ? await x.step("MetLife receipts (dry run)", ingest("import:metlife-receipts", "--days=3", "--dry-run"))
    : await x.step("MetLife receipts", ingest("import:metlife-receipts", "--days=3"));
  const metlifeReceipts = metlife.result.staged ?? 0;

  // When the server asks: MetLife's portal — the cuota quoted this cycle, or the cuota a receipt
  // says was paid — after the receipts, so a cuota paid this hour is read with its receipt in.
  const metlifeRead = await runMetlifeRead(x, o.metlifeRead, o.dryRun);

  // Every hour: the Fintual dollar wallet's cash interest, which no mail announces (one /gql
  // request); a credit is in the ledger within the hour it posts.
  const wallet =
    o.dryRun || !o.fintualApply
      ? await x.step(`Fintual wallet interest (${o.dryRun ? "dry run" : "report only"})`, ingest("import:fintual-wallet"))
      : await x.step("Fintual wallet interest (apply)", ingest("import:fintual-wallet", "--apply"));
  const walletInterest = wallet.result.inserted ?? 0;

  const activity =
    sdSaved > 0 ||
    lsSaved > 0 ||
    lbSaved > 0 ||
    fdSaved > 0 ||
    amSaved > 0 ||
    beMsgs > 0 ||
    listings.length > 0 ||
    liderInserted > 0 ||
    mailMovements > 0 ||
    billMails > 0 ||
    metlifeReceipts > 0 ||
    metlifeRead > 0 ||
    walletInterest > 0;
  if (activity) {
    x.note(
      `activity this hour: santander-docs saved=${sdSaved}, lider statement saved=${lsSaved}, ` +
        `boletas saved=${lbSaved}, fintual docs saved=${fdSaved}, apple mail saved=${amSaved}, broker mail=${beMsgs}, ` +
        `santander listings read=${listings.length}, lider rows=${liderInserted}, movements from transfer mails=${mailMovements}, new bill mails=${billMails}, ` +
        `metlife receipts=${metlifeReceipts}, metlife portal writes=${metlifeRead}, ` +
        `fintual wallet interest=${walletInterest}`
    );
  }
  return { santander, lider, activity };
}
