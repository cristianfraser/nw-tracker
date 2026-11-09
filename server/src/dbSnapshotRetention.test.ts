import { describe, expect, it } from "vitest";
import { planSnapshotRetention } from "./dbSnapshotRetention.js";

describe("planSnapshotRetention", () => {
  const names = [
    "20260815-004800-auto-daily.db",
    "20260820-120000-before-deploy-aaaa0001.db",
    "20260830-004800-auto-daily.db",
    "20260915-004800-auto-daily.db",
    "20260930-230000-before-deploy-aaaa0002.db",
    "20261011-004800-auto-daily.db", // 30th day back from 2026-11-09: still daily
    "20261010-004800-auto-daily.db", // 31st day back: monthly
    "20261108-004800-auto-daily.db",
    "20261109-031729-before-deploy-aaaa0003.db",
    "20261109-122910-before-deploy-aaaa0004.db",
    "20261109-004800-auto-daily.db",
    "notes.txt",
  ];

  it("keeps the newest of each day for the daily window and the newest of each month before it", () => {
    const plan = planSnapshotRetention(names, "2026-11-09", 30);
    expect(plan.keep).toEqual([
      "20260830-004800-auto-daily.db",
      "20260930-230000-before-deploy-aaaa0002.db",
      "20261010-004800-auto-daily.db",
      "20261011-004800-auto-daily.db",
      "20261108-004800-auto-daily.db",
      "20261109-122910-before-deploy-aaaa0004.db",
    ]);
    expect(plan.prune).toEqual([
      "20260815-004800-auto-daily.db",
      "20260820-120000-before-deploy-aaaa0001.db",
      "20260915-004800-auto-daily.db",
      "20261109-004800-auto-daily.db",
      "20261109-031729-before-deploy-aaaa0003.db",
    ]);
  });

  it("leaves a file that is not a stamped snapshot out of both lists", () => {
    const plan = planSnapshotRetention(names, "2026-11-09", 30);
    expect([...plan.keep, ...plan.prune]).not.toContain("notes.txt");
  });

  it("refuses a malformed day or a non-positive window", () => {
    expect(() => planSnapshotRetention(names, "2026-11-9", 30)).toThrow(/YYYY-MM-DD/);
    expect(() => planSnapshotRetention(names, "2026-11-09", 0)).toThrow(/positive integer/);
  });
});
