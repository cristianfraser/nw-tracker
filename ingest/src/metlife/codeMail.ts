/**
 * MetLife's second factor, the «Clave Dinámica»: a 6-digit code mailed by
 * `accessmanagement@metlife.com` («Solicitud de código de acceso temporal de MetLife»), printed in
 * bold right after the sentence that asks for it to confirm the user's identity, valid 15 minutes
 * («caducará en 15 minutos»). The mail carries other digits (image sizes, the 600 phone number), so
 * the code is read only where that sentence ends.
 */
import { waitForMailedCode } from "../email/codeMail.js";

export const METLIFE_CODE_SENDER = "accessmanagement@metlife.com";
export const METLIFE_CODE_SUBJECT = /c[oó]digo de acceso temporal/i;
export const METLIFE_CODE_VALIDITY_MS = 15 * 60_000;

/** «… Clave Dinámica … identidad.» then the code (accents may be lost to the text rendering). */
const CODE_IN_BODY = /Clave Din\S* ?mica\b.{0,400}?identidad\.?:?\s*\**\s*(\d{6})(?!\d)/i;

/** The code printed in a MetLife code mail's text, or null when the text is not one. */
export function extractMetlifeCode(text: string): string | null {
  const m = CODE_IN_BODY.exec(text.replace(/\s+/g, " "));
  return m ? m[1]! : null;
}

/** Poll the mailbox until the Clave Dinámica for a request made at `requestedAt` arrives. */
export async function waitForMetlifeCode(opts: { requestedAt: Date; timeoutMs?: number; pollMs?: number }): Promise<string> {
  return waitForMailedCode({
    sender: METLIFE_CODE_SENDER,
    subject: METLIFE_CODE_SUBJECT,
    extractCode: extractMetlifeCode,
    label: "MetLife",
    validityMs: METLIFE_CODE_VALIDITY_MS,
    ...opts,
  });
}
