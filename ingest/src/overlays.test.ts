import { describe, expect, it } from "vitest";
import { isCloseControl, overlayBlocks } from "./overlays.js";

const control = (c: Partial<Parameters<typeof isCloseControl>[0]>) => ({ text: "", ariaLabel: null, title: null, className: null, ...c });

describe("isCloseControl", () => {
  it("takes a dialog's own close controls", () => {
    expect(isCloseControl(control({ ariaLabel: "Cerrar" }))).toBe(true);
    expect(isCloseControl(control({ ariaLabel: "Cerrar modal" }))).toBe(true);
    expect(isCloseControl(control({ ariaLabel: "close dialog" }))).toBe(true);
    expect(isCloseControl(control({ text: " × " }))).toBe(true);
    expect(isCloseControl(control({ text: "Entendido" }))).toBe(true);
    expect(isCloseControl(control({ text: "", className: "btn btn-close" }))).toBe(true);
    expect(isCloseControl(control({ text: "x", className: "modal__close-button" }))).toBe(true);
  });

  it("never takes a button that does something else", () => {
    expect(isCloseControl(control({ text: "Aceptar" }))).toBe(false);
    expect(isCloseControl(control({ text: "Continuar" }))).toBe(false);
    expect(isCloseControl(control({ text: "Pagar dividendo" }))).toBe(false);
    expect(isCloseControl(control({ text: "Cerrar sesión" }))).toBe(false);
    expect(isCloseControl(control({ ariaLabel: "Cerrar sesión" }))).toBe(false);
    expect(isCloseControl(control({ text: "Ver más", className: "close" }))).toBe(false);
    // A label wins over the text: a «Cerrar»-looking control labelled otherwise is not taken.
    expect(isCloseControl(control({ text: "×", ariaLabel: "Eliminar" }))).toBe(false);
  });
});

describe("overlayBlocks", () => {
  const vp = { width: 1000, height: 800 };
  it("blocks when covering the centre or most of the page", () => {
    expect(overlayBlocks({ x: 300, y: 200, width: 400, height: 300 }, vp)).toBe(true);
    expect(overlayBlocks({ x: 0, y: 0, width: 1000, height: 800 }, vp)).toBe(true);
    expect(overlayBlocks({ x: 0, y: 0, width: 1000, height: 380 }, vp)).toBe(true);
  });
  it("leaves a corner toast and a hidden box alone", () => {
    expect(overlayBlocks({ x: 700, y: 650, width: 280, height: 120 }, vp)).toBe(false);
    expect(overlayBlocks({ x: 0, y: 0, width: 0, height: 0 }, vp)).toBe(false);
  });
});
