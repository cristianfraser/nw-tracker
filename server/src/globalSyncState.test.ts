import { describe, expect, it } from "vitest";
import { fintualValuationStateFingerprint, type GlobalSyncStateFile } from "./globalSyncState.js";

describe("fintualValuationStateFingerprint", () => {
  const base: GlobalSyncStateFile = {
    fintualLastAppliedPublishYmd: "2026-10-30",
    fintualLastAppliedSig: "a",
    fintualLastCheckSig: "a",
    fintualLastCheckYmd: "2026-11-02",
    fintualLastPublishYmd: "2026-10-30",
  };

  it("changes when the evening poll settles the day without writing a row", () => {
    expect(fintualValuationStateFingerprint({ ...base, fintualEveningSettledYmd: "2026-11-02" })).not.toBe(
      fintualValuationStateFingerprint(base)
    );
  });

  it("changes when a poll reads a new goals NAV", () => {
    expect(fintualValuationStateFingerprint({ ...base, fintualLastCheckSig: "b" })).not.toBe(
      fintualValuationStateFingerprint(base)
    );
  });

  it("ignores fields valuation does not read", () => {
    expect(
      fintualValuationStateFingerprint({ ...base, fintualOfficialSerieLastCheckedAt: "2026-11-02T15:00:00Z" })
    ).toBe(fintualValuationStateFingerprint(base));
  });
});
