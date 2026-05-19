/**
 * Fintual public API (https://fintual.cl/api-docs/index.html, basePath `/api`).
 *
 * Flow (Swagger):
 * 1. `POST /api/access_tokens` with `{ "user": { "email", "password" } }`
 * 2. `GET /api/goals` with `X-User-Email`, `X-User-Token` (token from `data.attributes.token`), and
 *    optionally **`Cookie`** — the browser sends `_fintual_session_cookie`; copy that value into
 *    repo-root `.env` as **`FINTUAL_COOKIE`** so server-side `fetch` matches the browser request.
 *
 * Token path in the login JSON: `data.attributes.token`.
 *
 * Credentials: repo-root `.env` — `FINTUAL_EMAIL`, `FINTUAL_PASSWORD`, optional `FINTUAL_COOKIE` (gitignored).
 * Persisted session: `server/data/.fintual-api-session.json` — `{ email, token, updatedAt }`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chileWallClockNow, type ChileWallClock } from "../src/chileDate.js";
import { fintualValuationAsOfYmd } from "../src/fintualSyncPolicy.js";

export const FINTUAL_API_BASE = "https://fintual.cl/api";

const FINTUAL_FETCH_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
  "User-Agent": "nw-tracker-fintual-scripts/1.0",
} as const;

export type FintualSession = {
  email: string;
  token: string;
  updatedAt: string;
};

export type FintualGoalInvestment = { weight: number; asset_id: number };

export type FintualGoalRow = {
  id: string;
  name: string;
  navClp: number;
  investments?: FintualGoalInvestment[];
};

export type FintualGoalSnapshot = {
  fetchedAt: string;
  asOfDate: string;
  goals: {
    id: string;
    name: string;
    navClp: number;
    matchedNotes: string | null;
  }[];
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function repoRootFromScriptsDir(): string {
  return path.resolve(__dirname, "../..");
}

export function fintualSessionPath(): string {
  return path.join(repoRootFromScriptsDir(), "server", "data", ".fintual-api-session.json");
}

export function fintualGoalsSnapshotPath(): string {
  return path.join(repoRootFromScriptsDir(), "server", "data", ".fintual-goals-latest.json");
}

export function fintualGoalMapPath(): string {
  return path.join(repoRootFromScriptsDir(), "server", "data", "fintual-goal-map.json");
}

export function loadRootDotenv(): void {
  const p = path.join(repoRootFromScriptsDir(), ".env");
  if (!fs.existsSync(p)) return;
  const text = fs.readFileSync(p, "utf8");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export function requireFintualPasswordEnv(): { email: string; password: string } {
  loadRootDotenv();
  const email = process.env.FINTUAL_EMAIL?.trim();
  const password = process.env.FINTUAL_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "Set FINTUAL_EMAIL and FINTUAL_PASSWORD in the repo-root `.env` (see `.env.example`)."
    );
  }
  return { email, password };
}

/** Token from `POST /api/access_tokens` — Swagger / JSON:API shape. */
export function extractAccessTokenFromLoginJson(body: unknown): string {
  if (!body || typeof body !== "object") throw new Error("Login response is not a JSON object");
  const data = (body as { data?: { attributes?: { token?: unknown } } }).data;
  const token = data?.attributes?.token;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error(
      `Missing data.attributes.token in login JSON: ${JSON.stringify(body).slice(0, 2000)}`
    );
  }
  return token.trim();
}

/** POST /api/access_tokens */
export async function loginFintualApi(email: string, password: string): Promise<{ token: string }> {
  const url = `${FINTUAL_API_BASE}/access_tokens`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...FINTUAL_FETCH_HEADERS },
    body: JSON.stringify({ user: { email, password } }),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`Fintual login HTTP ${res.status}: ${detail}`);
  }
  const token = extractAccessTokenFromLoginJson(body);
  return { token };
}

function readFintualSession(): FintualSession | null {
  const p = fintualSessionPath();
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    const updatedAt = typeof o.updatedAt === "string" ? o.updatedAt : "";
    let email = typeof o.email === "string" ? o.email.trim() : "";
    let token = typeof o.token === "string" ? o.token.trim() : "";
    if (!email && typeof o.apiUserEmail === "string") email = o.apiUserEmail.trim();
    if (!token && typeof o.apiAccessToken === "string") token = o.apiAccessToken.trim();
    if (!email || !token) return null;
    return { email, token, updatedAt: updatedAt || new Date(0).toISOString() };
  } catch {
    return null;
  }
}

function writeFintualSession(session: FintualSession): void {
  const p = fintualSessionPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify(
      { email: session.email, token: session.token, updatedAt: session.updatedAt },
      null,
      2
    ),
    "utf8"
  );
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* ignore on windows */
  }
}

/**
 * Build `Cookie` header value for `_fintual_session_cookie`.
 * Accepts the raw cookie value, `name=value`, or several `;`-separated pairs (as in DevTools).
 */
export function normalizeFintualCookieInput(raw: string): string {
  const t = raw.trim().replace(/^["']|["']$/g, "");
  if (!t) return t;
  if (t.includes(";")) return t;
  if (t.includes("=")) return t;
  return `_fintual_session_cookie=${t}`;
}

/** GET /api/goals — Swagger: `X-User-Email`, `X-User-Token`; optional `Cookie` from `FINTUAL_COOKIE` in `.env`. */
function goalsFetchHeaders(email: string, token: string): Record<string, string> {
  loadRootDotenv();
  const h: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": FINTUAL_FETCH_HEADERS["User-Agent"],
    "X-User-Email": email,
    "X-User-Token": token,
  };
  const cookie = process.env.FINTUAL_COOKIE?.trim();
  if (cookie) {
    h.Cookie = normalizeFintualCookieInput(cookie);
  }
  return h;
}

async function fetchGoalsResponse(email: string, token: string): Promise<Response> {
  return fetch(`${FINTUAL_API_BASE}/goals`, {
    headers: goalsFetchHeaders(email, token),
  });
}

export async function fintualGoalsAuthorized(email: string, token: string): Promise<boolean> {
  try {
    const res = await fetchGoalsResponse(email, token);
    await res.text();
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Returns email + access token, reusing `server/data/.fintual-api-session.json` when still valid,
 * otherwise `POST /access_tokens` and persists after a successful `GET /api/goals` probe.
 */
export async function getValidFintualSession(): Promise<{ email: string; token: string }> {
  const { email, password } = requireFintualPasswordEnv();
  const saved = readFintualSession();
  if (saved && saved.email === email && (await fintualGoalsAuthorized(saved.email, saved.token))) {
    return { email: saved.email, token: saved.token };
  }
  const { token } = await loginFintualApi(email, password);
  const probe = await fetchGoalsResponse(email, token);
  const probeText = await probe.text();
  if (!probe.ok) {
    throw new Error(
      `GET /api/goals returned HTTP ${probe.status} after successful login.\n` +
        `Headers: X-User-Email, X-User-Token (from POST /access_tokens → data.attributes.token)` +
        `${process.env.FINTUAL_COOKIE?.trim() ? ", Cookie (FINTUAL_COOKIE)" : ""}.\n` +
        `If you see 401, set **FINTUAL_COOKIE** in \`.env\` to the \`_fintual_session_cookie\` value from the browser ` +
        `(DevTools → Network → request headers → Cookie), then retry.\n` +
        `Response (truncated): ${probeText.slice(0, 800)}`
    );
  }
  const session: FintualSession = {
    email,
    token,
    updatedAt: new Date().toISOString(),
  };
  writeFintualSession(session);
  return { email, token };
}

/** GET /api/goals — same auth as Swagger. */
export async function fetchFintualGoalsRaw(email: string, token: string): Promise<unknown> {
  const res = await fetchGoalsResponse(email, token);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`Fintual GET /goals HTTP ${res.status}: ${detail}`);
  }
  return body;
}

export function normGoalName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

export function loadGoalIdOverrides(): Record<string, string> {
  const p = fintualGoalMapPath();
  if (!fs.existsSync(p)) return {};
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    if (!j || typeof j !== "object") return {};
    const by = (j as { byGoalId?: unknown }).byGoalId;
    if (!by || typeof by !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(by as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) out[String(k)] = normalizeImportNotes(v.trim());
    }
    return out;
  } catch {
    return {};
  }
}

export function normalizeImportNotes(v: string): string {
  const t = v.trim();
  if (t.startsWith("import:excel|key=")) return t;
  if (/^[\w_]+$/.test(t)) return `import:excel|key=${t}`;
  return t;
}

export function matchGoalToImportNotes(
  goalId: string,
  name: string,
  byGoalId: Record<string, string>
): string | null {
  const ovr = byGoalId[goalId];
  if (ovr) return ovr;

  const n = normGoalName(name);

  if (
    /\bapv[-\s]?b\b|apvb|regimen\s*b/.test(n) ||
    (n.includes("apv") && n.includes("regimen b"))
  ) {
    return "import:excel|key=apv_b";
  }
  if (
    /\bapv[-\s]?a\b|apva|regimen\s*a/.test(n) ||
    (n.includes("apv") && n.includes("regimen a"))
  ) {
    return "import:excel|key=apv_a";
  }
  if (n.includes("risky") && n.includes("norris")) {
    return "import:excel|key=fintual_rn";
  }
  if (n.includes("reserva")) {
    return "import:excel|key=fondo_reserva";
  }
  return null;
}

export function parseGoalsFromResponse(json: unknown): FintualGoalRow[] {
  if (!json || typeof json !== "object") return [];
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const out: FintualGoalRow[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const g = item as { id?: unknown; attributes?: unknown };
    const id = g.id != null ? String(g.id) : "";
    const attrs = g.attributes;
    if (!attrs || typeof attrs !== "object") continue;
    const a = attrs as { name?: unknown; nav?: unknown; investments?: unknown };
    const name = typeof a.name === "string" ? a.name : "";
    const investments: FintualGoalInvestment[] = [];
    if (Array.isArray(a.investments)) {
      for (const raw of a.investments) {
        if (!raw || typeof raw !== "object") continue;
        const o = raw as { weight?: unknown; asset_id?: unknown };
        const weight = typeof o.weight === "number" ? o.weight : Number(o.weight);
        const asset_id = typeof o.asset_id === "number" ? o.asset_id : Number(o.asset_id);
        if (Number.isFinite(weight) && Number.isFinite(asset_id)) {
          investments.push({ weight, asset_id });
        }
      }
    }
    const navRaw = a.nav;
    const nav =
      typeof navRaw === "number"
        ? navRaw
        : typeof navRaw === "string"
          ? Number(navRaw)
          : NaN;
    if (!id || !Number.isFinite(nav)) continue;
    out.push({ id, name, navClp: nav, investments: investments.length ? investments : undefined });
  }
  return out;
}

export function buildGoalsSnapshot(
  goals: FintualGoalRow[],
  byGoalId: Record<string, string>,
  cl: ChileWallClock = chileWallClockNow(),
  asOfDateOverride?: string
): FintualGoalSnapshot {
  const asOfDate = asOfDateOverride ?? fintualValuationAsOfYmd(cl);
  return {
    fetchedAt: new Date().toISOString(),
    asOfDate,
    goals: goals.map((g) => ({
      id: g.id,
      name: g.name,
      navClp: g.navClp,
      matchedNotes: matchGoalToImportNotes(g.id, g.name, byGoalId),
    })),
  };
}

export function writeGoalsSnapshot(snap: FintualGoalSnapshot): void {
  const p = fintualGoalsSnapshotPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(snap, null, 2), "utf8");
}

export function readGoalsSnapshot(): FintualGoalSnapshot {
  const p = fintualGoalsSnapshotPath();
  if (!fs.existsSync(p)) {
    throw new Error(`No snapshot at ${p}. Run: npm run fintual:fetch-goals -w nw-tracker-server`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8")) as FintualGoalSnapshot;
}
