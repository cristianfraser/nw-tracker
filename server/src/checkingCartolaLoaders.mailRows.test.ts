import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { listCheckingMovements } from "./checkingCartolaLoaders.js";
import { cartolaDescriptionFromNote } from "./checkingDescriptionPredicates.js";

/** Rows rebuilt from the bank's mails for a lost cartola month are bank movements like the cartola's. */
const PREFIX = "vitest-checking-mail-rows";
let accountId = 0;

function cleanup() {
  db.prepare(`DELETE FROM movements WHERE account_id IN (SELECT id FROM accounts WHERE name LIKE '${PREFIX}%')`).run();
  db.prepare(`DELETE FROM accounts WHERE name LIKE '${PREFIX}%'`).run();
}

beforeAll(() => {
  cleanup();
  const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as { id: number };
  accountId = Number(
    db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`).run(group.id, `${PREFIX}`).lastInsertRowid
  );
  const ins = db.prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', ?, ?)`);
  ins.run(accountId, -60000, "2036-07-06", "import:santander-mail|2036-07-06 20:49|Transf a PERSONA");
  ins.run(accountId, 18000, "2036-07-08", "import:santander-mail|2036-07-08 10:59|Transf. de PERSONA");
  ins.run(accountId, -5000, "2036-07-09", "import:cartola|2036-07|Agustinas|COMPRA|on:2036-07-09|amt:-5000|idx:0");
  ins.run(accountId, -9999, "2036-07-10", "Ajuste hecho a mano");
});
afterAll(cleanup);

describe("listCheckingMovements", () => {
  it("lists the mail-rebuilt rows beside the cartola's, and never a hand-made row", () => {
    expect(listCheckingMovements(accountId, "out").map((r) => r.amount_clp)).toEqual([-60000, -5000]);
    expect(listCheckingMovements(accountId, "in").map((r) => r.amount_clp)).toEqual([18000]);
  });

  it("reads a mail row's description as its merchant", () => {
    expect(cartolaDescriptionFromNote("import:santander-mail|2036-07-06 20:49|Transf a PERSONA (Banco X)")).toBe(
      "Transf a PERSONA (Banco X)"
    );
  });
});
