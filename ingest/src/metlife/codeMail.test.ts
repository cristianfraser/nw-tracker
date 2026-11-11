import { describe, expect, it } from "vitest";
import { pickMailedCode } from "../email/codeMail.js";
import { mimeBodyToText } from "../email/mime.js";
import { extractMetlifeCode, METLIFE_CODE_SUBJECT } from "./codeMail.js";

// A synthetic rendering of the mail's HTML (layout guessed from the user's description; code synthetic).
const HTML =
  '<html><head><style>.x{width:600px}</style></head><body><img src="logo.png" width="180" height="48">' +
  "<p>Estimado cliente:</p><p>Recibimos una solicitud de acceso. Tu Clave Din&aacute;mica es el siguiente c&oacute;digo, " +
  "ingr&eacute;salo para confirmar tu identidad.</p><p><span style=\"font-size:24px\"><b>482913</b></span></p>" +
  "<p>Este c&oacute;digo caducar&aacute; en 15 minutos.</p><p>Si no solicitaste este c&oacute;digo, ll&aacute;manos al 6003903000.</p>" +
  '<img src="footer.png" width="600" height="100000"></body></html>';
const SUBJECT = "Solicitud de código de acceso temporal de MetLife";

describe("extractMetlifeCode", () => {
  it("reads the code after «Clave Dinámica … identidad.»", () => {
    expect(extractMetlifeCode(mimeBodyToText(HTML, 20_000))).toBe("482913");
  });
  it("tolerates a lost accent and Gmail's bold marks", () => {
    expect(extractMetlifeCode("Tu Clave Din mica … para confirmar tu identidad.\n\n**482913**\n\nEste código caducará en 15 minutos.")).toBe("482913");
  });
  it("never takes the phone number or other digits", () => {
    expect(extractMetlifeCode("Clave Dinámica para confirmar tu identidad. Llámanos al 6003903000")).toBeNull();
    expect(extractMetlifeCode("Imagen 600 100000 Llámanos al 6003903000")).toBeNull();
  });
});

describe("pickMailedCode with the MetLife spec", () => {
  const spec = { subject: METLIFE_CODE_SUBJECT, extractCode: extractMetlifeCode };
  const requestedAt = new Date("2030-01-10T12:00:00Z");
  const mail = (minutes: number, code: string) => ({
    subject: SUBJECT,
    text: mimeBodyToText(HTML.replace("482913", code), 20_000),
    receivedAt: new Date(requestedAt.getTime() + minutes * 60_000),
  });
  it("takes the newest code mailed after the request", () => {
    expect(pickMailedCode(spec, [mail(-30, "111111"), mail(1, "222222"), mail(2, "333333")], requestedAt)?.code).toBe("333333");
  });
  it("takes a code from before the request only within the validity window", () => {
    expect(pickMailedCode(spec, [mail(-10, "444444")], requestedAt)).toBeNull();
    expect(pickMailedCode(spec, [mail(-10, "444444")], requestedAt, 15 * 60_000)?.code).toBe("444444");
  });
});
