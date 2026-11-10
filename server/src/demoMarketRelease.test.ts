import { describe, expect, it } from "vitest";
import {
  DEMO_MARKET_ASSET_NAME,
  DEMO_MARKET_META_ASSET_NAME,
  DEMO_MARKET_RELEASE_TAG,
  demoMarketAssetDownloadUrl,
  demoMarketNextAssetName,
  demoMarketRepo,
  downloadDemoMarketAsset,
  publishDemoMarketRelease,
} from "./demoMarketRelease.js";

type Call = { method: string; url: string; auth: string | null; body: string | null };

/** A fake GitHub holding one release in memory; records every request. */
function fakeGithub(initial: { release: { id: number; assets: { id: number; name: string }[] } | null }) {
  const calls: Call[] = [];
  let release = initial.release;
  let nextAssetId = 100;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body == null ? null : typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as Uint8Array);
    calls.push({ method, url, auth: headers.get("Authorization"), body });
    const repo = "https://api.github.com/repos/o/r";
    if (method === "GET" && url === `${repo}/releases/tags/${DEMO_MARKET_RELEASE_TAG}`) {
      return release ? json(200, release) : json(404, { message: "Not Found" });
    }
    if (method === "POST" && url === `${repo}/releases`) {
      release = { id: 7, assets: [] };
      return json(201, release);
    }
    const upload = /^https:\/\/uploads\.github\.com\/repos\/o\/r\/releases\/(\d+)\/assets\?name=(.+)$/.exec(url);
    if (method === "POST" && upload && release) {
      const asset = { id: nextAssetId++, name: decodeURIComponent(upload[2]!) };
      release.assets.push(asset);
      return json(201, asset);
    }
    const asset = /^https:\/\/api\.github\.com\/repos\/o\/r\/releases\/assets\/(\d+)$/.exec(url);
    if (asset && release) {
      const id = Number(asset[1]);
      if (method === "DELETE") {
        release.assets = release.assets.filter((a) => a.id !== id);
        return new Response(null, { status: 204 });
      }
      if (method === "PATCH") {
        const a = release.assets.find((x) => x.id === id)!;
        a.name = (JSON.parse(body!) as { name: string }).name;
        return json(200, a);
      }
    }
    return json(500, { message: `unexpected ${method} ${url}` });
  }) as typeof fetch;
  return { fetchImpl, calls, release: () => release };
}

describe("demo market release", () => {
  it("names the temporary asset before the extension", () => {
    expect(demoMarketNextAssetName("demo-market.json.gz")).toBe("demo-market.next.json.gz");
    expect(demoMarketNextAssetName("plain")).toBe("plain.next");
  });

  it("reads the repo from the environment, else this one", () => {
    expect(demoMarketRepo({})).toBe("cristianfraser/nw-tracker");
    expect(demoMarketRepo({ DEMO_MARKET_REPO: "me/fork" })).toBe("me/fork");
    expect(() => demoMarketRepo({ DEMO_MARKET_REPO: "not a repo" })).toThrow(/owner\/name/);
    expect(demoMarketAssetDownloadUrl("o/r")).toBe("https://github.com/o/r/releases/download/demo-market/demo-market.json.gz");
  });

  it("creates the release on first publish, never as the repo's latest, and uploads both assets", async () => {
    const gh = fakeGithub({ release: null });
    const r = await publishDemoMarketRelease({ token: "t0k", artifact: new Uint8Array([1, 2, 3]), meta: { a: 1 }, repo: "o/r", fetchImpl: gh.fetchImpl });
    const create = gh.calls.find((c) => c.method === "POST" && c.url.endsWith("/releases"))!;
    expect(JSON.parse(create.body!)).toMatchObject({ tag_name: "demo-market", make_latest: "false", target_commitish: "main" });
    expect(gh.release()!.assets.map((a) => a.name).sort()).toEqual([DEMO_MARKET_ASSET_NAME, DEMO_MARKET_META_ASSET_NAME].sort());
    expect(r).toMatchObject({ release_id: 7, url: "https://github.com/o/r/releases/download/demo-market/demo-market.json.gz" });
    expect(gh.calls.every((c) => c.auth === "Bearer t0k")).toBe(true);
  });

  it("replaces the assets already there: upload under the temporary name, delete the old one, rename", async () => {
    const gh = fakeGithub({
      release: {
        id: 7,
        assets: [
          { id: 1, name: DEMO_MARKET_ASSET_NAME },
          { id: 2, name: DEMO_MARKET_META_ASSET_NAME },
          { id: 3, name: "demo-market.next.json.gz" }, // left by an interrupted run
        ],
      },
    });
    await publishDemoMarketRelease({ token: "t", artifact: new Uint8Array([9]), meta: {}, repo: "o/r", fetchImpl: gh.fetchImpl });
    const steps = gh.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url.replace(/^https:\/\/[^/]+\/repos\/o\/r/, "")}`);
    expect(steps.slice(0, 4)).toEqual([
      "DELETE /releases/assets/3",
      "POST /releases/7/assets?name=demo-market.next.json.gz",
      "DELETE /releases/assets/1",
      "PATCH /releases/assets/100",
    ]);
    expect(gh.release()!.assets).toEqual([
      { id: 100, name: DEMO_MARKET_ASSET_NAME },
      { id: 101, name: DEMO_MARKET_META_ASSET_NAME },
    ]);
  });

  it("throws on a refused request, and refuses to publish without a token", async () => {
    const denied = (async () => new Response('{"message":"Bad credentials"}', { status: 401 })) as unknown as typeof fetch;
    await expect(publishDemoMarketRelease({ token: "t", artifact: new Uint8Array(), meta: {}, repo: "o/r", fetchImpl: denied })).rejects.toThrow(
      /reading the release — HTTP 401: .*Bad credentials/
    );
    await expect(publishDemoMarketRelease({ token: " ", artifact: new Uint8Array(), meta: {}, repo: "o/r" })).rejects.toThrow(/no token/);
  });

  it("downloads the asset without a token, and names the job on a missing one", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const ok = (async (u: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(u), auth: new Headers(init?.headers).get("Authorization") });
      return new Response(new Uint8Array([7, 8]), { status: 200 });
    }) as typeof fetch;
    expect([...(await downloadDemoMarketAsset({ repo: "o/r", fetchImpl: ok, hint: "the job" }))]).toEqual([7, 8]);
    expect(seen).toEqual([{ url: "https://github.com/o/r/releases/download/demo-market/demo-market.json.gz", auth: null }]);
    const missing = (async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch;
    await expect(downloadDemoMarketAsset({ repo: "o/r", fetchImpl: missing, hint: "the job" })).rejects.toThrow(/HTTP 404; check the job/);
  });
});
