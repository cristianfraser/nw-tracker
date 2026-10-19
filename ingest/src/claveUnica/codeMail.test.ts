import { describe, expect, it } from "vitest";
import { extractClaveUnicaCode, pickClaveUnicaCode } from "./codeMail.js";

// The mail as `mimeBodyToText` renders it (tags stripped, whitespace collapsed); the code is synthetic.
const BODY =
  "ClaveÚnica Código de validación de autenticación Hola Persona De Prueba, Recibimos una solicitud de " +
  "autenticación con ClaveÚnica. Para continuar debes ingresar el siguiente código y así acceder a la " +
  "plataforma solicitada: 7QX2ZK Te recordamos que este código tiene una vigencia de 5 minutos, pasado " +
  "ese tiempo debes solicitar uno nuevo. Si no has sido tú quien realizó esta solicitud, llámanos al 600 360 33 03.";
const SUBJECT = "ClaveÚnica - Código de validación de autenticación";

describe("extractClaveUnicaCode", () => {
  it("reads the code after «plataforma solicitada»", () => {
    expect(extractClaveUnicaCode(BODY)).toBe("7QX2ZK");
  });
  it("tolerates Gmail's markdown heading marks and line breaks", () => {
    expect(extractClaveUnicaCode("… la plataforma solicitada:\n\n## 7QX2ZK\n\nTe recordamos …")).toBe("7QX2ZK");
  });
  it("is null on any other mail", () => {
    expect(extractClaveUnicaCode("Tu sesión en ClaveÚnica fue cerrada.")).toBeNull();
    expect(extractClaveUnicaCode("plataforma solicitada: ABCDEFG más texto")).toBeNull();
  });
});

describe("pickClaveUnicaCode", () => {
  const requestedAt = new Date("2030-01-10T12:00:00Z");
  const mail = (minutesFromRequest: number, code: string, subject = SUBJECT) => ({
    subject,
    text: BODY.replace("7QX2ZK", code),
    receivedAt: new Date(requestedAt.getTime() + minutesFromRequest * 60_000),
  });
  it("takes the newest code mailed after the request", () => {
    expect(pickClaveUnicaCode([mail(-30, "OLD001"), mail(1, "NEW001"), mail(2, "NEW002")], requestedAt)?.code).toBe("NEW002");
  });
  it("ignores codes from before the request (another service's sign-in) and other subjects", () => {
    expect(pickClaveUnicaCode([mail(-30, "OLD001"), mail(1, "XXXXXX", "ClaveÚnica - Inicio de sesión")], requestedAt)).toBeNull();
  });
  it("takes a still-valid code from before the request when asked with the validity window", () => {
    expect(pickClaveUnicaCode([mail(-4, "REUSE1")], requestedAt, 5 * 60_000)?.code).toBe("REUSE1");
    expect(pickClaveUnicaCode([mail(-6, "OLD001")], requestedAt, 5 * 60_000)).toBeNull();
  });
  it("allows a mail stamped slightly before the request time", () => {
    expect(pickClaveUnicaCode([mail(-1, "EARLY1")], requestedAt)?.code).toBe("EARLY1");
  });
});
