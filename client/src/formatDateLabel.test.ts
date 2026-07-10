import { afterAll, describe, expect, it } from "vitest";
import i18n from "./i18n";
import {
  formatDateTimeLabel,
  formatMonthYearShortLabel,
  formatYearMonthLabel,
} from "./formatDateLabel";

afterAll(async () => {
  await i18n.changeLanguage("es");
});

describe("formatYearMonthLabel", () => {
  it("renders Spanish month names in es (node default language)", () => {
    expect(i18n.language).toBe("es");
    expect(formatYearMonthLabel("2026-12")).toBe("dic 2026");
    expect(formatYearMonthLabel("2026-09")).toBe("sep 2026");
    expect(formatYearMonthLabel("2026-01")).toBe("ene 2026");
  });

  it("renders English month names in en", async () => {
    await i18n.changeLanguage("en");
    expect(formatYearMonthLabel("2026-12")).toBe("Dec 2026");
    expect(formatYearMonthLabel("2026-09")).toBe("Sep 2026");
    await i18n.changeLanguage("es");
  });

  it("returns malformed input unchanged", () => {
    expect(formatYearMonthLabel("2026-13")).toBe("2026-13");
    expect(formatYearMonthLabel("garbage")).toBe("garbage");
  });
});

describe("formatMonthYearShortLabel", () => {
  it("formats YYYY-MM-DD and YYYY-MM to month + 2-digit year", () => {
    expect(formatMonthYearShortLabel("2016-12-31")).toBe("dic 16");
    expect(formatMonthYearShortLabel("2026-07")).toBe("jul 26");
  });

  it("follows the language", async () => {
    await i18n.changeLanguage("en");
    expect(formatMonthYearShortLabel("2016-12-31")).toBe("Dec 16");
    await i18n.changeLanguage("es");
  });

  it("returns non-date input unchanged (year granularity handled by caller)", () => {
    expect(formatMonthYearShortLabel("2026")).toBe("2026");
    expect(formatMonthYearShortLabel("2026-00-01")).toBe("2026-00-01");
  });
});

describe("formatDateTimeLabel", () => {
  it("renders local-time ISO date + HH:MM, language-independent", () => {
    const d = new Date(2026, 6, 9, 14, 5); // local time
    expect(formatDateTimeLabel(d)).toBe("2026-07-09 14:05");
  });
});
