import { afterAll, beforeAll } from "vitest";
import { db } from "../db.js";

/**
 * Lender patterns for a test file on a database with no depto loan: a fixture account holding
 * the `lender_pattern` rows the depto mortgage seeds (migration 271), removed after the file. A
 * database that already has lender patterns keeps them and gets none added.
 */
export function useLenderPatternsFixture(patterns: readonly string[] = ["METLIFE", "MUTUARIA", "TOKU HIPOTE"]): void {
  let accountId: number | null = null;
  beforeAll(() => {
    const has = db.prepare(`SELECT 1 FROM account_roles WHERE role = 'lender_pattern' LIMIT 1`).get();
    if (has) return;
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as { id: number };
    accountId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes) VALUES (?, 'Vitest lender fixture', 'vitest')`)
        .run(group.id).lastInsertRowid
    );
    const ins = db.prepare(`INSERT INTO account_roles (account_id, role, param) VALUES (?, 'lender_pattern', ?)`);
    for (const p of patterns) ins.run(accountId, p);
  });
  afterAll(() => {
    if (accountId != null) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
  });
}
