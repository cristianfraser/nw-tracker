import { describe, expect, it } from "vitest";

describe("liveQuotesStamp", () => {
  it("publishes at once without a warmer, and only after the warm with one", async () => {
    const m = await import("./liveQuotesStamp.js");
    expect(m.liveQuotesStamp()).toBeNull();
    m.noteLiveQuotesChanged("2026-10-27T13:30:20.000Z");
    expect(m.liveQuotesStamp()).toBe("2026-10-27T13:30:20.000Z");

    m.setLiveQuotesStampPublishedByWarmer(true);
    m.noteLiveQuotesChanged("2026-10-27T13:32:00.000Z");
    expect(m.liveQuotesStamp()).toBe("2026-10-27T13:30:20.000Z");
    const pending = m.pendingLiveQuotesChange();
    m.noteLiveQuotesChanged("2026-10-27T13:34:00.000Z");
    m.publishLiveQuotesStamp(pending);
    expect(m.liveQuotesStamp()).toBe("2026-10-27T13:32:00.000Z");
    // An older publication never moves the stamp back.
    m.publishLiveQuotesStamp("2026-10-27T13:30:20.000Z");
    expect(m.liveQuotesStamp()).toBe("2026-10-27T13:32:00.000Z");
  });
});
