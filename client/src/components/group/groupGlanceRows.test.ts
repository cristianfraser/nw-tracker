import { describe, expect, it } from "vitest";
import { openByDefault, rowKey } from "./groupGlanceRows";

const group = { kind: "group" } as const;
const account = { kind: "account" } as const;
const liquidated = { kind: "liquidated" } as const;

describe("openByDefault", () => {
  it("opens a held group of groups, the ones it has liquidated included", () => {
    expect(openByDefault({ held: true, members: [group, group] })).toBe(true);
    expect(openByDefault({ held: true, members: [group, { ...liquidated, members: [group, group] }] })).toBe(true);
  });

  it("keeps closed a group holding accounts, folded or not, and a sold-out one", () => {
    expect(openByDefault({ held: true, members: [group, account] })).toBe(false);
    expect(openByDefault({ held: true, members: [group, { ...liquidated, members: [account, account] }] })).toBe(false);
    expect(openByDefault({ held: false, members: [group, group] })).toBe(false);
    expect(openByDefault({ held: true, members: [] })).toBe(false);
  });
});

describe("rowKey", () => {
  it("tells a group from the liquidated row of the same group", () => {
    expect(rowKey({ kind: "group", slug: "acciones", account_id: null })).toBe("g:acciones");
    expect(rowKey({ kind: "liquidated", slug: "acciones", account_id: null })).toBe("l:acciones");
    expect(rowKey({ kind: "account", slug: null, account_id: 7 })).toBe("a:7");
  });
});
