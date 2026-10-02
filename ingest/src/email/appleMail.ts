/**
 * Apple's App Store receipts and subscription notices out of Gmail into `cfraser/apple-mail/`.
 *
 * Each wanted mail is staged as `{message_id, subject, date, html}` (the decoded HTML body; the
 * decoder needs its layout and artwork links) under a message-id-keyed ledger: every receipt is
 * its own mail, so the message id is the document's identity. `import:apple-mail` decodes and
 * sends them. The search runs over All Mail, since these mails are often archived unread.
 */
import fs from "node:fs";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { readKeychainSecret } from "../keychain.js";
import { hasDocument, recordDocument } from "../documentLedger.js";
import { ensureDir } from "../paths.js";
import { log, logStep } from "../log.js";
import { APPLE_MAIL_SENDER, appleMailKind, appleMailStagingDir, type StagedAppleMail } from "../apple/appStoreMail.js";
import { loadBrokerEmailConfig } from "./fetch.js";
import { htmlBodyPartFromStructure, mailDocumentLedgerKey } from "./santanderDocs.js";

const DEFAULT_WINDOW_DAYS = 45;
const LEDGER_KIND = "email-app-store";

export type AppleMailFetchResult = { saved: string[]; skipped: { key: string; reason: string }[] };

export async function fetchAppleMail(opts?: { windowDays?: number; dryRun?: boolean }): Promise<AppleMailFetchResult> {
  const config = loadBrokerEmailConfig();
  const password = readKeychainSecret(config.keychain_service, config.address);
  const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const dryRun = opts?.dryRun === true;
  logStep(`e-mail — Apple receipts and subscription notices since ${since.toISOString().slice(0, 10)}${dryRun ? " (dry run)" : ""}`);

  const result: AppleMailFetchResult = { saved: [], skipped: [] };
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.address, pass: password },
    logger: false,
  });
  await client.connect();
  try {
    const all = (await client.list()).find((b) => b.specialUse === "\\All");
    if (!all) throw new Error("No All Mail folder on this account");
    const lock = await client.getMailboxLock(all.path, { readOnly: true });
    try {
      const uids = await client.search({ from: APPLE_MAIL_SENDER, since }, { uid: true });
      if (!uids || uids.length === 0) {
        log("e-mail: no Apple mail in window");
        return result;
      }
      const wanted: { uid: number; key: string; subject: string; date: Date; messageId: string; part: string | null }[] = [];
      for await (const msg of client.fetch(uids, { envelope: true, bodyStructure: true, uid: true }, { uid: true })) {
        const subject = String(msg.envelope?.subject ?? "");
        if (appleMailKind(subject) == null) continue;
        const date = msg.envelope?.date ?? new Date();
        const messageId = String(msg.envelope?.messageId ?? `uid-${msg.uid}`);
        wanted.push({
          uid: msg.uid,
          key: mailDocumentLedgerKey(date, messageId),
          subject,
          date,
          messageId,
          part: htmlBodyPartFromStructure(msg.bodyStructure),
        });
      }
      for (const w of wanted) {
        if (hasDocument("apple", LEDGER_KIND, w.key)) {
          result.skipped.push({ key: w.key, reason: "already fetched" });
          continue;
        }
        if (!w.part) throw new Error(`Apple mail without a body part: ${w.subject} (${w.key})`);
        if (dryRun) {
          result.saved.push(w.key);
          continue;
        }
        const download = await client.download(String(w.uid), w.part === "TEXT" ? undefined : w.part, { uid: true });
        const chunks: Buffer[] = [];
        for await (const chunk of download.content) chunks.push(Buffer.from(chunk));
        const charset = String(download.meta?.charset ?? "utf-8").toLowerCase();
        const html = new TextDecoder(charset === "us-ascii" ? "utf-8" : charset).decode(Buffer.concat(chunks));
        const staged: StagedAppleMail = { message_id: w.messageId, subject: w.subject, date: w.date.toISOString(), html };
        fs.writeFileSync(path.join(ensureDir(appleMailStagingDir()), `${w.key}.json`), JSON.stringify(staged));
        recordDocument("apple", LEDGER_KIND, w.key);
        result.saved.push(w.key);
        log(`  saved ${w.date.toISOString().slice(0, 10)}  ${w.subject}`);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
  return result;
}
