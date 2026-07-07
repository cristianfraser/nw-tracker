import { describe, expect, it } from "vitest";
import { chileWallClockNow } from "./chileDate.js";
import type { GlobalSyncStateFile } from "./globalSyncState.js";
import { runSyncStep, runSyncStepIfStale, syncErrorMessage } from "./globalSyncStep.js";
import type { SyncStepError } from "./syncRunLog.js";

const cl = chileWallClockNow();

describe("syncErrorMessage", () => {
  it("uses Error messages and stringifies everything else", () => {
    expect(syncErrorMessage(new Error("boom"))).toBe("boom");
    expect(syncErrorMessage("raw")).toBe("raw");
    expect(syncErrorMessage(42)).toBe("42");
  });
});

describe("runSyncStep", () => {
  it("records a throwing step as a SyncStepError without rethrowing", async () => {
    const errors: SyncStepError[] = [];
    await runSyncStep("Yahoo USD/CLP", errors, async () => {
      throw new Error("HTTP 503");
    });
    expect(errors).toEqual([{ step: "Yahoo USD/CLP", message: "HTTP 503" }]);
  });

  it("records nothing for a successful step", async () => {
    const errors: SyncStepError[] = [];
    await runSyncStep("AFP UNO", errors, async () => {});
    expect(errors).toEqual([]);
  });
});

describe("runSyncStepIfStale", () => {
  it("skips sources that are not stale", async () => {
    const errors: SyncStepError[] = [];
    let ran = false;
    const state: GlobalSyncStateFile = {};
    await runSyncStepIfStale("afp_uno", ["fintual"], "AFP UNO", errors, state, cl, async () => {
      ran = true;
    });
    expect(ran).toBe(false);
    expect(errors).toEqual([]);
  });

  it("one failing source does not stop later sources (continue-on-error contract)", async () => {
    const errors: SyncStepError[] = [];
    const state: GlobalSyncStateFile = {};
    const stale = ["afp_uno", "sbif_uf"] as const;
    const ran: string[] = [];

    await runSyncStepIfStale("afp_uno", stale, "AFP UNO", errors, state, cl, async () => {
      ran.push("afp_uno");
      throw new Error("uno.cl timeout");
    });
    await runSyncStepIfStale("sbif_uf", stale, "BCentral UF", errors, state, cl, async () => {
      ran.push("sbif_uf");
    });

    expect(ran).toEqual(["afp_uno", "sbif_uf"]);
    expect(errors).toEqual([{ step: "AFP UNO", message: "uno.cl timeout" }]);
  });

  it("keeps the user-forced-stale flag when the step fails", async () => {
    const errors: SyncStepError[] = [];
    const state: GlobalSyncStateFile = { userForcedStale: ["afp_uno"] };
    await runSyncStepIfStale("afp_uno", ["afp_uno"], "AFP UNO", errors, state, cl, async () => {
      throw new Error("down");
    });
    expect(state.userForcedStale).toEqual(["afp_uno"]);
    expect(errors).toHaveLength(1);
  });

  it("clears only the succeeding source's user-forced-stale flag", async () => {
    const errors: SyncStepError[] = [];
    const state: GlobalSyncStateFile = { userForcedStale: ["afp_uno", "sbif_uf"] };
    await runSyncStepIfStale("afp_uno", ["afp_uno"], "AFP UNO", errors, state, cl, async () => {});
    expect(errors).toEqual([]);
    expect(state.userForcedStale).toEqual(["sbif_uf"]);
  });

  it("drops the userForcedStale key entirely when the last flag clears", async () => {
    const errors: SyncStepError[] = [];
    const state: GlobalSyncStateFile = { userForcedStale: ["sbif_uf"] };
    await runSyncStepIfStale("sbif_uf", ["sbif_uf"], "BCentral UF", errors, state, cl, async () => {});
    expect(state.userForcedStale).toBeUndefined();
  });
});
