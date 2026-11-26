import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { importCheckingCartola } from "./checkingCartolaImport.js";
import { partialMovementNote } from "./checkingPartialMovementsImport.js";
import { insertBankPesoMovement } from "./movementWrites.js";
import { dailyListingFacts } from "./movementListingFacts.js";
import { deleteTempCardMaster } from "./test/tempCardMaster.js";

/** A cartola taking over the daily rows keeps each row's arrival (`olderArrival`, `flowFirstSeen.ts`). */
const PERIOD = "1802-03";
const OLD_STAMP = { on: "1802-03-20", at: "1802-03-20T12:00:00.000Z", seq: 1 };
const rows = [
  { occurred_on: "1802-03-10", amount_clp: -11_111, description: "VITEST ARRIVAL DAILY OLD" },
  { occurred_on: "1802-03-12", amount_clp: -22_222, description: "VITEST ARRIVAL DAILY STAMPED" },
  { occurred_on: "1802-03-14", amount_clp: -33_333, description: "VITEST ARRIVAL CARTOLA ONLY" },
];

/** A checking account this file owns, beside the test person's. */
function createCheckingAccount(): number {
  const group = db
    .prepare(
      `SELECT a.asset_group_id AS id FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE g.slug LIKE '%cuenta_corriente%' ORDER BY a.id LIMIT 1`
    )
    .get() as { id: number } | undefined;
  if (!group) throw new Error("no checking group in the test person");
  const key = "import:panel|vitest-arrival-checking";
  return Number(
    db.prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · arrival checking', ?, ?)`).run(group.id, key, key)
      .lastInsertRowid
  );
}

function stampOfCartolaRow(accountId: number, description: string): { on: string; at: string | null; seq: number | null } | null {
  const m = db
    .prepare(`SELECT flow_id FROM movements WHERE account_id = ? AND note LIKE ? AND note LIKE ?`)
    .get(accountId, `import:cartola|${PERIOD}|%`, `%${description}%`) as { flow_id: number } | undefined;
  if (!m) throw new Error(`no cartola row «${description}»`);
  return (
    (db
      .prepare(`SELECT first_seen_on AS "on", first_seen_at AS at, first_seen_seq AS seq FROM flow_first_seen WHERE flow_id = ?`)
      .get(m.flow_id) as { on: string; at: string | null; seq: number | null } | undefined) ?? null
  );
}

describe("a checking cartola over the daily rows", () => {
  let accountId = 0;
  const notes = rows.slice(0, 2).map((r) => partialMovementNote({ ...r, document_no: "" }));

  beforeAll(() => {
    accountId = createCheckingAccount();
    // Two daily rows on file: one from before the stamps (none), one stamped when it was listed.
    const daily = notes.map((note, i) =>
      insertBankPesoMovement({ accountId, amount: rows[i]!.amount_clp, occurredOn: rows[i]!.occurred_on, note, flowKind: null, listed: dailyListingFacts({ ...rows[i]!, document_no: "" }) })
    );
    const flowOf = (id: number) => (db.prepare(`SELECT flow_id FROM movements WHERE id = ?`).get(id) as { flow_id: number }).flow_id;
    db.prepare(`DELETE FROM flow_first_seen WHERE flow_id = ?`).run(flowOf(daily[0]!));
    db.prepare(`UPDATE flow_first_seen SET first_seen_on = ?, first_seen_at = ?, first_seen_seq = ? WHERE flow_id = ?`).run(
      OLD_STAMP.on,
      OLD_STAMP.at,
      OLD_STAMP.seq,
      flowOf(daily[1]!)
    );

    const { partialsRestated, movementsInserted } = importCheckingCartola(accountId, {
      source_file: "vitest-arrival-cartola.xlsx",
      period_month: PERIOD,
      period_from: "1802-03-01",
      period_to: "1802-03-31",
      saldo_inicial_clp: 100_000,
      saldo_final_clp: 100_000 + rows.reduce((s, r) => s + r.amount_clp, 0),
      movements: rows.map((r) => ({ ...r, branch: "Agustinas", document_no: "" })),
      skipped: [],
      notes: [],
    });
    // The two daily rows are restated as their cartola rows; only the third movement is written.
    expect(movementsInserted).toBe(1);
    expect(partialsRestated).toBe(2);
  });

  afterAll(() => deleteTempCardMaster(accountId));

  it("the cartola row of a daily row on file before the stamps stays unstamped", () => {
    expect(stampOfCartolaRow(accountId, rows[0]!.description)).toBeNull();
  });

  it("the cartola row of a stamped daily row keeps that row's stamp", () => {
    expect(stampOfCartolaRow(accountId, rows[1]!.description)).toEqual(OLD_STAMP);
  });

  it("a cartola row with no daily row is stamped now", () => {
    expect(stampOfCartolaRow(accountId, rows[2]!.description)?.on).toBe(chileCalendarTodayYmd());
  });
});
