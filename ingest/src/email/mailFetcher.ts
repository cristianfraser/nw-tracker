/**
 * The one way mail is read out of Gmail. Every search runs on All Mail (archived mail counts),
 * with a `SINCE` that survives Gmail's DST blind day (`searchSinceCandidates`), inside a session
 * that is opened again when the connection drops (`withImapSession`).
 *
 * Two shapes:
 * - `fetchMailDocuments(source)`: a source DECLARES which mails it takes (sender or Gmail query,
 *   subject → document kind) and what each mail's documents are (`documents`); this module walks
 *   the window, skips what the document ledger already holds, writes, records and reports. A
 *   document is recorded once it is written or found already on disk, never when it failed.
 * - `archiveMails`: one sender's mails over a date range staged as text (the decoders read them),
 *   rewritten each time.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { FetchMessageObject, ImapFlow } from "imapflow";
import { hasDocument, recordDocument, type DocumentSource } from "../documentLedger.js";
import { ensureDir, resolveCfraserDir } from "../paths.js";
import { log, logStep } from "../log.js";
import { withImapSession } from "./imapSession.js";
import {
  decodedBodyText,
  htmlBodyPartFromStructure,
  mailDocumentLedgerKey,
  mimeBodyToText,
  pdfAttachmentsFromStructure,
  safeAttachmentName,
  type AttachmentNode,
} from "./mime.js";

/** How far back a document fetch looks; the ledger bounds the rest. One missed month plus mail lag. */
export const DEFAULT_MAIL_WINDOW_DAYS = 45;

/**
 * Gmail evaluates `SINCE` in the account's zone and answers NOTHING for the calendar day a DST
 * transition removes an hour from: `SINCE 06-Sep-2026` (Chile's 2026 spring-forward day) came
 * back empty while `05-Sep` and `07-Sep` returned the mails — verified against the raw SEARCH
 * replies on 2026-09-08, after the watermark had sat on that day since a Saturday-night mail and
 * every poll for two days had been blind to a «Pagamos tu retiro». The broken day is unknowable
 * in general, so the search starts a day before the one asked for and, when that returns nothing,
 * is repeated from two days before: two consecutive days cannot both be transition days, and the
 * callers drop what is older than they asked for, so the wider window costs a few envelopes and
 * never a message.
 */
export function searchSinceCandidates(since: Date): Date[] {
  return [1, 2].map((daysBack) => new Date(since.getTime() - daysBack * 86_400_000));
}

export type MailQuery = { from: string; subject?: string } | { gmraw: string };

/** UIDs of the mails `query` names from `since` (DST-safe) up to `before`, if given. */
export async function searchMailSince(client: ImapFlow, query: MailQuery, since: Date, before?: Date): Promise<number[]> {
  for (const candidate of searchSinceCandidates(since)) {
    const found = await client.search({ ...query, since: candidate, ...(before ? { before } : {}) }, { uid: true });
    if (Array.isArray(found) && found.length > 0) return found;
  }
  return [];
}

/** Run `fn` with All Mail open read-only. */
export async function withAllMail<T>(client: ImapFlow, fn: () => Promise<T>): Promise<T> {
  const allMail = (await client.list()).find((b) => b.specialUse === "\\All");
  if (!allMail) throw new Error("No All Mail folder on this account");
  const lock = await client.getMailboxLock(allMail.path, { readOnly: true });
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

async function downloadPart(client: ImapFlow, uid: number, part: string | undefined): Promise<{ bytes: Buffer; charset: string }> {
  const download = await client.download(String(uid), part, { uid: true });
  const chunks: Buffer[] = [];
  for await (const chunk of download.content) chunks.push(Buffer.from(chunk));
  return { bytes: Buffer.concat(chunks), charset: String(download.meta?.charset ?? "utf-8").toLowerCase() };
}

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

/** A mail a source takes, as its envelope and structure describe it. */
export type WantedMail = {
  uid: number;
  messageId: string;
  subject: string;
  date: Date;
  /** The document kind its subject announces (the ledger kind). */
  kind: string;
  /** `YYYY-MM-DD-<message id slug>`: the per-mail ledger key. */
  mailKey: string;
  pdfs: AttachmentNode[];
  bodyPart: string | null;
};

/** What a document's write reports. */
export type MailWriteOutcome = { written: true } | { already: string } | { error: string };

/** Reads parts of the mail being staged. */
export interface MailReader {
  part(part: string | undefined): Promise<{ bytes: Buffer; charset: string }>;
  /** The decoded text of the mail's html (else plain) body, cut at `maxChars`; "" without one. */
  bodyText(maxChars: number): Promise<string>;
}

/**
 * One document a mail carries. `skip`: the mail is left alone and NOT recorded (an attachment
 * shape the source does not take); `error`: the same, and the fetch fails.
 */
export type MailDocument =
  | { key: string; file: string; write(read: MailReader): Promise<MailWriteOutcome> }
  | { key: string; skip: string }
  | { key: string; error: string };

export type MailSource = {
  /** Log and session label («Lider boletas»). */
  label: string;
  /** Document-ledger source («lider», «santander»). */
  ledger: DocumentSource;
  query: MailQuery;
  /** The document kind a subject announces, or null for a mail the source does not take. */
  kindOf(subject: string): string | null;
  /** Newest first: when a document is sent twice, the later copy is the one kept. */
  newestFirst?: boolean;
  /** Bound of `--all` (a full-history backfill), for a source that allows one. */
  allHistoryDays?: number;
  documents(mail: WantedMail): MailDocument[];
};

export type MailDocumentResult = {
  saved: { kind: string; key: string; file: string }[];
  skipped: { kind: string; key: string; reason: string }[];
  /** Non-empty means the run must fail loudly (an unmapped shape, an undecryptable file). */
  errors: { kind: string; key: string; reason: string }[];
};

const ALREADY_FETCHED = "already fetched";

/** Fetch every document of `source` mailed in the window that the ledger does not hold yet. */
export async function fetchMailDocuments(
  source: MailSource,
  opts: { windowDays?: number; allHistory?: boolean; dryRun?: boolean } = {}
): Promise<MailDocumentResult> {
  const windowDays = opts.allHistory && source.allHistoryDays ? source.allHistoryDays : (opts.windowDays ?? DEFAULT_MAIL_WINDOW_DAYS);
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const dryRun = opts.dryRun === true;
  logStep(`e-mail — ${source.label} since ${since.toISOString().slice(0, 10)}${dryRun ? " (dry run)" : ""}`);

  const result: MailDocumentResult = { saved: [], skipped: [], errors: [] };
  await withImapSession(source.label, async (client) => {
    // A rerun after a dropped connection starts over: what was written is in the ledger by now.
    result.saved.length = 0;
    result.skipped.length = 0;
    result.errors.length = 0;
    await withAllMail(client, async () => {
      const uids = await searchMailSince(client, source.query, since);
      // Collect first, download after: imapflow cannot serve a download while a fetch stream is iterated.
      const wanted: WantedMail[] = [];
      for await (const msg of client.fetch(uids, { envelope: true, bodyStructure: true, uid: true }, { uid: true })) {
        const subject = String(msg.envelope?.subject ?? "").trim();
        const kind = source.kindOf(subject);
        const date = msg.envelope?.date;
        if (!kind || !date || date < since) continue;
        wanted.push(wantedMail(msg, subject, kind, date));
      }
      wanted.sort((a, b) => (source.newestFirst ? b.date.getTime() - a.date.getTime() : a.date.getTime() - b.date.getTime()));
      for (const mail of wanted) {
        const read: MailReader = {
          part: (part) => downloadPart(client, mail.uid, part),
          async bodyText(maxChars) {
            if (!mail.bodyPart) return "";
            const { bytes } = await downloadPart(client, mail.uid, mail.bodyPart === "TEXT" ? undefined : mail.bodyPart);
            return mimeBodyToText(bytes.toString("utf8"), maxChars);
          },
        };
        for (const doc of source.documents(mail)) {
          const kind = mail.kind;
          if ("error" in doc) {
            result.errors.push({ kind, key: doc.key, reason: doc.error });
            continue;
          }
          if ("skip" in doc) {
            result.skipped.push({ kind, key: doc.key, reason: doc.skip });
            continue;
          }
          if (hasDocument(source.ledger, kind, doc.key)) {
            result.skipped.push({ kind, key: doc.key, reason: ALREADY_FETCHED });
            continue;
          }
          if (dryRun) {
            result.saved.push({ kind, key: doc.key, file: doc.file });
            continue;
          }
          const outcome = await doc.write(read);
          if ("error" in outcome) {
            result.errors.push({ kind, key: doc.key, reason: outcome.error });
            continue;
          }
          // Recorded whether it was written or already on disk: either way we have it.
          recordDocument(source.ledger, kind, doc.key);
          if ("already" in outcome) result.skipped.push({ kind, key: doc.key, reason: outcome.already });
          else result.saved.push({ kind, key: doc.key, file: doc.file });
        }
      }
    });
  });

  for (const s of result.saved) log(`e-mail: ${source.label} ${s.kind} ${s.key} → ${s.file}`);
  const already = result.skipped.filter((s) => s.reason === ALREADY_FETCHED).length;
  for (const s of result.skipped) if (s.reason !== ALREADY_FETCHED) log(`e-mail: ${source.label} ${s.key} skipped (${s.reason})`);
  if (already > 0) log(`e-mail: ${already} ${source.label} document(s) already fetched`);
  for (const e of result.errors) log(`e-mail: ${source.label} ${e.key} ERROR (${e.reason})`);
  if (result.saved.length === 0 && result.errors.length === 0) log(`e-mail: nothing new from ${source.label}`);
  return result;
}

function wantedMail(msg: FetchMessageObject, subject: string, kind: string, date: Date): WantedMail {
  const messageId = String(msg.envelope?.messageId ?? `uid-${msg.uid}`);
  return {
    uid: msg.uid,
    messageId,
    subject,
    date,
    kind,
    mailKey: mailDocumentLedgerKey(date, messageId),
    pdfs: pdfAttachmentsFromStructure(msg.bodyStructure),
    bodyPart: htmlBodyPartFromStructure(msg.bodyStructure),
  };
}

/**
 * The document of a mail that carries exactly one PDF the source takes, saved as
 * `<mail date> <attachment name>` under `dir` (left alone when already there: same bytes, and
 * the importer may be reading it). `afterWrite` may refuse the file (an undecryptable PDF): it is
 * removed and the fetch fails.
 */
export function singlePdfDocument(
  mail: WantedMail,
  opts: { dir: () => string; accept?: (filename: string) => boolean; fallbackName: string; shape: string; afterWrite?: (file: string) => void }
): MailDocument {
  const pdfs = opts.accept ? mail.pdfs.filter((a) => opts.accept!(a.filename)) : mail.pdfs;
  if (pdfs.length !== 1) {
    return { key: mail.mailKey, error: `expected exactly one ${opts.shape}, got [${mail.pdfs.map((a) => a.filename).join(", ") || "no pdf attachments"}]` };
  }
  const name = `${mail.date.toISOString().slice(0, 10)} ${safeAttachmentName(pdfs[0]!.filename, opts.fallbackName)}`;
  return {
    key: mail.mailKey,
    file: name,
    async write(read) {
      const target = path.join(ensureDir(opts.dir()), name);
      if (fs.existsSync(target)) return { already: `${name} already on disk` };
      fs.writeFileSync(target, (await read.part(pdfs[0]!.part)).bytes);
      try {
        opts.afterWrite?.(target);
      } catch (err) {
        fs.rmSync(target, { force: true });
        return { error: err instanceof Error ? err.message : String(err) };
      }
      return { written: true };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Archives
// ---------------------------------------------------------------------------------------------

export type ArchivedMail = {
  message_id: string;
  /** Sending time on the Chile clock, `YYYY-MM-DD HH:MM`. */
  sent_at_chile: string;
  from: string;
  /** The sender's display name («Konko Active»), when the mail names one. */
  from_name?: string;
  subject: string;
  text: string;
  /** PDF attachments the archive was asked for: the saved file and its `pdftotext -layout` text. */
  attachments?: { filename: string; file: string; text: string }[];
};

const chileClock = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "America/Santiago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * Stage one sender's mails for a date range as `{message_id, sent_at_chile, from, subject, text}`,
 * oldest first, under `cfraser/<dir>/<fileName>`. Envelopes are read first and only a subject
 * `wantSubject` accepts is downloaded; `keep` may still drop a mail by its text.
 */
export async function archiveMails(opts: {
  /** The sender, as IMAP FROM matches it (an address or a domain)… */
  from?: string;
  /** …or a Gmail search query, for mails many senders send in one layout. */
  gmraw?: string;
  label: string;
  fromYmd: string;
  toYmd: string;
  wantSubject: (subject: string) => boolean;
  keep?: (mail: ArchivedMail) => boolean;
  /** Folder under `cfraser/`. */
  dir: string;
  fileName?: string;
  /**
   * PDF attachments to keep, by file name: each is saved under `cfraser/<dir>/attachments/` and its
   * `pdftotext -layout` text staged with the mail.
   */
  pdfAttachment?: (filename: string) => boolean;
}): Promise<{ file: string; count: number }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.fromYmd) || !/^\d{4}-\d{2}-\d{2}$/.test(opts.toYmd)) {
    throw new Error(`--from / --to must be YYYY-MM-DD (got ${opts.fromYmd} / ${opts.toYmd})`);
  }
  if (!opts.from === !opts.gmraw) throw new Error("archiveMails takes exactly one of from / gmraw");
  logStep(`e-mail — ${opts.label} ${opts.fromYmd} → ${opts.toYmd}`);
  const mails: ArchivedMail[] = [];
  const pdfParts: { mail: ArchivedMail; uid: number; part: string; filename: string }[] = [];
  await withImapSession(opts.label, async (client) => {
    // A rerun after a dropped connection reads the whole window again.
    mails.length = 0;
    pdfParts.length = 0;
    await withAllMail(client, async () => {
      // A day either side: SINCE / BEFORE are evaluated on the account's own clock.
      const since = new Date(`${opts.fromYmd}T00:00:00Z`);
      const before = new Date(`${opts.toYmd}T00:00:00Z`);
      before.setUTCDate(before.getUTCDate() + 2);
      const query: MailQuery = opts.gmraw ? { gmraw: opts.gmraw } : { from: opts.from! };
      const uids = await searchMailSince(client, query, since, before);
      const wanted: number[] = [];
      for await (const msg of client.fetch(uids, { envelope: true, uid: true }, { uid: true })) {
        if (opts.wantSubject(String(msg.envelope?.subject ?? "").trim())) wanted.push(msg.uid);
      }
      for await (const msg of client.fetch(wanted, { envelope: true, source: true, uid: true, bodyStructure: true }, { uid: true })) {
        const subject = String(msg.envelope?.subject ?? "").trim();
        const date = msg.envelope?.date;
        if (!date) throw new Error(`mail ${msg.uid} «${subject}» has no date`);
        const sent = chileClock.format(date).replace(",", "");
        if (sent.slice(0, 10) < opts.fromYmd || sent.slice(0, 10) > opts.toYmd) continue;
        if (!msg.source) throw new Error(`mail ${msg.uid} «${subject}» came without its source`);
        const mail: ArchivedMail = {
          message_id: String(msg.envelope?.messageId ?? `uid-${msg.uid}`),
          sent_at_chile: sent,
          from: String(msg.envelope?.from?.[0]?.address ?? ""),
          ...(msg.envelope?.from?.[0]?.name ? { from_name: String(msg.envelope.from[0].name) } : {}),
          subject,
          text: decodedBodyText(msg.source),
        };
        if (opts.keep && !opts.keep(mail)) continue;
        mails.push(mail);
        if (opts.pdfAttachment) {
          mail.attachments = [];
          for (const a of pdfAttachmentsFromStructure(msg.bodyStructure)) {
            if (opts.pdfAttachment(a.filename)) pdfParts.push({ mail, uid: msg.uid, part: a.part, filename: a.filename });
          }
        }
      }
      // Downloaded once the fetch stream is done (a download inside it would wait on the stream).
      for (const a of pdfParts) {
        const { bytes } = await downloadPart(client, a.uid, a.part);
        const dir = ensureDir(path.join(resolveCfraserDir(), opts.dir, "attachments"));
        const file = path.join(dir, `${a.mail.sent_at_chile.slice(0, 10)}-${a.uid}-${safeAttachmentName(a.filename, "attachment.pdf")}`);
        fs.writeFileSync(file, bytes);
        const text = execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
        a.mail.attachments!.push({ filename: a.filename, file, text });
      }
    });
  });
  mails.sort((a, b) => a.sent_at_chile.localeCompare(b.sent_at_chile));
  const dir = ensureDir(path.join(resolveCfraserDir(), opts.dir));
  const file = path.join(dir, opts.fileName ?? `${opts.fromYmd}_${opts.toYmd}.json`);
  fs.writeFileSync(file, `${JSON.stringify(mails, null, 2)}\n`);
  log(`e-mail: ${mails.length} mail(s) → ${file}`);
  return { file, count: mails.length };
}
