/**
 * The demo market asset on GitHub (2026-11-09, docs/demo-market-publish-plan.md): the home server
 * uploads it to one fixed release of the public repo every night, the Render build downloads it.
 *
 * - **One release, fixed tag** (`DEMO_MARKET_RELEASE_TAG`), created on first publish and never
 *   marked the repo's latest release. It carries two assets under fixed names: the gzipped
 *   artifact (`DEMO_MARKET_ASSET_NAME`) and its header as plain JSON (`DEMO_MARKET_META_ASSET_NAME`,
 *   read by `scripts/release-demo.sh` before a release).
 * - **Replacing an asset**: upload the new bytes under a temporary name, delete the old asset,
 *   rename the new one. A download never finds a half-written file; it can miss the asset only in
 *   the moment between the delete and the rename.
 * - **Downloading** goes through `github.com/<repo>/releases/download/<tag>/<name>`, which needs no
 *   token on a public repo and is not counted against the API's unauthenticated rate limit (Render's
 *   build machines share their addresses).
 *
 * The token (`DEMO_MARKET_PUBLISH_TOKEN`, a fine-grained token with Contents: read and write on the
 * repo) is read by the caller where it is used, never stored.
 */
import { fetchOutboundBytes, type OutboundRequest } from "./outboundFetch.js";

export const DEMO_MARKET_REPO = "cristianfraser/nw-tracker";
export const DEMO_MARKET_RELEASE_TAG = "demo-market";
export const DEMO_MARKET_RELEASE_NAME = "Demo market data";
export const DEMO_MARKET_ASSET_NAME = "demo-market.json.gz";
export const DEMO_MARKET_META_ASSET_NAME = "demo-market.meta.json";

const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";
const USER_AGENT = "nw-tracker demo-market publish";
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** The repo the asset lives in: `DEMO_MARKET_REPO` in the environment (a fork), else this one. */
export function demoMarketRepo(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.DEMO_MARKET_REPO?.trim();
  if (!v) return DEMO_MARKET_REPO;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)) throw new Error(`DEMO_MARKET_REPO=${JSON.stringify(v)}: expected owner/name`);
  return v;
}

export function demoMarketAssetDownloadUrl(repo: string, name: string = DEMO_MARKET_ASSET_NAME): string {
  return `https://github.com/${repo}/releases/download/${DEMO_MARKET_RELEASE_TAG}/${name}`;
}

/** The temporary name an asset is uploaded under before it replaces `name`. */
export function demoMarketNextAssetName(name: string): string {
  const dot = name.indexOf(".");
  return dot < 0 ? `${name}.next` : `${name.slice(0, dot)}.next${name.slice(dot)}`;
}

type Fetch = typeof fetch;
type ReleaseAsset = { id: number; name: string };
type Release = { id: number; assets: ReleaseAsset[] };

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function github(
  token: string,
  label: string,
  url: string,
  opts: { method?: OutboundRequest["method"]; body?: Uint8Array | string; contentType?: string; timeoutMs?: number; fetchImpl?: Fetch }
): Promise<{ status: number; ok: boolean; text: string }> {
  const r = await fetchOutboundBytes({
    label,
    url,
    userAgent: USER_AGENT,
    accept: "application/vnd.github+json",
    method: opts.method,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.contentType ? { "Content-Type": opts.contentType } : {}),
    },
    body: opts.body,
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });
  return { status: r.status, ok: r.ok, text: decode(r.bytes) };
}

function fail(what: string, r: { status: number; text: string }): never {
  throw new Error(`demo market release: ${what} — HTTP ${r.status}: ${r.text.slice(0, 300)}`);
}

function parseRelease(text: string): Release {
  const j = JSON.parse(text) as { id?: unknown; assets?: unknown };
  if (typeof j.id !== "number" || !Array.isArray(j.assets)) throw new Error("demo market release: unexpected release payload");
  return {
    id: j.id,
    assets: (j.assets as { id: unknown; name: unknown }[]).map((a) => {
      if (typeof a.id !== "number" || typeof a.name !== "string") throw new Error("demo market release: unexpected asset payload");
      return { id: a.id, name: a.name };
    }),
  };
}

/** The fixed release, created (at `main`, never the repo's latest release) when it does not exist. */
async function ensureRelease(token: string, repo: string, fetchImpl?: Fetch): Promise<Release> {
  const got = await github(token, "github:release", `${API}/repos/${repo}/releases/tags/${DEMO_MARKET_RELEASE_TAG}`, { fetchImpl });
  if (got.ok) return parseRelease(got.text);
  if (got.status !== 404) fail("reading the release", got);
  const created = await github(token, "github:release-create", `${API}/repos/${repo}/releases`, {
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify({
      tag_name: DEMO_MARKET_RELEASE_TAG,
      target_commitish: "main",
      name: DEMO_MARKET_RELEASE_NAME,
      body:
        "The hosted demo's market history (Yahoo, Banco Central, AFP UNO, Bolsa de Santiago), rebuilt every night by the home " +
        "server and read by the Render build. See docs/demo-market-publish-plan.md. Not a software release.",
      make_latest: "false",
    }),
    fetchImpl,
  });
  if (!created.ok) fail("creating the release", created);
  return parseRelease(created.text);
}

async function deleteAsset(token: string, repo: string, asset: ReleaseAsset, fetchImpl?: Fetch): Promise<void> {
  const r = await github(token, "github:asset-delete", `${API}/repos/${repo}/releases/assets/${asset.id}`, { method: "DELETE", fetchImpl });
  // 404: already gone (another run, or by hand).
  if (!r.ok && r.status !== 404) fail(`deleting ${asset.name}`, r);
}

/** Uploads `bytes` as `name` on the release, replacing the asset already there (see the module comment). */
async function replaceAsset(
  token: string,
  repo: string,
  release: Release,
  name: string,
  bytes: Uint8Array,
  contentType: string,
  fetchImpl?: Fetch
): Promise<number> {
  const next = demoMarketNextAssetName(name);
  for (const stale of release.assets.filter((a) => a.name === next)) await deleteAsset(token, repo, stale, fetchImpl);
  const up = await github(
    token,
    "github:asset-upload",
    `${UPLOADS}/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(next)}`,
    { method: "POST", body: bytes, contentType, timeoutMs: UPLOAD_TIMEOUT_MS, fetchImpl }
  );
  if (!up.ok) fail(`uploading ${next}`, up);
  const uploaded = JSON.parse(up.text) as { id?: unknown };
  if (typeof uploaded.id !== "number") throw new Error("demo market release: unexpected upload payload");
  for (const old of release.assets.filter((a) => a.name === name)) await deleteAsset(token, repo, old, fetchImpl);
  const renamed = await github(token, "github:asset-rename", `${API}/repos/${repo}/releases/assets/${uploaded.id}`, {
    method: "PATCH",
    contentType: "application/json",
    body: JSON.stringify({ name }),
    fetchImpl,
  });
  if (!renamed.ok) fail(`renaming ${next} to ${name}`, renamed);
  return uploaded.id;
}

export type DemoMarketPublishResult = { release_id: number; asset_id: number; meta_asset_id: number; url: string };

/** Uploads the artifact and its header to the fixed release (creating it the first time). */
export async function publishDemoMarketRelease(opts: {
  token: string;
  artifact: Uint8Array;
  meta: unknown;
  repo?: string;
  fetchImpl?: Fetch;
}): Promise<DemoMarketPublishResult> {
  if (!opts.token.trim()) throw new Error("demo market release: no token");
  const repo = opts.repo ?? demoMarketRepo();
  const release = await ensureRelease(opts.token, repo, opts.fetchImpl);
  const asset_id = await replaceAsset(opts.token, repo, release, DEMO_MARKET_ASSET_NAME, opts.artifact, "application/gzip", opts.fetchImpl);
  const meta_asset_id = await replaceAsset(
    opts.token,
    repo,
    release,
    DEMO_MARKET_META_ASSET_NAME,
    new TextEncoder().encode(`${JSON.stringify(opts.meta, null, 2)}\n`),
    "application/json",
    opts.fetchImpl
  );
  return { release_id: release.id, asset_id, meta_asset_id, url: demoMarketAssetDownloadUrl(repo) };
}

/** The published artifact's bytes (no token: the repo is public). Throws on any answer but 200. */
export async function downloadDemoMarketAsset(opts: { repo?: string; fetchImpl?: Fetch; hint: string }): Promise<Uint8Array> {
  const url = demoMarketAssetDownloadUrl(opts.repo ?? demoMarketRepo());
  const r = await fetchOutboundBytes({
    label: "github:demo-market-download",
    url,
    userAgent: USER_AGENT,
    accept: "application/octet-stream",
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
  if (!r.ok) throw new Error(`demo market: ${url} answered HTTP ${r.status}; check ${opts.hint}`);
  return r.bytes;
}
