import { describe, expect, it } from "vitest";
import { statementsDue } from "./statementSchedule.js";

const active = { account: "800099990001", extracto: "023", next_close: "2026-10-26" };
const dormant = { account: "800099990002", extracto: "105", next_close: "2025-12-22" };

describe("statementsDue", () => {
  it("waits for the announced close", () => {
    expect(statementsDue([active, dormant], "2026-10-05")).toEqual({
      due: false,
      reason: "no statement due: …0001 closes 2026-10-26",
    });
  });

  it("is due from the close until a newer statement announces the next one, then gives up on a silent card", () => {
    expect(statementsDue([active], "2026-10-26").due).toBe(true);
    expect(statementsDue([active], "2026-11-05").due).toBe(true);
    expect(statementsDue([active], "2026-11-06").due).toBe(false);
    expect(statementsDue([{ ...active, extracto: "024", next_close: "2026-11-24" }], "2026-10-27").due).toBe(false);
  });

  it("is due when nothing is staged or a statement announces no close", () => {
    expect(statementsDue([], "2026-10-05").due).toBe(true);
    expect(statementsDue([{ ...active, next_close: null }], "2026-10-05").due).toBe(true);
  });
});
