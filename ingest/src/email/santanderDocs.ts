/**
 * Fetch Santander's monthly PDF documents out of Gmail into `cfraser/inbox/`.
 *
 * The bank mails both documents every month — «Estado de Cuenta Tarjeta de Crédito» (the credit
 * card facturación) and «Cartola Mensual de Cuentas.» (the cuenta corriente cartola) — and both
 * arrive as PDF attachments. Taking them from mail rather than the web session is strictly better:
 * the statement download endpoint has never once succeeded (Codigo 16 on every attempt), the
 * cartola download costs an extra authenticated navigation on a bank that is sensitive to traffic,
 * and mail needs no session, no 2FA and no window server.
 *
 * Attachments are saved under the bank's OWN filenames, which is the whole point — the inbox
 * organizer already recognises Santander's email attachment naming (`1_<seq>_<account>_<date>_CC.pdf`
 * for a cuenta corriente cartola, `_LC` for línea de crédito) and classifies credit-card statements
 * by peeking at the PDF text. So this step's entire contract is "put the file in the inbox"; every
 * downstream stage is unchanged.
 *
 * Once a month, not once a night: each attachment is gated in the document ledger under its own
 * bank-given FILENAME (`80_16448_<account>_20260723.pdf`), which carries the bank's sequence number
 * and the document date and is therefore a stable per-document identity. Keying on the month
 * instead would be wrong in a way that loses data silently: the credit-card facturación arrives as
 * TWO same-day mails — the CLP statement and the USD one — so the first would mark the month done
 * and its sibling would never be downloaded. Because each month brings fresh sequence numbers, the
 * filename key gives the intended once-a-month rhythm for free: due when the mail lands, retried
 * daily until it does, never fetched twice.
 */
import fs from "node:fs";
import path from "node:path";
import { ImapFlow } from "imapflow";
import type { FetchMessageObject, MessageStructureObject } from "imapflow";
import { readKeychainSecret } from "../keychain.js";
import { ensureDir, resolveInboxDir } from "../paths.js";
import { log, logStep } from "../log.js";
import { hasDocument, recordDocument } from "../documentLedger.js";
import { loadBrokerEmailConfig, mimeBodyToText } from "./fetch.js";
import { resolveCfraserDir } from "../paths.js";

export const SANTANDER_MAIL_SENDER = "mensajeria@santander.cl";

/** How far back to look when nothing has been recorded yet. The ledger bounds the rest. */
const DEFAULT_WINDOW_DAYS = 45;

export type SantanderMailDoc = {
  /** Document-ledger kind; also what the run summary calls it. */
  kind: string;
  label: string;
  matchesSubject: (normalizedSubject: string) => boolean;
};

export const SANTANDER_MAIL_DOCS: readonly SantanderMailDoc[] = [
  {
    kind: "email-cc-statement",
    label: "estado de cuenta tarjeta de crédito",
    matchesSubject: (s) => s.includes("estado de cuenta") && s.includes("tarjeta"),
  },
  {
    kind: "email-cartola",
    label: "cartola mensual de cuentas",
    matchesSubject: (s) => s.includes("cartola mensual"),
  },
] as const;

/**
 * Lowercase, unaccented, whitespace-collapsed.
 *
 * Subjects arrive MIME-encoded and the accents are exactly where a naive `includes` breaks
 * («Crédito»); matching on the unaccented form means a change in the bank's encoding cannot
 * silently stop the whole step.
 */
export function normalizeMailSubject(subject: string): string {
  return String(subject ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function classifySantanderMailSubject(subject: string): SantanderMailDoc | null {
  const normalized = normalizeMailSubject(subject);
  return SANTANDER_MAIL_DOCS.find((doc) => doc.matchesSubject(normalized)) ?? null;
}

/**
 * Credit-card payment receipt mails («Pago Deuda Nacional TCR», «Comprobante Pago (abono) de la
 * deuda facturada en dolares»). No attachment — the body text IS the document: it carries the
 * REAL payment date, which the checking ledger needs because the bank's movement feed dates
 * post-14:00 payments at the next workday. The body is staged verbatim for the server-side
 * parser (`santanderCcPaymentReceipts.ts`); nothing is interpreted here.
 */
export function isSantanderCcPaymentReceiptSubject(subject: string): boolean {
  const s = normalizeMailSubject(subject);
  if (s.includes("pago deuda") && s.includes("tcr")) return true;
  return s.includes("comprobante pago") && s.includes("deuda facturada");
}

export function receiptsStagingDir(): string {
  return path.join(resolveCfraserDir(), "santander-payment-receipts");
}

/** First text/html (or text/plain) body part of a message, for receipt mails. */
export function htmlBodyPartFromStructure(node: MessageStructureObject | undefined): string | null {
  if (!node) return null;
  let plain: string | null = null;
  let html: string | null = null;
  const walk = (n: MessageStructureObject): void => {
    const type = String(n.type ?? "").toLowerCase();
    if (n.part) {
      if (type === "text/html" && html == null) html = String(n.part);
      if (type === "text/plain" && plain == null) plain = String(n.part);
    }
    for (const child of n.childNodes ?? []) walk(child);
  };
  walk(node);
  // Single-part messages have no explicit part number; "TEXT" addresses the whole body.
  if (html == null && plain == null && String(node.type ?? "").toLowerCase().startsWith("text/")) {
    return "TEXT";
  }
  return html ?? plain;
}

/**
 * `2026-08-28-<msgid slug>` — a per-MAIL ledger key, for senders whose attachment names repeat
 * (BCI reuses `155028273.pdf` every month; Fintual's `cartola_mensual_agosto.pdf` comes back
 * every August). Each such document is its own mail, so the message id is the stable identity;
 * the date prefix keeps the ledger readable.
 */
export function mailDocumentLedgerKey(date: Date, messageId: string): string {
  const idSlug = String(messageId ?? "")
    .replace(/[^A-Za-z0-9@._-]/g, "_")
    .slice(0, 80);
  return `${date.toISOString().slice(0, 10)}-${idSlug}`;
}

/** Ledger period for a message: the Chile calendar month it was sent in. */
export function mailPeriodKey(date: Date): string {
  const chile = new Date(date.toLocaleString("en-US", { timeZone: "America/Santiago" }));
  return `${chile.getFullYear()}-${String(chile.getMonth() + 1).padStart(2, "0")}`;
}

type AttachmentNode = { part: string; filename: string };

/**
 * Every PDF attachment in a message body structure.
 *
 * These templates carry inline logos and a multipart alternative body; only nodes that actually
 * name a `.pdf` file are documents.
 */
export function pdfAttachmentsFromStructure(node: MessageStructureObject | undefined): AttachmentNode[] {
  if (!node) return [];
  const found: AttachmentNode[] = [];
  const walk = (n: MessageStructureObject): void => {
    const filename = String(n.dispositionParameters?.filename ?? n.parameters?.name ?? "").trim();
    if (filename.toLowerCase().endsWith(".pdf") && n.part) {
      found.push({ part: String(n.part), filename });
    }
    for (const child of n.childNodes ?? []) walk(child);
  };
  walk(node);
  return found;
}

/**
 * A filename that cannot escape the inbox.
 *
 * The name comes from an e-mail, so it is attacker-controllable in principle; anything with a path
 * separator is reduced to its basename and the rest is whitelisted.
 */
export function safeAttachmentName(filename: string, fallback: string): string {
  const base = path.basename(String(filename ?? "").replace(/\\/g, "/")).trim();
  const cleaned = base.replace(/[^A-Za-z0-9 ._-]/g, "_");
  if (!cleaned || cleaned.startsWith(".") || !cleaned.toLowerCase().endsWith(".pdf")) return fallback;
  return cleaned;
}

export type SantanderMailFetchResult = {
  saved: { kind: string; period: string; file: string }[];
  skipped: { kind: string; period: string; reason: string }[];
};

export async function fetchSantanderMailDocuments(opts?: {
  windowDays?: number;
  /** List what would be downloaded without writing anything or touching the ledger. */
  dryRun?: boolean;
}): Promise<SantanderMailFetchResult> {
  const config = loadBrokerEmailConfig();
  const password = readKeychainSecret(config.keychain_service, config.address);
  const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const dryRun = opts?.dryRun === true;

  logStep(`e-mail — Santander documents since ${since.toISOString().slice(0, 10)}${dryRun ? " (dry run)" : ""}`);

  const result: SantanderMailFetchResult = { saved: [], skipped: [] };
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
      const uids = await client.search({ from: SANTANDER_MAIL_SENDER, since });
      if (!uids || uids.length === 0) {
        log("e-mail: no Santander mail in window");
        return result;
      }

      const candidates: { uid: number; doc: SantanderMailDoc; period: string; msg: FetchMessageObject }[] = [];
      const receiptCandidates: { uid: number; period: string; msg: FetchMessageObject }[] = [];
      for await (const msg of client.fetch(uids, { envelope: true, bodyStructure: true, uid: true })) {
        const subject = String(msg.envelope?.subject ?? "");
        const doc = classifySantanderMailSubject(subject);
        if (doc) {
          candidates.push({ uid: msg.uid, doc, period: mailPeriodKey(msg.envelope?.date ?? new Date()), msg });
          continue;
        }
        if (isSantanderCcPaymentReceiptSubject(subject)) {
          receiptCandidates.push({ uid: msg.uid, period: mailPeriodKey(msg.envelope?.date ?? new Date()), msg });
        }
      }

      // CC payment receipts: stage {subject, date, text} JSON for `santander/paymentReceipts.ts`. The
      // ledger key is the message id — each payment is its own mail, so this is a stable
      // per-document identity (same rule as the attachment filenames below).
      for (const candidate of receiptCandidates) {
        const messageId = String(candidate.msg.envelope?.messageId ?? `uid-${candidate.uid}`);
        const fileKey = `receipt-${messageId.replace(/[^A-Za-z0-9@._-]/g, "_").slice(0, 120)}.json`;
        if (hasDocument("santander", "email-cc-payment-receipt", fileKey)) {
          result.skipped.push({ kind: "email-cc-payment-receipt", period: candidate.period, reason: `${fileKey} already fetched` });
          continue;
        }
        if (dryRun) {
          result.saved.push({ kind: "email-cc-payment-receipt", period: candidate.period, file: fileKey });
          continue;
        }
        const bodyPart = htmlBodyPartFromStructure(candidate.msg.bodyStructure);
        if (!bodyPart) {
          result.skipped.push({ kind: "email-cc-payment-receipt", period: candidate.period, reason: "no text body part" });
          continue;
        }
        const download = await client.download(String(candidate.uid), bodyPart === "TEXT" ? undefined : bodyPart, { uid: true });
        const chunks: Buffer[] = [];
        for await (const chunk of download.content) chunks.push(Buffer.from(chunk));
        const text = mimeBodyToText(Buffer.concat(chunks).toString("utf8"), 4000);
        const stagingDir = ensureDir(receiptsStagingDir());
        fs.writeFileSync(
          path.join(stagingDir, fileKey),
          JSON.stringify(
            {
              message_id: messageId,
              subject: String(candidate.msg.envelope?.subject ?? ""),
              date: (candidate.msg.envelope?.date ?? new Date()).toISOString(),
              text,
            },
            null,
            2
          )
        );
        recordDocument("santander", "email-cc-payment-receipt", fileKey);
        result.saved.push({ kind: "email-cc-payment-receipt", period: candidate.period, file: fileKey });
      }

      // Newest first, so when the bank sends the same document twice in a day the copy we keep is
      // the later one; the ledger then skips its twin.
      candidates.sort((a, b) => b.uid - a.uid);

      for (const candidate of candidates) {
        const { doc, period } = candidate;
        const attachments = pdfAttachmentsFromStructure(candidate.msg.bodyStructure);
        if (attachments.length === 0) {
          result.skipped.push({ kind: doc.kind, period, reason: "no pdf attachment" });
          continue;
        }
        for (const [index, attachment] of attachments.entries()) {
          const name = safeAttachmentName(attachment.filename, `santander-${doc.kind}-${period}-${index + 1}.pdf`);
          if (hasDocument("santander", doc.kind, name)) {
            result.skipped.push({ kind: doc.kind, period, reason: `${name} already fetched` });
            continue;
          }
          if (dryRun) {
            result.saved.push({ kind: doc.kind, period, file: name });
            continue;
          }
          const download = await client.download(String(candidate.uid), attachment.part, { uid: true });
          const chunks: Buffer[] = [];
          for await (const chunk of download.content) chunks.push(Buffer.from(chunk));
          const target = path.join(inbox!, name);
          // A file still sitting in the inbox has not been imported yet — same bytes, and
          // overwriting it would only race the importer that may already be reading it.
          if (fs.existsSync(target)) {
            result.skipped.push({ kind: doc.kind, period, reason: `${name} already in inbox` });
          } else {
            fs.writeFileSync(target, Buffer.concat(chunks));
            result.saved.push({ kind: doc.kind, period, file: name });
          }
          // Recorded whether it was written or already in the inbox: either way we have it.
          recordDocument("santander", doc.kind, name);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  for (const s of result.saved) log(`e-mail: ${s.kind} ${s.period} → ${s.file}`);
  for (const s of result.skipped) log(`e-mail: ${s.kind} ${s.period} skipped (${s.reason})`);
  if (result.saved.length === 0) log("e-mail: no new Santander document");
  return result;
}
