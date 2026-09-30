import type { IngestRunRequest, SantanderFetchOutcome } from "nw-tracker-contracts";
import { applyOrReport } from "./nightly.js";
import { npmRun, type StepRunner } from "./steps.js";

/**
 * The hourly e-mail poll — `email-run.sh`'s sequence (same labels, same commands, same gates),
 * except that the bank fetch is the server's call now: it asks for a catch-up (the nightly fetch
 * failed or never ran) or a payday fetch in the request, and this poll only declines one it
 * cannot safely make (the login is latched, or the bank was tried moments ago).
 */

export type HourlyOptions = {
  dryRun: boolean;
  fintualApply: boolean;
  racionalApply: boolean;
  santanderFetch: IngestRunRequest["santander_fetch"];
  /** A reason to decline the requested bank fetch, or null to go ahead (`santanderVeto`). */
  santanderVeto: () => string | null;
  /** Called before a bank fetch this poll makes (not one it declines): the attempt markers. */
  onSantanderAttempt: (mode: "catch-up" | "payday") => void;
  /** Photos waiting in `cfraser/grocery-receipts/inbox` — the one input no fetch stages. */
  groceryInboxCount: () => number;
};

export type HourlyResult = { santander: SantanderFetchOutcome | null; activity: boolean };

/** Last «Summary: N saved» of a fetch (santanderDocsMain / liderBoletasMain / …). */
export function savedCount(output: string): number {
  const all = [...output.matchAll(/Summary: (\d+) saved/g)];
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
  ] as const;
  const saved: number[] = [];
  for (const [label, script] of fetches) {
    const r = o.dryRun
      ? await x.step(`${label} (dry run)`, npmRun(script, "--dry-run"), capture)
      : await x.step(label, npmRun(script), capture);
    saved.push(savedCount(r.output));
  }
  const [sdSaved, lsSaved, lbSaved, fdSaved] = saved as [number, number, number, number];
  // fetch:emails has no dry mode; --no-mark leaves the watermark alone (a safe re-read).
  const broker = o.dryRun
    ? await x.step("fetch broker e-mail (no-mark)", npmRun("fetch:emails", "--no-mark"), capture)
    : await x.step("fetch broker e-mail", npmRun("fetch:emails"), capture);
  const beMsgs = brokerMessageCount(broker.output);

  // The one bank session a poll may open — only when the server asked for it.
  let santander: SantanderFetchOutcome | null = null;
  let caughtUp = false;
  if (!o.dryRun && o.santanderFetch) {
    const { mode, reason } = o.santanderFetch;
    const veto = o.santanderVeto();
    if (veto) {
      x.note(`=== Santander ${mode} (declined — ${veto})`);
      santander = { mode, outcome: "vetoed", note: veto };
    } else {
      x.note(`${mode} fetch — ${reason}`);
      // Recorded before the fetch: one that fails still used its attempt.
      o.onSantanderAttempt(mode);
      const args = mode === "payday" ? ["--background", "--movements-only"] : ["--background"];
      const fetched = await x.step(`fetch Santander (${mode})`, npmRun("fetch:santander", ...args));
      santander = { mode, outcome: fetched.ok ? "ok" : "failed", note: null };
      if (fetched.ok) {
        caughtUp = true;
        await x.step(`Santander movements (${mode})`, npmRun("import:santander-movements"));
        await x.step(`Convert CC payment mirrors (${mode})`, npmRun("convert:cc-payment-mirrors"));
        await x.step(`CC bank cupo check (${mode})`, npmRun("check:cc-bank-cupo"));
      }
    }
  }

  // Imports only when a fetch staged something new this hour (or a photo is waiting); anything
  // the gate misses is retried by the nightly, whose pipeline runs unconditionally.
  if (!o.dryRun) {
    const grocery = o.groceryInboxCount();
    // A bank fetch drops the checking «últimos movimientos» xlsx in the inbox too.
    if (sdSaved > 0 || lsSaved > 0 || lbSaved > 0 || grocery > 0 || caughtUp) {
      await x.step("inbox pipeline", npmRun("import:cfraser-inbox"));
    } else {
      x.note("=== inbox pipeline (skipped — nothing new staged)");
    }
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
  }

  const activity = sdSaved > 0 || lsSaved > 0 || lbSaved > 0 || fdSaved > 0 || beMsgs > 0 || caughtUp;
  if (activity) {
    x.note(
      `activity this hour: santander-docs saved=${sdSaved}, lider statement saved=${lsSaved}, ` +
        `boletas saved=${lbSaved}, fintual docs saved=${fdSaved}, broker mail=${beMsgs}, santander fetch=${caughtUp ? 1 : 0}`
    );
  }
  return { santander, activity };
}
