import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { importCheckingCartola } from "./checkingCartolaImport.js";
import { partialMovementNote } from "./checkingPartialMovementsImport.js";

/** A cartola taking over the daily rows keeps each row's arrival (`olderArrival`, `flowFirstSeen.ts`). */
const PERIOD = "1802-03";
const OLD_STAMP = { on: "1802-03-20", at: "1802-03-20T12:00:00.000Z", seq: 1 };
const rows = [
  { occurred_on: "1802-03-10", amount_clp: -11_111, description: "VITEST ARRIVAL DAILY OLD" },
  { occurred_on: "1802-03-12", amount_clp: -22_222, description: "VITEST ARRIVAL DAILY STAMPED" },
  { occurred_on: "1802-03-14", amount_clp: -33_333, description: "VITEST ARRIVAL CARTOLA ONLY" },
];

function checkingAccountId(): number {
  const row = db
    .prepare(
      `SELECT a.id FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE g.slug LIKE '%cuenta_corriente%' ORDER BY a.id LIMIT 1`
    )
    .get() as { id: number } | undefined;
  if (!row) throw new Error("no checking account in the test person");
  return row.id;
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
  const cleanup = () => {
    db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`).run(accountId, PERIOD);
    db.prepare(`DELETE FROM movements WHERE account_id = ? AND (note IN (?, ?) OR note LIKE ?)`).run(
      accountId,
      ...notes,
      `import:cartola|${PERIOD}|%`
    );
  };

  beforeAll(() => {
    accountId = checkingAccountId();
    cleanup();
    // Two daily rows on file: one from before the stamps (none), one stamped when it was listed.
    for (const [i, note] of notes.entries()) {
      db.prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', ?, ?)`).run(
        accountId,
        rows[i]!.amount_clp,
        rows[i]!.occurred_on,
        note
      );
    }
    db.prepare(
      `INSERT INTO flow_first_seen (flow_id, first_seen_on, first_seen_at, first_seen_seq)
       SELECT flow_id, ?, ?, ? FROM movements WHERE account_id = ? AND note = ?`
    ).run(OLD_STAMP.on, OLD_STAMP.at, OLD_STAMP.seq, accountId, notes[1]);

    const { partialsRemoved, movementsInserted } = importCheckingCartola(accountId, {
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
    expect(movementsInserted).toBe(3);
    expect(partialsRemoved).toBe(2);
  });

  afterAll(() => cleanup());

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
