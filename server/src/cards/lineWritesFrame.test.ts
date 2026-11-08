import { describe, expect, it, vi } from "vitest";

/** What the funnel's frame called, in order. */
const calls: string[] = [];

vi.mock("../ccBillingBalances.js", async (orig) => ({
  ...(await orig<typeof import("../ccBillingBalances.js")>()),
  recomputeCcBillingMonthBalances: (accountId: number) => {
    calls.push(`recompute ${accountId}`);
    return 0;
  },
}));
vi.mock("../ccCreditCardValuations.js", async (orig) => ({
  ...(await orig<typeof import("../ccCreditCardValuations.js")>()),
  upsertCreditCardValuationsFromLedger: (accountId: number, opts?: { affectedEvidenceFromYmd?: string | null }) => {
    calls.push(`valuations ${accountId} from=${opts?.affectedEvidenceFromYmd ?? null}`);
    return 0;
  },
}));
vi.mock("../ccPaymentMirrorEvidence.js", async (orig) => ({
  ...(await orig<typeof import("../ccPaymentMirrorEvidence.js")>()),
  keepingCcPaymentEvidence: <T,>(accountId: number, what: string, write: () => T): T => {
    calls.push(`guard before ${accountId}`);
    const r = write();
    calls.push(`guard after ${accountId}`);
    return r;
  },
}));
vi.mock("../ccFacturadoFinancingAuto.js", async (orig) => ({
  ...(await orig<typeof import("../ccFacturadoFinancingAuto.js")>()),
  applyFacturadoFinancingLinks: () => {
    calls.push("financing links");
    return null;
  },
}));
vi.mock("../expenseLinkSync.js", async (orig) => ({
  ...(await orig<typeof import("../expenseLinkSync.js")>()),
  requestExpenseLinkSync: () => {
    calls.push("expense link sync");
  },
}));

const { cardLineWrite } = await import("./lineWrites.js");
const { noteCardLineEvidence, noteCardLineFinancingLinks } = await import("./lineWriteSession.js");

describe("card-line funnel frame", () => {
  it("guards inside the transaction, then recomputes once, re-syncs the valuations once, then the follow-ups", () => {
    calls.length = 0;
    cardLineWrite(41, "test write", () => {
      calls.push("body");
      noteCardLineEvidence(41, "2031-04-02");
      cardLineWrite(41, "nested", () => noteCardLineEvidence(41, "2031-03-30"));
      noteCardLineFinancingLinks(41);
    });
    expect(calls).toEqual([
      "guard before 41",
      "body",
      "guard after 41",
      "recompute 41",
      "valuations 41 from=2031-03-30",
      "financing links",
      "expense link sync",
    ]);
  });
});
