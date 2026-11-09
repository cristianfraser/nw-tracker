import { describe, expect, it } from "vitest";
import { DEMO_TOUR_FIRST_VISIT_MS, demoTourShouldOpen } from "./DemoTour";

describe("demoTourShouldOpen", () => {
  const first = Date.parse("2026-11-07T12:00:00Z");

  it("opens on a first visit", () => {
    expect(demoTourShouldOpen(false, null, first)).toBe(true);
  });

  it("opens again on a reload inside the first day", () => {
    expect(demoTourShouldOpen(false, first, first + DEMO_TOUR_FIRST_VISIT_MS - 1)).toBe(true);
  });

  it("stays closed once the first day has passed", () => {
    expect(demoTourShouldOpen(false, first, first + DEMO_TOUR_FIRST_VISIT_MS)).toBe(false);
  });

  it("stays closed once dismissed, even inside the first day", () => {
    expect(demoTourShouldOpen(true, first, first + 1000)).toBe(false);
    expect(demoTourShouldOpen(true, null, first)).toBe(false);
  });
});
