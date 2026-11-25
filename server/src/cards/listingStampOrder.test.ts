import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "../chileDate.js";
import { listingLineFromCardListingLine } from "../cardListingLines.js";
import { listingLine } from "../test/cardListingPayloads.js";
import { createTempCardMaster, deleteTempCardMaster } from "../test/tempCardMaster.js";
import { insertLines } from "./lineWrites.js";

/** A card listing's new lines are stamped in the listing's time order (`listingOrder.ts`). */
const DAY = chileCalendarAddDays(chileCalendarTodayYmd(), -1);
let cardId = 0;

function seqOf(merchant: string): number {
  return (
    db
      .prepare(
        `SELECT f.first_seen_seq AS seq FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
         JOIN flow_first_seen f ON f.flow_id = l.flow_id WHERE s.account_id = ? AND l.merchant = ?`
      )
      .get(cardId, merchant) as { seq: number }
  ).seq;
}

const lines = (...rows: [string, number][]) => ({
  lines: rows.map(([merchant, amount]) => listingLineFromCardListingLine(listingLine(DAY, merchant, amount))),
  errors: [],
});

describe("card listing stamp order", () => {
  beforeAll(() => {
    cardId = createTempCardMaster({ issuer: "santander", last4: "7731", key: "vitest-listing-order" });
  });
  afterAll(() => deleteTempCardMaster(cardId));

  it("newest first by default: the bottom line is the oldest write", () => {
    insertLines(cardId, lines(["VITEST ORDER NEWER", 1_100], ["VITEST ORDER OLDER", 2_200]), "cc_web_paste");
    expect(seqOf("VITEST ORDER OLDER")).toBeLessThan(seqOf("VITEST ORDER NEWER"));
  });

  it("a listing that prints oldest first says so", () => {
    insertLines(cardId, lines(["VITEST ORDER FIRST", 3_300], ["VITEST ORDER SECOND", 4_400]), "cc_web_paste", {
      listingOrder: "oldest_first",
    });
    expect(seqOf("VITEST ORDER FIRST")).toBeLessThan(seqOf("VITEST ORDER SECOND"));
  });
});
