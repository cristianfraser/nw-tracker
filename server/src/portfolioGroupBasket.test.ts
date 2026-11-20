import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { getNetWorthNavGroupNode, type NavTreeNodeDto } from "./navTree.js";
import { registerAccountsRoutes } from "./routes/accounts.js";

function findGroup(node: NavTreeNodeDto, slug: string): NavTreeNodeDto | null {
  if (node.account_id == null && node.slug === slug) return node;
  for (const c of node.children) {
    const hit = findGroup(c, slug);
    if (hit) return hit;
  }
  return null;
}

/** The panel's Basket toggle: `PATCH /api/portfolio-groups/:slug/basket` writes `portfolio_groups.basket`, the nav tree reads it. */
describe("portfolio group basket flag", () => {
  let server: Server;
  let base = "";
  const slug = "vitest_basket_group";
  let groupId = 0;

  beforeAll(async () => {
    const nw = db.prepare(`SELECT id FROM portfolio_groups WHERE slug = 'net_worth'`).get() as { id: number };
    groupId = Number(
      db
        .prepare(`INSERT INTO portfolio_groups (slug, label, sort_order) VALUES (?, 'Vitest basket group', 9999)`)
        .run(slug).lastInsertRowid
    );
    db.prepare(`INSERT INTO portfolio_group_items (group_id, item_kind, child_group_id, sort_order) VALUES (?, 'group', ?, 9999)`).run(
      nw.id,
      groupId
    );
    const app = express();
    app.use(express.json());
    registerAccountsRoutes(app);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    db.prepare(`DELETE FROM portfolio_group_items WHERE child_group_id = ?`).run(groupId);
    db.prepare(`DELETE FROM portfolio_groups WHERE id = ?`).run(groupId);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const patch = (s: string, body: unknown) =>
    fetch(`${base}/api/portfolio-groups/${s}/basket`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("round-trips through the route and shows in the nav payload", async () => {
    const on = await patch(slug, { basket: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ basket: true });
    expect(findGroup(getNetWorthNavGroupNode()!, slug)?.basket).toBe(true);

    const off = await patch(slug, { basket: false });
    expect(await off.json()).toEqual({ basket: false });
    expect(findGroup(getNetWorthNavGroupNode()!, slug)?.basket).toBe(false);
  });

  it("rejects a non-boolean and an unknown group", async () => {
    expect((await patch(slug, { basket: "yes" })).status).toBe(400);
    expect((await patch("no_such_group_vitest", { basket: true })).status).toBe(404);
  });
});
