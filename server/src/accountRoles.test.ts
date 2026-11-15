import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { listPropertyAccounts, propertyAccountIds } from "./accountRoles.js";
import { rolledBack } from "./ingestReceiver.js";

describe("listPropertyAccounts", () => {
  it("lists the accounts holding the property role, by name, and no other account", () => {
    rolledBack(() => {
      const before = new Set(propertyAccountIds());
      const assetGroupId = (db.prepare(`SELECT asset_group_id AS id FROM accounts LIMIT 1`).get() as { id: number }).id;
      const insert = db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`);
      const second = Number(insert.run(assetGroupId, "zz-vitest property b").lastInsertRowid);
      const first = Number(insert.run(assetGroupId, "zz-vitest property a").lastInsertRowid);
      const bystander = Number(insert.run(assetGroupId, "zz-vitest not a property").lastInsertRowid);
      const role = db.prepare(`INSERT INTO account_roles (account_id, role) VALUES (?, 'property')`);
      role.run(second);
      role.run(first);

      const added = listPropertyAccounts().filter((a) => !before.has(a.id));
      expect(added).toEqual([
        { id: first, name: "zz-vitest property a" },
        { id: second, name: "zz-vitest property b" },
      ]);
      expect(added.some((a) => a.id === bystander)).toBe(false);
    });
  });
});
