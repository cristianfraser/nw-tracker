/**
 * Fetch Lider «Boleta Digital» e-mails out of Gmail into `cfraser/lider-boletas/staged/`.
 *
 * Every in-store purchase mails a receipt from contacto@info.lider.cl («Boleta Digital Lider» /
 * «Boleta Digital Lider Express»). The receipt itself is the `Boleta.pdf` ATTACHMENT — the HTML
 * body only carries the sucursal line and Mi Club points — so each staged document is a
 * directory holding the PDF plus a `meta.json` with the envelope and the flattened body text
 * (the server-side importer reads the sucursal from it and parses the PDF for items).
 *
 * The mail date is UTC and a Chilean evening purchase crosses midnight UTC — the movement date
 * therefore comes from the PDF's printed local datetime downstream, never from the mail date;
 * the mail date here is only used for the staging directory name and the search window.
 *
 * Ledger: one entry per message id (`lider` / `email-boleta`), so each boleta is fetched once
 * and a widened window (`--days`, or `--all` for the full-history backfill) never re-downloads.
 */
import fs from "node:fs";
import path from "node:path";
import { ImapFlow } from "imapflow";
import type { FetchMessageObject } from "imapflow";
import { readKeychainSecret } from "../keychain.js";
import { ensureDir, resolveCfraserDir } from "../paths.js";
import { log, logStep } from "../log.js";
import { hasDocument, recordDocument } from "../documentLedger.js";
import { loadBrokerEmailConfig, mimeBodyToText } from "./fetch.js";
import { normalizeMailSubject, pdfAttachmentsFromStructure, htmlBodyPartFromStructure } from "./santanderDocs.js";

export const LIDER_BOLETA_SENDER = "contacto@info.lider.cl";

const DEFAULT_WINDOW_DAYS = 45;
/** Full-history backfill bound; the mailbox is younger than this. */
const ALL_HISTORY_DAYS = 3650;

export function isLiderBoletaSubject(subject: string): boolean {
  return normalizeMailSubject(subject).includes("boleta");
}

export function liderBoletasStagingDir(): string {
  return path.join(resolveCfraserDir(), "lider-boletas", "staged");
}

/** `2026-08-06-19fd99993152afdd` — mail's UTC date + a filesystem-safe message-id slug. */
export function boletaStagingKey(date: Date, messageId: string): string {
  const idSlug = String(messageId ?? "")
    .replace(/[^A-Za-z0-9@._-]/g, "_")
    .slice(0, 80);
  return `${date.toISOString().slice(0, 10)}-${idSlug}`;
}

export type LiderBoletaFetchResult = {
  saved: { key: string; file: string }[];
  skipped: { key: string; reason: string }[];
};

export async function fetchLiderBoletaEmails(opts?: {
  windowDays?: number;
  allHistory?: boolean;
  dryRun?: boolean;
}): Promise<LiderBoletaFetchResult> {
  const config = loadBrokerEmailConfig();
  const password = readKeychainSecret(config.keychain_service, config.address);
  const windowDays = opts?.allHistory ? ALL_HISTORY_DAYS : (opts?.windowDays ?? DEFAULT_WINDOW_DAYS);
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const dryRun = opts?.dryRun === true;

  logStep(`e-mail — Lider boletas since ${since.toISOString().slice(0, 10)}${dryRun ? " (dry run)" : ""}`);

  const result: LiderBoletaFetchResult = { saved: [], skipped: [] };
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.address, pass: password },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ from: LIDER_BOLETA_SENDER, since });
      if (!uids || uids.length === 0) {
        log("e-mail: no Lider mail in window");
        return result;
      }

      const candidates: { uid: number; msg: FetchMessageObject }[] = [];
      for await (const msg of client.fetch(uids, { envelope: true, bodyStructure: true, uid: true })) {
        if (!isLiderBoletaSubject(String(msg.envelope?.subject ?? ""))) continue;
        candidates.push({ uid: msg.uid, msg });
      }

      for (const candidate of candidates) {
        const messageId = String(candidate.msg.envelope?.messageId ?? `uid-${candidate.uid}`);
        const mailDate = candidate.msg.envelope?.date ?? new Date();
        const key = boletaStagingKey(mailDate, messageId);
        if (hasDocument("lider", "email-boleta", key)) {
          result.skipped.push({ key, reason: "already fetched" });
          continue;
        }

        // The receipt is the attachment named Boleta.pdf; «Ticket de promoción.pdf» is noise.
        const attachments = pdfAttachmentsFromStructure(candidate.msg.bodyStructure).filter((a) =>
          /^boleta/i.test(a.filename.trim())
        );
        if (attachments.length !== 1) {
          result.skipped.push({
            key,
            reason: `expected exactly one Boleta.pdf attachment, found ${attachments.length}`,
          });
          continue;
        }
        if (dryRun) {
          result.saved.push({ key, file: "Boleta.pdf" });
          continue;
        }

        const bodyPartId = htmlBodyPartFromStructure(candidate.msg.bodyStructure);
        let bodyText = "";
        if (bodyPartId) {
          const bodyDownload = await client.download(
            String(candidate.uid),
            bodyPartId === "TEXT" ? undefined : bodyPartId,
            { uid: true }
          );
          const chunks: Buffer[] = [];
          for await (const chunk of bodyDownload.content) chunks.push(Buffer.from(chunk));
          bodyText = mimeBodyToText(Buffer.concat(chunks).toString("utf8"), 1500);
        }

        const pdfDownload = await client.download(String(candidate.uid), attachments[0]!.part, { uid: true });
        const pdfChunks: Buffer[] = [];
        for await (const chunk of pdfDownload.content) pdfChunks.push(Buffer.from(chunk));

        const dir = ensureDir(path.join(liderBoletasStagingDir(), key));
        fs.writeFileSync(path.join(dir, "Boleta.pdf"), Buffer.concat(pdfChunks));
        fs.writeFileSync(
          path.join(dir, "meta.json"),
          JSON.stringify(
            {
              message_id: messageId,
              subject: String(candidate.msg.envelope?.subject ?? ""),
              date: mailDate.toISOString(),
              body_text: bodyText,
            },
            null,
            2
          )
        );
        recordDocument("lider", "email-boleta", key);
        result.saved.push({ key, file: "Boleta.pdf" });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  for (const s of result.saved) log(`e-mail: boleta ${s.key}`);
  const alreadyCount = result.skipped.filter((s) => s.reason === "already fetched").length;
  for (const s of result.skipped) {
    if (s.reason !== "already fetched") log(`e-mail: boleta ${s.key} skipped (${s.reason})`);
  }
  if (alreadyCount > 0) log(`e-mail: ${alreadyCount} boleta(s) already fetched`);
  if (result.saved.length === 0) log("e-mail: no new boleta");
  return result;
}
