#!/usr/bin/env node
// Pre-push check, run by .githooks/pre-push. Reads git's pre-push stdin
// (`<local ref> <local sha> <remote ref> <remote sha>` per line), computes the files the push
// adds, typechecks the affected workspaces in parallel plus `npm run check:conventions`, and
// fails when the whole run exceeds the budget (naming the slow steps).
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 30 s: measured 6.3 s under a test run on the laptop, but several Claude sessions working at
// once push a warm run of all four workspaces past 17 s with nothing wrong.
const BUDGET_MS = 30000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZERO = /^0+$/;
const WORKSPACES = ["server/contracts", "server", "client", "ingest"];

function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function stdinText() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Files a push adds, or null when no base commit can be found (then every workspace is checked).
function changedFiles(lines) {
  const files = new Set();
  for (const line of lines) {
    const [, localSha, , remoteSha] = line.split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue; // a deletion pushes nothing
    let base = remoteSha && !ZERO.test(remoteSha) ? remoteSha : null;
    // A remote commit we never fetched behaves like a new branch.
    if (base && git(["cat-file", "-e", `${base}^{commit}`]) === null) base = null;
    if (!base) {
      for (const ref of ["origin/main", "main"]) {
        base = git(["merge-base", localSha, ref]);
        if (base) break;
      }
    }
    if (!base) {
      console.error("pre-push: no base commit to diff against; checking all workspaces");
      return null;
    }
    const out = git(["diff", "--name-only", `${base}..${localSha}`]);
    if (out === null) return null;
    for (const f of out.split("\n").filter(Boolean)) files.add(f);
  }
  return files;
}

function affectedWorkspaces(files) {
  if (files === null) return new Set(WORKSPACES);
  const ws = new Set();
  for (const f of files) {
    if (f.startsWith("server/contracts/") || f === "package.json" || f === "package-lock.json" || /^tsconfig[^/]*$/.test(f)) {
      for (const w of WORKSPACES) ws.add(w);
    } else if (f.startsWith("server/")) ws.add("server");
    else if (f.startsWith("client/")) ws.add("client");
    else if (f.startsWith("ingest/")) ws.add("ingest");
  }
  return ws;
}

const pushLines = stdinText().split("\n").filter(Boolean);

// origin/main moves only from the local `main` branch. A branch pushed to `main` from a worktree
// (`git push origin <branch>:main`) leaves the main checkout's `main` behind, and the next commit
// there rebases onto work it never saw (2026-11-27: 29 commits). Merge into `main` in the main
// checkout (`git merge --ff-only <branch>`) and push `main` from there.
const toMain = pushLines.filter((line) => {
  const [localRef, , remoteRef] = line.split(/\s+/);
  return remoteRef === "refs/heads/main" && localRef !== "refs/heads/main";
});
if (toMain.length > 0) {
  console.error(
    `pre-push: refusing to update origin/main from ${toMain.map((l) => l.split(/\s+/)[0]).join(", ")}.\n` +
      "Merge the branch into the local `main` in the main checkout (git merge --ff-only <branch>) and push `main` from there,\n" +
      "so the local `main` never falls behind origin/main."
  );
  process.exit(1);
}

const files = changedFiles(pushLines);
const workspaces = affectedWorkspaces(files);
// Same command as each workspace's `typecheck` script (TypeScript 7 through scripts/tsc.mjs).
const steps = [
  ...[...workspaces].map((w) => ({
    name: `typecheck ${w}`,
    cmd: process.execPath,
    args: [path.join(ROOT, "scripts/tsc.mjs"), "--noEmit"],
    cwd: path.join(ROOT, w),
  })),
  { name: "check:conventions", cmd: "npm", args: ["run", "--silent", "check:conventions"], cwd: ROOT },
];

const started = Date.now();
const running = new Set();
const children = [];
let timedOut = false;
const results = steps.map(
  (s) =>
    new Promise((resolve) => {
      const t0 = Date.now();
      const child = spawn(s.cmd, s.args, { cwd: s.cwd, stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      running.add(s.name);
      let finished = false;
      const finish = (code) => {
        if (finished) return;
        finished = true;
        running.delete(s.name);
        const sec = (Date.now() - t0) / 1000;
        console.log(`pre-push: ${code === 0 ? "ok  " : "FAIL"} ${s.name} ${sec.toFixed(1)}s`);
        resolve({ name: s.name, code, sec, out });
      };
      child.on("close", (code) => finish(code ?? 1));
      child.on("error", (e) => {
        out += String(e);
        finish(1);
      });
    }),
);

const timer = setTimeout(() => {
  timedOut = true;
  console.error(`pre-push: over the ${BUDGET_MS / 1000}s budget; still running: ${[...running].join(", ")}`);
  for (const c of children) c.kill("SIGKILL");
}, BUDGET_MS);

const done = await Promise.all(results);
clearTimeout(timer);
const total = (Date.now() - started) / 1000;
if (timedOut) {
  const slowest = [...done].sort((a, b) => b.sec - a.sec)[0].name;
  console.error(`pre-push: FAILED, exceeded the ${BUDGET_MS / 1000}s budget (total ${total.toFixed(1)}s). Slowest step: ${slowest}. Fix or trim that step; do not push with --no-verify.`);
  process.exit(1);
}
let failed = false;
for (const r of done) {
  if (r.code !== 0) {
    failed = true;
    console.error(`\n--- ${r.name} ---\n${r.out.trim()}\n`);
  }
}
if (failed) {
  console.error(`pre-push: FAILED (${total.toFixed(1)}s). Fix the errors above; do not push with --no-verify.`);
  process.exit(1);
}
console.log(`pre-push: ok, total ${total.toFixed(1)}s (${workspaces.size ? [...workspaces].join(", ") : "no TS workspaces"})`);
