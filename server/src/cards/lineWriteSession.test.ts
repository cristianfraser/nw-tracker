import { afterAll, describe, expect, it } from "vitest";
import {
  noteCardLineEvidence,
  noteCardLineFinancingLinks,
  noteCardLineWritten,
  registerCardLineWriteFrame,
  requireCardLineSession,
  withCardLineSession,
  type CardLineWriteFrame,
} from "./lineWriteSession.js";
import { CARD_LINE_WRITE_FRAME } from "./lineWrites.js";

/** A frame that records what the session asked of it. */
function spyFrame(log: string[]): CardLineWriteFrame {
  return {
    transaction(accountId, what, body) {
      log.push(`tx open ${accountId} ${what}`);
      const r = body();
      log.push(`tx commit ${accountId}`);
      return r;
    },
    finish(accountId, evidenceFromYmd, followUps) {
      log.push(`finish ${accountId} from=${evidenceFromYmd} financing=${followUps.financingLinks}`);
    },
  };
}

describe("card-line write session", () => {
  afterAll(() => registerCardLineWriteFrame(CARD_LINE_WRITE_FRAME));

  it("runs a nested write inside the outer one and finishes once, from the earliest evidence", () => {
    const log: string[] = [];
    registerCardLineWriteFrame(spyFrame(log));
    withCardLineSession(7, "outer", () => {
      noteCardLineEvidence(7, "2031-03-10");
      withCardLineSession(7, "inner", () => {
        log.push("inner body");
        noteCardLineEvidence(7, "2031-02-01");
      });
      noteCardLineEvidence(7, null);
    });
    expect(log).toEqual([
      "tx open 7 outer",
      "inner body",
      "tx commit 7",
      "finish 7 from=2031-02-01 financing=false",
    ]);
  });

  it("finishes nothing when the write changed nothing, and asks for the follow-ups noted", () => {
    const log: string[] = [];
    registerCardLineWriteFrame(spyFrame(log));
    withCardLineSession(8, "quiet", () => undefined);
    withCardLineSession(8, "plan", () => noteCardLineFinancingLinks(8));
    withCardLineSession(8, "close", () => noteCardLineWritten(8));
    expect(log.filter((l) => l.startsWith("finish"))).toEqual([
      "finish 8 from=null financing=true",
      "finish 8 from=null financing=false",
    ]);
  });

  it("keeps each account's write apart, and refuses a raw step outside one", () => {
    const log: string[] = [];
    registerCardLineWriteFrame(spyFrame(log));
    withCardLineSession(1, "a", () => {
      withCardLineSession(2, "b", () => noteCardLineEvidence(2, "2031-01-01"));
      noteCardLineEvidence(1, "2031-05-05");
    });
    expect(log.filter((l) => l.startsWith("finish"))).toEqual([
      "finish 2 from=2031-01-01 financing=false",
      "finish 1 from=2031-05-05 financing=false",
    ]);
    expect(() => requireCardLineSession(3, "a line delete")).toThrow(/outside a card-line write/);
    expect(() => noteCardLineEvidence(3, "2031-01-01")).toThrow(/outside a card-line write/);
  });

  it("rolls back and finishes nothing when the write throws", () => {
    const log: string[] = [];
    registerCardLineWriteFrame(spyFrame(log));
    expect(() =>
      withCardLineSession(9, "failing", () => {
        noteCardLineEvidence(9, "2031-01-01");
        throw new Error("boom");
      })
    ).toThrow("boom");
    expect(log.some((l) => l.startsWith("finish"))).toBe(false);
    // The session is gone: a later write on the account is an outer write again.
    withCardLineSession(9, "next", () => noteCardLineWritten(9));
    expect(log.at(-1)).toBe("finish 9 from=null financing=false");
  });
});
