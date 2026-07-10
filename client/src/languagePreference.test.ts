import { describe, expect, it } from "vitest";
import { languageFromNavigatorLanguage } from "./languagePreference";

describe("languageFromNavigatorLanguage", () => {
  it("Spanish browser languages get es", () => {
    expect(languageFromNavigatorLanguage("es")).toBe("es");
    expect(languageFromNavigatorLanguage("es-CL")).toBe("es");
    expect(languageFromNavigatorLanguage("es-419")).toBe("es");
    expect(languageFromNavigatorLanguage("ES-MX")).toBe("es");
  });

  it("everything else gets en", () => {
    expect(languageFromNavigatorLanguage("en-US")).toBe("en");
    expect(languageFromNavigatorLanguage("en-GB")).toBe("en");
    expect(languageFromNavigatorLanguage("de-DE")).toBe("en");
    expect(languageFromNavigatorLanguage("pt-BR")).toBe("en");
  });

  it("missing navigator language falls back to es (app's home locale)", () => {
    expect(languageFromNavigatorLanguage(undefined)).toBe("es");
    expect(languageFromNavigatorLanguage(null)).toBe("es");
    expect(languageFromNavigatorLanguage("")).toBe("es");
  });

  it("does not misclassify non-Spanish languages starting with 'e'", () => {
    expect(languageFromNavigatorLanguage("et-EE")).toBe("en");
    expect(languageFromNavigatorLanguage("eu-ES")).toBe("en");
  });
});
