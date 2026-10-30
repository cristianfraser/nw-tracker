/**
 * ClaveÚnica's second factor is a 6-character code mailed by `no-reply@digital.gob.cl`
 * («ClaveÚnica - Código de validación de autenticación», valid 5 minutes). Many services sign in
 * through ClaveÚnica, so the mailbox holds hundreds of these: only a mail that arrived AFTER this
 * run asked for its code is this run's, and the newest such mail wins (a retry mails a new code).
 *
 * The mailbox is the same Gmail the broker-mail poll reads (`cfraser/email-fetch.json`, Keychain
 * `nw-tracker-gmail`); nothing is written, marked or moved.
 */
import { loadBrokerEmailConfig, mimeBodyToText, searchSinceCandidates } from "../email/fetch.js";
import { log } from "../log.js";
import { withImapSession } from "../email/imapSession.js";

export const CLAVE_UNICA_CODE_SENDER = "no-reply@digital.gob.cl";
export const CLAVE_UNICA_CODE_SUBJECT = /c[oó]digo de validaci[oó]n/i;
/** The code is printed right after this phrase (Gmail's text rendering puts «## » before it). */
const CODE_IN_BODY = /plataforma solicitada:?\s*#*\s*([A-Z0-9]{6})(?![A-Za-z0-9])/;
/** A mail this much older than the request still counts: clocks, and the request time is taken after the click. */
export const CODE_MAIL_SLACK_MS = 90_000;
/**
 * A code is valid 5 minutes, and ClaveÚnica re-uses a still-valid one for a new sign-in without
 * mailing again (2026-10-17: a retry 5 minutes after the first attempt got no second mail). So
 * once nothing newer has arrived for a while, the newest code mailed inside the validity window
 * before the request is taken; a code that has expired after all is rejected by the page, loudly.
 */
export const CODE_VALIDITY_MS = 5 * 60_000;
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

/** The code printed in a ClaveÚnica code mail's text, or null when the text is not one. */
export function extractClaveUnicaCode(text: string): string | null {
  const m = CODE_IN_BODY.exec(text.replace(/\s+/g, " "));
  return m ? m[1]! : null;
}

/** The newest code mailed for a request made at `requestedAt`, or null while none has arrived. */
export function pickClaveUnicaCode(mails: CodeMail[], requestedAt: Date, slackMs = CODE_MAIL_SLACK_MS): { code: string; receivedAt: Date } | null {
  const floor = requestedAt.getTime() - slackMs;
  const candidates = mails
    .filter((m) => CLAVE_UNICA_CODE_SUBJECT.test(m.subject) && m.receivedAt.getTime() >= floor)
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  for (const m of candidates) {
    const code = extractClaveUnicaCode(m.text);
    if (code) return { code, receivedAt: m.receivedAt };
  }
  return null;
}

/**
 * Poll the mailbox until the code for a request made at `requestedAt` arrives. Throws after
 * `timeoutMs` (the code itself expires in 5 minutes, so waiting longer is pointless).
 */
export async function waitForClaveUnicaCode(opts: { requestedAt: Date; timeoutMs?: number; pollMs?: number }): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const pollMs = opts.pollMs ?? 5_000;
  const config = loadBrokerEmailConfig();
  // Outside the session: a rerun after a dropped connection keeps the original wait.
  const started = Date.now();
  const deadline = started + timeoutMs;
  log(`ClaveÚnica: waiting for the code mail (${config.address}, up to ${Math.round(timeoutMs / 1000)} s)`);
  return withImapSession("ClaveÚnica code", async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      for (;;) {
        await client.noop().catch(() => undefined);
        let uids: number[] = [];
        for (const since of searchSinceCandidates(opts.requestedAt)) {
          const found = await client.search({ from: CLAVE_UNICA_CODE_SENDER, since });
          if (Array.isArray(found) && found.length > 0) {
            uids = found;
            break;
          }
        }
        const mails: CodeMail[] = [];
        if (uids.length > 0) {
          const recent = uids.slice(-5);
          // The mail is a multipart/mixed container around one base64 HTML part (2026-10-17), so the
          // part is located through the structure and decoded by its own transfer encoding.
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
            if (!CLAVE_UNICA_CODE_SUBJECT.test(h.subject)) continue;
            const msg = await client.fetchOne(String(h.seq), { bodyParts: [h.part] });
            const body = (msg ? msg.bodyParts?.get(h.part) : undefined) ?? Buffer.alloc(0);
            mails.push({ subject: h.subject, text: mimeBodyToText(decodeTransfer(body, h.encoding), 20_000), receivedAt: h.receivedAt });
          }
        }
        const waitedMs = Date.now() - started;
        const picked =
          pickClaveUnicaCode(mails, opts.requestedAt) ??
          (waitedMs >= REUSED_CODE_ACCEPT_AFTER_MS ? pickClaveUnicaCode(mails, opts.requestedAt, CODE_VALIDITY_MS) : null);
        if (picked) {
          const reused = picked.receivedAt.getTime() < opts.requestedAt.getTime() - CODE_MAIL_SLACK_MS;
          log(`ClaveÚnica: code mail received at ${picked.receivedAt.toISOString()}${reused ? " (before this request — a still-valid code re-used)" : ""}`);
          return picked.code;
        }
        if (Date.now() >= deadline) throw new Error(`ClaveÚnica: no code mail from ${CLAVE_UNICA_CODE_SENDER} arrived within ${Math.round(timeoutMs / 1000)} s of the request`);
        await new Promise((r) => setTimeout(r, pollMs));
      }
    } finally {
      lock.release();
    }
  });
}
