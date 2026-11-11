import { describe, expect, it } from "vitest";
import { isMetlifePortalUrl, metlifeLoginStage, metlifeRejection, metlifeRutForLogin } from "./login.js";

const PING = "https://federate.sso.metlife.com/as/abc/resume/as/authorization.ping";

describe("MetLife sign-in", () => {
  it("types the RUT without dots or dash, the verifier kept", () => {
    expect(metlifeRutForLogin("12.345.678-9")).toBe("123456789");
    expect(metlifeRutForLogin("7.654.321-k")).toBe("7654321K");
    expect(() => metlifeRutForLogin("not a rut")).toThrow(/not a RUT/);
  });

  it("knows the portal from its login route", () => {
    expect(isMetlifePortalUrl("https://portaldeclientes.metlife.cl/PIP/centroDePago/centroDePago")).toBe(true);
    expect(isMetlifePortalUrl("https://portaldeclientes.metlife.cl/PIP/login")).toBe(false);
    expect(isMetlifePortalUrl("https://portaldeclientes.metlife.cl/?code=abc")).toBe(false);
    expect(isMetlifePortalUrl("https://portaldeclientes.metlife.cl.example.com/PIP/x")).toBe(false);
    expect(isMetlifePortalUrl(PING)).toBe(false);
  });

  it("tells the steps apart by their text", () => {
    expect(metlifeLoginStage(PING, "¡Hola!\nIngresa tu RUT y Clave de Acceso para entrar a tu cuenta.\nCONTINUAR")).toBe("credentials");
    expect(metlifeLoginStage(PING, "Valida tu identidad para continuar\nElige dónde recibir tu clave:\nRECIBIR CLAVE POR EMAIL\nSIGUIENTE")).toBe("channel");
    expect(metlifeLoginStage(PING, "¡Tu Clave Dinámica fue enviada!\nVALIDAR CLAVE\nTu clave expirará en\n15:00")).toBe("code");
    expect(metlifeLoginStage("https://portaldeclientes.metlife.cl/PIP/home", "")).toBe("portal");
    expect(metlifeLoginStage(PING, "")).toBe("unknown");
  });

  it("quotes a refusal, and not the pages' own help text", () => {
    const credentials = "¡Hola!\nIngresa tu RUT y Clave de Acceso para entrar a tu cuenta.\n¿Olvidaste tu clave o no tienes una?\nObtén aquí una Clave de Acceso";
    expect(metlifeRejection("credentials", credentials)).toBeNull();
    expect(metlifeRejection("credentials", `${credentials}\nRUT o clave incorrectos`)).toBe("RUT o clave incorrectos");
    const code = "¡Tu Clave Dinámica fue enviada!\nTu clave expirará en\n15:00\nPuedes solicitar la clave hasta 3 veces. Verifica antes de validar.";
    expect(metlifeRejection("code", code)).toBeNull();
    expect(metlifeRejection("code", `${code}\nLa clave ingresada es inválida`)).toBe("La clave ingresada es inválida");
    expect(metlifeRejection("channel", "incorrecto")).toBeNull();
  });
});
