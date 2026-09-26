import { afterEach, describe, expect, it } from "vitest";
import i18n from "./i18n";
import { flowPeriodLabel } from "./flowsDisplay";

afterEach(async () => {
  await i18n.changeLanguage("es");
});

describe("flowPeriodLabel", () => {
  it("names the month in the UI language at month grain", async () => {
    expect(i18n.language).toBe("es");
    expect(flowPeriodLabel("2026-12", "month")).toBe("dic 2026");
    await i18n.changeLanguage("en");
    expect(flowPeriodLabel("2026-12", "month")).toBe("Dec 2026");
  });

  it("labels a full ISO date by its month (the P/L table passes as_of_date)", async () => {
    expect(flowPeriodLabel("2026-01-31", "month")).toBe("ene 2026");
    await i18n.changeLanguage("en");
    expect(flowPeriodLabel("2026-01-31", "month")).toBe("Jan 2026");
  });

  it("keeps the year and day grains numeric in every language", async () => {
    await i18n.changeLanguage("en");
    expect(flowPeriodLabel("2026-12", "year")).toBe("2026");
    expect(flowPeriodLabel("2026-12-31", "year")).toBe("2026");
    expect(flowPeriodLabel("2026-12-31", "day")).toBe("2026-12-31");
  });
});
