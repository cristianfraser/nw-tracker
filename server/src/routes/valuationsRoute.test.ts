import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db.js";
import { registerMovementsRoutes } from "./movements.js";

/**
 * `POST /api/accounts/:id/valuations` writes a peso mark. An account whose value is not a stored
 * mark refuses it: a mortgage (the `loan_of` role holder) is valued from its payment ledger.
 */
const NAME = "vitest-valuations-route-loan";
let server: Server;
let base = "";
let loanId = 0;

function clean(): void {
  const ids = (db.prepare(`SELECT id FROM accounts WHERE name = ?`).all(NAME) as { id: number }[]).map((r) => r.id);
  for (const id of ids) {
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM account_roles WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  }
}

beforeAll(async () => {
  clean();
  const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as { id: number };
  loanId = Number(db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`).run(group.id, NAME).lastInsertRowid);
  db.prepare(`INSERT INTO account_roles (account_id, role, param) VALUES (?, 'loan_of', ?)`).run(loanId, String(loanId));
  const app = express();
  app.use(express.json());
  registerMovementsRoutes(app);
  server = await new Promise<Server>((resolve) => {
    const started: Server = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  clean();
});

describe("POST /api/accounts/:id/valuations", () => {
  it("refuses a mortgage and writes nothing", async () => {
    const res = await fetch(`${base}/api/accounts/${loanId}/valuations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ as_of_date: "2031-01-31", value_clp: -1000 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/mortgage is valued from its payment ledger/);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM valuations WHERE account_id = ?`).get(loanId)).toEqual({ n: 0 });
  });
});
