import { describe, expect, it } from "vitest";
import { INGEST_RUN_STEP_NOTICES_MAX, ingestRunCompletionSchema, ingestRunStepSchema } from "./runs.js";

describe("ingestRunStepSchema notices", () => {
  it("accepts a step without notices (an older feeder) and one with them, passed or failed", () => {
    expect(ingestRunStepSchema.safeParse({ label: "inbox pipeline", ok: true, seconds: 3 }).success).toBe(true);
    expect(ingestRunStepSchema.safeParse({ label: "inbox pipeline", ok: true, seconds: 3, notices: ["Held, not imported: A.pdf"] }).success).toBe(true);
    expect(
      ingestRunStepSchema.safeParse({ label: "inbox pipeline", ok: false, seconds: 3, problems: ["x"], notices: ["Held, not imported: A.pdf"] }).success
    ).toBe(true);
  });

  it("refuses an empty notice, an overlong one and more than the bound", () => {
    const step = (notices: unknown) => ingestRunStepSchema.safeParse({ label: "inbox pipeline", ok: true, seconds: 3, notices }).success;
    expect(step([""])).toBe(false);
    expect(step(["x".repeat(1001)])).toBe(false);
    expect(step(Array.from({ length: INGEST_RUN_STEP_NOTICES_MAX + 1 }, (_, i) => `n${i}`))).toBe(false);
    expect(step("Held, not imported: A.pdf")).toBe(false);
  });

  it("carries the notices through a run report", () => {
    const report = ingestRunCompletionSchema.parse({
      started_at: "2026-11-27T01:00:00Z",
      finished_at: "2026-11-27T01:10:00Z",
      exit_code: 0,
      steps: [{ label: "inbox pipeline", ok: true, seconds: 3, notices: ["Held, not imported: A.pdf"] }],
      dry_run: false,
      activity: false,
      santander: null,
      santander_state: { last_attempt_at: null, last_success_at: null, login_latched: false },
    });
    expect(report.steps?.[0]?.notices).toEqual(["Held, not imported: A.pdf"]);
  });
});
