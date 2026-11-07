import fs from "node:fs";
import path from "node:path";
import type { IngestResult } from "nw-tracker-contracts";
import { log } from "./log.js";
import { ensureDir } from "./paths.js";
import { describeIngestFailure } from "./serverApi.js";

/**
 * The one send → archive loop of the commands that hand staged documents to the server. A sent
 * document (a file or a capture folder) the server is done with moves to `imported/` beside it;
 * one it may answer differently later (`retry`) or that conflicts stays staged.
 */

/** Move `from` (file or folder) into `dir` under `name`; an earlier copy there is replaced. */
export function archiveSent(from: string, dir: string, name = path.basename(from)): string {
  const to = path.join(ensureDir(dir), name);
  if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(from, to);
  return to;
}

export type SendStagedOutcome = { exitCode: 0 | 1; sent: number; conflicts: number };

/**
 * Send `docs` one by one, in order. The first request that fails (server down, refusal) stops
 * the loop with exit 1: the rest wait for the next run. A conflict is logged and counted, and the
 * document stays staged for a human.
 */
export async function sendStaged<D>(
  docs: readonly D[],
  o: {
    /** The staged file or folder. */
    path(doc: D): string;
    send(doc: D): Promise<IngestResult>;
    /** Where it goes once done; default `<its folder>/imported/<its name>`. */
    archive?(doc: D): { dir: string; name: string };
    report(doc: D, result: IngestResult, archivedTo: string | null): void;
  }
): Promise<SendStagedOutcome> {
  const out: SendStagedOutcome = { exitCode: 0, sent: 0, conflicts: 0 };
  for (const doc of docs) {
    const file = o.path(doc);
    let result: IngestResult;
    try {
      result = await o.send(doc);
    } catch (err) {
      log(`FAILED ${path.basename(file)}: ${describeIngestFailure(err)}`);
      out.exitCode = 1;
      return out;
    }
    out.sent++;
    if (result.status === "conflict") {
      out.conflicts++;
      log(`CONFLICT ${path.basename(file)}: ${result.message ?? ""}`);
      for (const c of result.conflicts ?? []) log(`  ${c.message}`);
    }
    const done = result.status !== "conflict" && !result.retry && !result.dry_run;
    const target = o.archive?.(doc) ?? { dir: path.join(path.dirname(file), "imported"), name: path.basename(file) };
    const archivedTo = done ? archiveSent(file, target.dir, target.name) : null;
    o.report(doc, result, archivedTo);
  }
  return out;
}
