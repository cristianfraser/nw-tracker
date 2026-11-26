import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { insertMovement } from "./movementWrites.js";
import { latestRowSources } from "./latestMovementTimes.js";

class Rollback extends Error {}

describe("latestRowSources", () => {
  it("names a movement's row by its flow, so a replacement row that keeps the flow keeps its arrival key", () => {
    const [account] = (db.prepare(`SELECT id FROM accounts ORDER BY id LIMIT 1`).all() as { id: number }[]).map((r) => r.id);
    try {
      db.transaction(() => {
        const id = insertMovement({ accountId: account!, amount: -1_500, currency: "clp", occurredOn: "2020-01-02", note: "vitest arrival key" });
        const flowId = (db.prepare(`SELECT flow_id FROM movements WHERE id = ?`).get(id) as { flow_id: number }).flow_id;
        const sources = latestRowSources();
        expect(sources.flows([{ kind: "movement", movementId: id, accountId: account! }, { kind: "none" }])).toEqual([flowId, null]);
        // The write stamp is found through the same flow.
        expect(sources.stamps([{ kind: "movement", movementId: id, accountId: account! }])[0]).toMatchObject({ seq: expect.any(Number) });
        throw new Rollback();
      })();
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
  });
});
