/**
 * Fetch the BCI Lider «Estado de Cuenta» (the card facturación) out of Gmail into `cfraser/inbox/`.
 *
 * The bank mails the monthly statement from estadodecuenta@correo.tarjetaliderbci.cl (subject
 * «Estado de Cuenta Tarjeta Lider Bci Visa») a day or two after the ~26th close. The statement is
 * a PDF attachment encrypted with the RUT's last 4 digits — the inbox pipeline's qpdf-decrypt step
 * (`LIDER_CC_STATEMENT_PDF_PASSWORD`) handles that — and some months the mail also carries an
 * «Inserto Seguros.pdf» insurance insert that must NEVER reach the inbox: the organizer fails the
 * whole pipeline on a PDF with no statement text. The statement is the attachment whose filename
 * is a bare number, and that filter is a hard expectation — any other attachment shape is an
 * ERROR (non-zero exit), never a guess, so a template change surfaces as a failed step instead of
 * a silently missing facturación.
 *
 * UNLIKE santanderDocs, the ledger key is the mail date + message id, NOT the attachment
 * filename: BCI reuses the SAME filename every month (`155028273.pdf` in Jun, Jul and Aug 2026 —
 * a client number, not a document number), so a filename key would mark the first month as
 * fetched and silently skip every one after it. Each month is its own mail, which makes the
 * message id a stable per-document identity (the boleta rule). The saved inbox name is
 * date-prefixed for the same reason; the organizer renames it canonically from the PDF's own
 * statement date either way, so downstream is unchanged.
 *
 * No `--all` backfill on purpose: the historical closes are already imported from manually saved
 * copies under other filenames, and a second copy of a close makes the incremental import
 * ping-pong the statement row between source names (see PARSERS.md, 2026-08-10).
 */
import fs from "node:fs";
import path from "node:path";
import { ImapFlow } from "imapflow";
import type { FetchMessageObject } from "imapflow";
import { readKeychainSecret } from "../keychain.js";
import { ensureDir, resolveInboxDir } from "../paths.js";
import { log, logStep } from "../log.js";
import { hasDocument, recordDocument } from "../documentLedger.js";
import { loadBrokerEmailConfig } from "./fetch.js";
import {
  mailDocumentLedgerKey,
  normalizeMailSubject,
  pdfAttachmentsFromStructure,
  safeAttachmentName,
} from "./santanderDocs.js";

export const LIDER_STATEMENT_SENDER = "estadodecuenta@correo.tarjetaliderbci.cl";

/** How far back to look; the ledger bounds the rest. Covers one missed month plus mail lag. */
const DEFAULT_WINDOW_DAYS = 45;

export function isLiderStatementSubject(subject: string): boolean {
  const s = normalizeMailSubject(subject);
  return s.includes("estado de cuenta") && s.includes("lider");
}

/** The statement is the bare-number attachment; anything with a name («Inserto Seguros.pdf») is an insert. */
export function isLiderStatementAttachmentName(filename: string): boolean {
  return /^\d+\.pdf$/i.test(String(filename ?? "").trim());
}

/** `2026-08-28-<msgid slug>` — same shape as the boleta staging key, and for the same reason. */
export function liderStatementLedgerKey(date: Date, messageId: string): string {
  return mailDocumentLedgerKey(date, messageId);
}

export type LiderStatementFetchResult = {
  saved: { key: string; file: string }[];
  skipped: { key: string; reason: string }[];
  /** Non-empty means the mail's attachment shape is unmapped — the run must fail loudly. */
  errors: { key: string; reason: string }[];
};

export async function fetchLiderStatementEmails(opts?: {
  windowDays?: number;
  /** List what would be downloaded without writing anything or touching the ledger. */
  dryRun?: boolean;
}): Promise<LiderStatementFetchResult> {
  const config = loadBrokerEmailConfig();
  const password = readKeychainSecret(config.keychain_service, config.address);
  const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const dryRun = opts?.dryRun === true;

  logStep(`e-mail — Lider statement since ${since.toISOString().slice(0, 10)}${dryRun ? " (dry run)" : ""}`);

  const result: LiderStatementFetchResult = { saved: [], skipped: [], errors: [] };
  const inbox = dryRun ? null : ensureDir(resolveInboxDir());

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
      const uids = await client.search({ from: LIDER_STATEMENT_SENDER, since });
      if (!uids || uids.length === 0) {
        log("e-mail: no Lider statement mail in window");
        return result;
      }

      const candidates: { uid: number; msg: FetchMessageObject }[] = [];
      for await (const msg of client.fetch(uids, { envelope: true, bodyStructure: true, uid: true })) {
        if (!isLiderStatementSubject(String(msg.envelope?.subject ?? ""))) continue;
        candidates.push({ uid: msg.uid, msg });
      }

      for (const candidate of candidates) {
        const messageId = String(candidate.msg.envelope?.messageId ?? `uid-${candidate.uid}`);
        const mailDate = candidate.msg.envelope?.date ?? new Date();
        const key = liderStatementLedgerKey(mailDate, messageId);
        if (hasDocument("lider", "email-cc-statement", key)) {
          result.skipped.push({ key, reason: "already fetched" });
          continue;
        }

        const attachments = pdfAttachmentsFromStructure(candidate.msg.bodyStructure);
        const statements = attachments.filter((a) => isLiderStatementAttachmentName(a.filename));
        if (statements.length !== 1) {
          result.errors.push({
            key,
            reason: `expected exactly one bare-number statement pdf, got [${
              attachments.map((a) => a.filename).join(", ") || "no pdf attachments"
            }]`,
          });
          continue;
        }

        const ymd = mailDate.toISOString().slice(0, 10);
        const name = `${ymd} ${safeAttachmentName(statements[0]!.filename, "lider-estado-de-cuenta.pdf")}`;
        if (dryRun) {
          result.saved.push({ key, file: name });
          continue;
        }

        const download = await client.download(String(candidate.uid), statements[0]!.part, { uid: true });
        const chunks: Buffer[] = [];
        for await (const chunk of download.content) chunks.push(Buffer.from(chunk));
        const target = path.join(inbox!, name);
        // Same rule as santanderDocs: a file still sitting in the inbox has not been imported
        // yet — same bytes, and overwriting would only race the importer that may be reading it.
        if (fs.existsSync(target)) {
          result.skipped.push({ key, reason: `${name} already in inbox` });
        } else {
          fs.writeFileSync(target, Buffer.concat(chunks));
          result.saved.push({ key, file: name });
        }
        // Recorded whether it was written or already in the inbox: either way we have it.
        recordDocument("lider", "email-cc-statement", key);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  for (const s of result.saved) log(`e-mail: lider statement ${s.key} → ${s.file}`);
  const alreadyCount = result.skipped.filter((s) => s.reason === "already fetched").length;
  for (const s of result.skipped) {
    if (s.reason !== "already fetched") log(`e-mail: lider statement ${s.key} skipped (${s.reason})`);
  }
  if (alreadyCount > 0) log(`e-mail: ${alreadyCount} statement mail(s) already fetched`);
  for (const e of result.errors) log(`e-mail: lider statement ${e.key} ERROR (${e.reason})`);
  if (result.saved.length === 0 && result.errors.length === 0) log("e-mail: no new Lider statement");
  return result;
}
