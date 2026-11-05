import type { BankProductSummaryFetchStep, IngestRunRequest, SantanderFetchOutcome } from "nw-tracker-contracts";
import { parseBalancePollResult } from "../santander/balancePoll.js";
import { applyOrReport } from "./nightly.js";
import { npmRun, savedCount, type StepRunner } from "./steps.js";

/**
 * The hourly poll — the e-mail fetches and imports of `email-run.sh`, plus the Santander balance
 * poll when the server asks for it: log in, send the product summary, read the movements of only
 * the products whose balance disagrees with the app, import them, and judge again (the check
 * notifies a difference the movements did not explain). This poll only declines a bank session it
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
  /** The server's request to read the mortgage sheet (stale from the 11th until the cuota is in). */
  mortgageSheet: { reason: string } | null;
};

export type HourlyResult = { santander: SantanderFetchOutcome | null; activity: boolean };

export { savedCount };

/** Movements the transfer-mail import wrote from a mail this run («movement written from the mail»). */
export function mailMovementCount(output: string): number {
  return [...output.matchAll(/movement written from the mail/g)].length;
}

/** The mortgage sheet import's summary: «mortgage sheet: N row(s) written». */
export function mortgageSheetWritten(output: string): number {
  const all = [...output.matchAll(/mortgage sheet: (\d+) row\(s\) written/g)];
  return all.length > 0 ? Number(all.at(-1)![1]) : 0;
}

/** import:fintual-wallet --apply logs «→ N inserted, M already present». */
export function fintualWalletInserted(output: string): number {
  const all = [...output.matchAll(/→ (\d+) inserted, \d+ already present/g)];
  return all.length > 0 ? Number(all.at(-1)![1]) : 0;
}

/** fetch.ts always logs the count, zero included: «e-mail: N broker message(s)». */
export function brokerMessageCount(output: string): number {
  const all = [...output.matchAll(/e-mail: (\d+) broker message\(s\)/g)];
  return all.length > 0 ? Number(all.at(-1)![1]) : 0;
}

export async function runHourly(x: StepRunner, o: HourlyOptions): Promise<HourlyResult> {
  const capture = { capture: true };
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
      ? await x.step(`${label} (dry run)`, npmRun(script, "--dry-run"), capture)
      : await x.step(label, npmRun(script), capture);
    saved.push(savedCount(r.output));
  }
  const [sdSaved, lsSaved, lbSaved, fdSaved, amSaved] = saved as [number, number, number, number, number];
  // fetch:emails has no dry mode; --no-mark leaves the watermark alone (a safe re-read).
  const broker = o.dryRun
    ? await x.step("fetch broker e-mail (no-mark)", npmRun("fetch:emails", "--no-mark"), capture)
    : await x.step("fetch broker e-mail", npmRun("fetch:emails"), capture);
  const beMsgs = brokerMessageCount(broker.output);

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
      const poll = await x.step("Santander balance poll", npmRun("fetch:santander", "--balance-poll"), capture);
      const read = parseBalancePollResult(poll.output);
      listings = read ?? [];
      differs = /\bdiffers: /.test(poll.output);
      santander = {
        mode,
        outcome: poll.ok ? "ok" : "failed",
        note: read == null ? "the server never answered" : read.length > 0 ? `read ${read.join(", ")}` : "every product agrees",
      };
      // What the session staged is imported even when a later listing failed.
      if (listings.includes("card-movements")) {
        await x.step("Santander movements (balance poll)", npmRun("import:santander-movements"));
        await x.step("Convert CC payment mirrors (balance poll)", npmRun("convert:cc-payment-mirrors"));
      }
      if (listings.includes("checking-usd-movements")) {
        await x.step("Santander USD movements (balance poll)", npmRun("import:checking-usd-movements"));
      }
    }
  }

  // Imports only when a fetch staged something new this hour (or a photo is waiting); anything
  // the gate misses is retried by the nightly, whose pipeline runs unconditionally.
  if (!o.dryRun) {
    const grocery = o.groceryInboxCount();
    // A balance poll that read the checking account drops its «últimos movimientos» xlsx in the inbox.
    const checkingRead = listings.includes("checking-movements");
    if (sdSaved > 0 || lsSaved > 0 || lbSaved > 0 || grocery > 0 || checkingRead) {
      await x.step("inbox pipeline", npmRun("import:cfraser-inbox"));
    } else {
      x.note("=== inbox pipeline (skipped — nothing new staged)");
    }
    // After every import: a difference the bank's movements did not explain is notified.
    if (differs) await x.step("CC bank cupo check (balance poll)", npmRun("check:cc-bank-cupo", "--recheck"));
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
      await x.step("Apple receipts", npmRun("import:apple-mail"));
    } else {
      x.note("=== Apple receipts (skipped — no new mail)");
    }
  }

  // The mortgage sheet the user keeps by hand, while the server says the cycle's cuota is not in
  // the ledger (from the 11th): a cuota posted during the day is in the ledger within the hour.
  let sheetRows = 0;
  if (o.mortgageSheet == null) {
    x.note("=== Mortgage sheet (not stale)");
  } else {
    x.note(`mortgage sheet — ${o.mortgageSheet.reason}`);
    const sheet = o.dryRun
      ? await x.step("Mortgage sheet (dry run)", npmRun("import:mortgage-sheet", "--dry-run"), capture)
      : await x.step("Mortgage sheet", npmRun("import:mortgage-sheet"), capture);
    sheetRows = mortgageSheetWritten(sheet.output);
  }

  // Every hour: a transfer to or from the user's checking account is mailed the moment it is made,
  // and its movement is written from the mail until the 22:00 bank feed lists it.
  const transfers = o.dryRun
    ? await x.step("Transfer mails (dry run)", npmRun("import:transfer-mails", "--days=2", "--dry-run"), capture)
    : await x.step("Transfer mails", npmRun("import:transfer-mails", "--days=2"), capture);
  const mailMovements = mailMovementCount(transfers.output);

  // Every hour: the Fintual dollar wallet's cash interest, which no mail announces (one /gql
  // request); a credit is in the ledger within the hour it posts.
  const wallet =
    o.dryRun || !o.fintualApply
      ? await x.step(`Fintual wallet interest (${o.dryRun ? "dry run" : "report only"})`, npmRun("import:fintual-wallet"), capture)
      : await x.step("Fintual wallet interest (apply)", npmRun("import:fintual-wallet", "--apply"), capture);
  const walletInterest = fintualWalletInserted(wallet.output);

  const activity =
    sdSaved > 0 ||
    lsSaved > 0 ||
    lbSaved > 0 ||
    fdSaved > 0 ||
    amSaved > 0 ||
    beMsgs > 0 ||
    listings.length > 0 ||
    mailMovements > 0 ||
    sheetRows > 0 ||
    walletInterest > 0;
  if (activity) {
    x.note(
      `activity this hour: santander-docs saved=${sdSaved}, lider statement saved=${lsSaved}, ` +
        `boletas saved=${lbSaved}, fintual docs saved=${fdSaved}, apple mail saved=${amSaved}, broker mail=${beMsgs}, ` +
        `santander listings read=${listings.length}, movements from transfer mails=${mailMovements}, mortgage sheet rows=${sheetRows}, ` +
        `fintual wallet interest=${walletInterest}`
    );
  }
  return { santander, activity };
}
