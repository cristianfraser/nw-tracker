import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryChoice, queryFlag } from "./shared.js";

let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.get("/probe", (req, res) => {
    const flag = queryFlag(req, res, "flag");
    if (flag == null) return;
    const grain = queryChoice(req, res, "grain", ["monthly", "daily"] as const, "monthly");
    if (grain == null) return;
    res.json({ flag, grain });
  });
  server = await new Promise<Server>((resolve) => {
    const started: Server = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function probe(query: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}/probe${query}`);
  return { status: res.status, body: await res.json() };
}

describe("query parameter readers", () => {
  it("an absent parameter is the default", async () => {
    expect(await probe("")).toEqual({ status: 200, body: { flag: false, grain: "monthly" } });
    expect(await probe("?flag=&grain=")).toEqual({ status: 200, body: { flag: false, grain: "monthly" } });
  });

  it("reads the flag rule and the listed values", async () => {
    expect(await probe("?flag=1&grain=daily")).toEqual({ status: 200, body: { flag: true, grain: "daily" } });
    expect(await probe("?flag=TRUE")).toEqual({ status: 200, body: { flag: true, grain: "monthly" } });
    expect(await probe("?flag=no&grain=monthly")).toEqual({ status: 200, body: { flag: false, grain: "monthly" } });
  });

  it("a value that is neither answers 400 and names the parameter", async () => {
    expect(await probe("?flag=on")).toEqual({ status: 400, body: { error: "flag must be 1/true/yes or 0/false/no" } });
    expect(await probe("?flag=1&flag=0")).toMatchObject({ status: 400 });
    expect(await probe("?grain=weekly")).toEqual({ status: 400, body: { error: "grain must be one of monthly, daily" } });
    expect(await probe("?grain=daily&grain=daily")).toMatchObject({ status: 400 });
  });
});
