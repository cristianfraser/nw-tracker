/**
 * A sign-in's second factor mailed to the user: wait for the code mail a request asked for and read
 * its code. Only a mail that arrived AFTER the request (with `CODE_MAIL_SLACK_MS` of slack for
 * clocks) is this run's, and the newest such mail wins (a retry mails a new code). Once nothing newer
 * has arrived for `REUSED_CODE_ACCEPT_AFTER_MS`, the newest code mailed inside the code's validity
 * before the request is taken (a service may re-use a still-valid code without mailing again); a
 * code that has expired after all is rejected by the page, loudly.
 *
 * The mailbox is the same Gmail the broker-mail poll reads (`cfraser/email-fetch.json`, Keychain
 * `nw-tracker-gmail`); nothing is written, marked or moved. The code itself is never logged.
 */
import { loadBrokerEmailConfig } from "./fetch.js";
import { withImapSession } from "./imapSession.js";
import { searchSinceCandidates } from "./mailFetcher.js";
import { mimeBodyToText } from "./mime.js";
import { log } from "../log.js";

/** A mail this much older than the request still counts: clocks, and the request time is taken after the click. */
export const CODE_MAIL_SLACK_MS = 90_000;
export const REUSED_CODE_ACCEPT_AFTER_MS = 30_000;

type MimeNode = { part?: string; type?: string; encoding?: string; childNodes?: MimeNode[] };

/** The HTML part of a message (else its plain-text part), with its transfer encoding; null for a single-part body. */
export function textPartOf(node: MimeNode): { part: string; encoding: string } | null {
  const leaves: MimeNode[] = [];
  const walk = (n: MimeNode) => (n.childNodes?.length ? n.childNodes.forEach(walk) : leaves.push(n));
  walk(node);
  if (!node.childNodes?.length) return null;
  const pick = leaves.find((l) => /^text\/html$/i.test(l.type ?? "")) ?? leaves.find((l) => /^text\/plain$/i.test(l.type ?? ""));
  return pick?.part ? { part: pick.part, encoding: String(pick.encoding ?? "").toLowerCase() } : null;
}

/** A fetched part as text: base64 decoded here, quoted-printable left to `mimeBodyToText`. */
export function decodeTransfer(body: Buffer, encoding: string): string {
  return encoding === "base64" ? Buffer.from(body.toString("ascii"), "base64").toString("utf8") : body.toString("utf8");
}

export type CodeMail = { subject: string; text: string; receivedAt: Date };

export type CodeMailSpec = {
  /** The sender, as IMAP FROM matches it. */
  sender: string;
  /** The code mail's subject (other mails from the sender are ignored). */
  subject: RegExp;
  /** The code in a mail's text (as `mimeBodyToText` renders it), or null when the text is not one. */
  extractCode: (text: string) => string | null;
};

/** The newest code mailed for a request made at `requestedAt`, or null while none has arrived. */
export function pickMailedCode(
  spec: Pick<CodeMailSpec, "subject" | "extractCode">,
  mails: CodeMail[],
  requestedAt: Date,
  slackMs = CODE_MAIL_SLACK_MS
): { code: string; receivedAt: Date } | null {
  const floor = requestedAt.getTime() - slackMs;
  const candidates = mails
    .filter((m) => spec.subject.test(m.subject) && m.receivedAt.getTime() >= floor)
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  for (const m of candidates) {
    const code = spec.extractCode(m.text);
    if (code) return { code, receivedAt: m.receivedAt };
  }
  return null;
}

/**
 * Poll the mailbox until the code for a request made at `requestedAt` arrives. Throws after
 * `timeoutMs` (default 180 s).
 */
export async function waitForMailedCode(
  opts: CodeMailSpec & {
    /** Service name for the log. */
    label: string;
    requestedAt: Date;
    /** How long a mailed code stays valid (the reuse window). */
    validityMs: number;
    timeoutMs?: number;
    pollMs?: number;
  }
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const pollMs = opts.pollMs ?? 5_000;
  const config = loadBrokerEmailConfig();
  // Outside the session: a rerun after a dropped connection keeps the original wait.
  const started = Date.now();
  const deadline = started + timeoutMs;
  log(`${opts.label}: waiting for the code mail (${config.address}, up to ${Math.round(timeoutMs / 1000)} s)`);
  return withImapSession(`${opts.label} code`, async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      for (;;) {
        await client.noop().catch(() => undefined);
        let uids: number[] = [];
        for (const since of searchSinceCandidates(opts.requestedAt)) {
          const found = await client.search({ from: opts.sender, since });
          if (Array.isArray(found) && found.length > 0) {
            uids = found;
            break;
          }
        }
        const mails: CodeMail[] = [];
        if (uids.length > 0) {
          const recent = uids.slice(-5);
          // The body part is located through the structure (a multipart container around one
          // base64 HTML part, for ClaveÚnica) and decoded by its own transfer encoding.
          const heads: { seq: number; subject: string; receivedAt: Date; part: string; encoding: string }[] = [];
          for await (const msg of client.fetch(recent, { envelope: true, internalDate: true, bodyStructure: true })) {
            const located = msg.bodyStructure ? textPartOf(msg.bodyStructure as MimeNode) : null;
            heads.push({
              seq: msg.seq,
              subject: String(msg.envelope?.subject ?? ""),
              receivedAt: new Date(msg.internalDate ?? msg.envelope?.date ?? 0),
              part: located?.part ?? "text",
              encoding: located?.encoding ?? "",
            });
          }
          for (const h of heads) {
            if (!opts.subject.test(h.subject)) continue;
            const msg = await client.fetchOne(String(h.seq), { bodyParts: [h.part] });
            const body = (msg ? msg.bodyParts?.get(h.part) : undefined) ?? Buffer.alloc(0);
            mails.push({ subject: h.subject, text: mimeBodyToText(decodeTransfer(body, h.encoding), 20_000), receivedAt: h.receivedAt });
          }
        }
        const waitedMs = Date.now() - started;
        const picked =
          pickMailedCode(opts, mails, opts.requestedAt) ??
          (waitedMs >= REUSED_CODE_ACCEPT_AFTER_MS ? pickMailedCode(opts, mails, opts.requestedAt, opts.validityMs) : null);
        if (picked) {
          const reused = picked.receivedAt.getTime() < opts.requestedAt.getTime() - CODE_MAIL_SLACK_MS;
          log(`${opts.label}: code mail received at ${picked.receivedAt.toISOString()}${reused ? " (before this request — a still-valid code re-used)" : ""}`);
          return picked.code;
        }
        if (Date.now() >= deadline) throw new Error(`${opts.label}: no code mail from ${opts.sender} arrived within ${Math.round(timeoutMs / 1000)} s of the request`);
        await new Promise((r) => setTimeout(r, pollMs));
      }
    } finally {
      lock.release();
    }
  });
}
