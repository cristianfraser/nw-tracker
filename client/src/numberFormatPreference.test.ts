import { describe, expect, it } from "vitest";
import {
  decimalSeparatorFromTimeZone,
  numberLocaleForSeparator,
} from "./numberFormatPreference";

describe("decimalSeparatorFromTimeZone", () => {
  it("defaults to comma (Chile, Europe, rest of world)", () => {
    expect(decimalSeparatorFromTimeZone("America/Santiago")).toBe("comma");
    expect(decimalSeparatorFromTimeZone("America/Argentina/Buenos_Aires")).toBe("comma");
    expect(decimalSeparatorFromTimeZone("Europe/Madrid")).toBe("comma");
    expect(decimalSeparatorFromTimeZone("America/Sao_Paulo")).toBe("comma");
    expect(decimalSeparatorFromTimeZone(undefined)).toBe("comma");
    expect(decimalSeparatorFromTimeZone("")).toBe("comma");
  });

  it("US timezones get period", () => {
    expect(decimalSeparatorFromTimeZone("America/New_York")).toBe("period");
    expect(decimalSeparatorFromTimeZone("America/Los_Angeles")).toBe("period");
    expect(decimalSeparatorFromTimeZone("America/Indiana/Indianapolis")).toBe("period");
    expect(decimalSeparatorFromTimeZone("Pacific/Honolulu")).toBe("period");
    expect(decimalSeparatorFromTimeZone("US/Eastern")).toBe("period");
  });

  it("Mexico, Canada, and UK timezones get period", () => {
    expect(decimalSeparatorFromTimeZone("America/Mexico_City")).toBe("period");
    expect(decimalSeparatorFromTimeZone("America/Tijuana")).toBe("period");
    expect(decimalSeparatorFromTimeZone("America/Toronto")).toBe("period");
    expect(decimalSeparatorFromTimeZone("America/Vancouver")).toBe("period");
    expect(decimalSeparatorFromTimeZone("Europe/London")).toBe("period");
    expect(decimalSeparatorFromTimeZone("Canada/Pacific")).toBe("period");
  });

  it("does not misclassify other America/* zones sharing city-name prefixes", () => {
    expect(decimalSeparatorFromTimeZone("America/Lima")).toBe("comma");
    expect(decimalSeparatorFromTimeZone("America/Bogota")).toBe("comma");
    expect(decimalSeparatorFromTimeZone("America/Panama")).toBe("comma");
  });
});

describe("numberLocaleForSeparator", () => {
  it("maps comma → es-CL and period → en-US", () => {
    expect(numberLocaleForSeparator("comma")).toBe("es-CL");
    expect(numberLocaleForSeparator("period")).toBe("en-US");
  });
});
