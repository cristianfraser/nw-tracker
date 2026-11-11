/**
 * ClaveÚnica's second factor is a 6-character code mailed by `no-reply@digital.gob.cl`
 * («ClaveÚnica - Código de validación de autenticación», valid 5 minutes). Many services sign in
 * through ClaveÚnica, so the mailbox holds hundreds of these: only a mail that arrived AFTER this
 * run asked for its code is this run's, and the newest such mail wins (a retry mails a new code).
 * The mailbox polling is the generic `../email/codeMail.ts`.
 */
import { CODE_MAIL_SLACK_MS, pickMailedCode, waitForMailedCode, type CodeMail } from "../email/codeMail.js";

export { CODE_MAIL_SLACK_MS, REUSED_CODE_ACCEPT_AFTER_MS, decodeTransfer, textPartOf, type CodeMail } from "../email/codeMail.js";

export const CLAVE_UNICA_CODE_SENDER = "no-reply@digital.gob.cl";
export const CLAVE_UNICA_CODE_SUBJECT = /c[oó]digo de validaci[oó]n/i;
/** The code is printed right after this phrase (Gmail's text rendering puts «## » before it). */
const CODE_IN_BODY = /plataforma solicitada:?\s*#*\s*([A-Z0-9]{6})(?![A-Za-z0-9])/;
/**
 * A code is valid 5 minutes, and ClaveÚnica re-uses a still-valid one for a new sign-in without
 * mailing again (2026-10-17: a retry 5 minutes after the first attempt got no second mail).
 */
export const CODE_VALIDITY_MS = 5 * 60_000;

/** The code printed in a ClaveÚnica code mail's text, or null when the text is not one. */
export function extractClaveUnicaCode(text: string): string | null {
  const m = CODE_IN_BODY.exec(text.replace(/\s+/g, " "));
  return m ? m[1]! : null;
}

const SPEC = { sender: CLAVE_UNICA_CODE_SENDER, subject: CLAVE_UNICA_CODE_SUBJECT, extractCode: extractClaveUnicaCode };

/** The newest code mailed for a request made at `requestedAt`, or null while none has arrived. */
export function pickClaveUnicaCode(mails: CodeMail[], requestedAt: Date, slackMs = CODE_MAIL_SLACK_MS): { code: string; receivedAt: Date } | null {
  return pickMailedCode(SPEC, mails, requestedAt, slackMs);
}

/**
 * Poll the mailbox until the code for a request made at `requestedAt` arrives. Throws after
 * `timeoutMs` (the code itself expires in 5 minutes, so waiting longer is pointless).
 */
export async function waitForClaveUnicaCode(opts: { requestedAt: Date; timeoutMs?: number; pollMs?: number }): Promise<string> {
  return waitForMailedCode({ ...SPEC, label: "ClaveÚnica", validityMs: CODE_VALIDITY_MS, ...opts });
}
