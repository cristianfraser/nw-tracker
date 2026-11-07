import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import master from "./i18n/master.json";
import { SERVER_NAV_LABEL_I18N_KEYS } from "./sidebarNavFromApi";

const SERVER_SRC = fileURLToPath(new URL("../../server/src", import.meta.url));

/** Every `label_i18n_key: "…"` literal in the server's (non-test) sources. */
function serverEmittedLabelKeys(): Set<string> {
  const keys = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "test") walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        for (const m of fs.readFileSync(full, "utf8").matchAll(/label_i18n_key: "([^"]+)"/g)) keys.add(m[1]!);
      }
    }
  };
  walk(SERVER_SRC);
  return keys;
}

function masterLeaf(key: string): unknown {
  let node: unknown = master;
  for (const part of key.split(".")) {
    if (node == null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

const isTranslated = (key: string) => {
  const leaf = masterLeaf(key) as { en?: unknown; es?: unknown } | undefined;
  return typeof leaf?.en === "string" && typeof leaf?.es === "string";
};

describe("server nav label keys", () => {
  const emitted = serverEmittedLabelKeys();

  it("every key the server emits is in master.json in both languages", () => {
    expect([...emitted].filter((k) => !isTranslated(k)).sort()).toEqual([]);
  });

  it("the client's list names only keys the server emits, each translated", () => {
    expect(SERVER_NAV_LABEL_I18N_KEYS.filter((k) => !emitted.has(k))).toEqual([]);
    expect(SERVER_NAV_LABEL_I18N_KEYS.filter((k) => !isTranslated(k))).toEqual([]);
  });
});
