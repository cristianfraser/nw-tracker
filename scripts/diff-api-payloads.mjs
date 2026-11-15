#!/usr/bin/env node
/**
 * Compare two dumps made by `scripts/dump-api-payloads.mjs`.
 *
 *   node scripts/diff-api-payloads.mjs --a=<dir> --b=<dir> [--max-paths=5] [--max-files=0]
 *
 * Lists the files present on one side only and, for each file that differs, the first
 * differing JSON paths with both values (cut to 80 characters), then a summary. `timings.json`
 * is ignored (durations). Exit code 1 when anything differs, 0 when the dumps are identical.
 */
import fs from "node:fs";
import path from "node:path";

function arg(name, fallback = null) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const dirA = arg("a");
const dirB = arg("b");
if (!dirA || !dirB) {
  console.error("usage: node scripts/diff-api-payloads.mjs --a=<dir> --b=<dir> [--max-paths=5] [--max-files=0]");
  process.exit(2);
}
const maxPaths = Number(arg("max-paths", "5"));
const maxFiles = Number(arg("max-files", "0"));
const IGNORED = new Set(["timings.json"]);

const list = (dir) => new Set(fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !IGNORED.has(f)));
const filesA = list(dirA);
const filesB = list(dirB);

const show = (v) => {
  const s = v === undefined ? "(absent)" : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
};

/** Differing leaf paths of two JSON values, at most `limit` (the total is counted on). */
function diffPaths(a, b, at, out, limit) {
  if (a === b) return;
  const aObj = a !== null && typeof a === "object";
  const bObj = b !== null && typeof b === "object";
  if (!aObj || !bObj || Array.isArray(a) !== Array.isArray(b)) {
    out.count += 1;
    if (out.paths.length < limit) out.paths.push({ at: at || "(root)", a, b });
    return;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) {
      out.count += 1;
      if (out.paths.length < limit) out.paths.push({ at: `${at}.length`, a: a.length, b: b.length });
    }
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) diffPaths(a[i], b[i], `${at}[${i}]`, out, limit);
    return;
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const k of keys) diffPaths(a[k], b[k], at ? `${at}.${k}` : k, out, limit);
}

const onlyA = [...filesA].filter((f) => !filesB.has(f)).sort();
const onlyB = [...filesB].filter((f) => !filesA.has(f)).sort();
const common = [...filesA].filter((f) => filesB.has(f)).sort();

for (const f of onlyA) console.log(`only in a: ${f}`);
for (const f of onlyB) console.log(`only in b: ${f}`);

let differing = 0;
let shown = 0;
for (const f of common) {
  const textA = fs.readFileSync(path.join(dirA, f), "utf8");
  const textB = fs.readFileSync(path.join(dirB, f), "utf8");
  if (textA === textB) continue;
  differing += 1;
  if (maxFiles > 0 && shown >= maxFiles) continue;
  shown += 1;
  const out = { count: 0, paths: [] };
  diffPaths(JSON.parse(textA), JSON.parse(textB), "", out, maxPaths);
  console.log(`\ndiffers: ${f} (${out.count} path${out.count === 1 ? "" : "s"})`);
  for (const p of out.paths) {
    console.log(`  ${p.at}`);
    console.log(`    a: ${show(p.a)}`);
    console.log(`    b: ${show(p.b)}`);
  }
  if (out.count > out.paths.length) console.log(`  ... ${out.count - out.paths.length} more`);
}
if (maxFiles > 0 && differing > shown) console.log(`\n... ${differing - shown} more differing files not shown`);

console.log(
  `\n${common.length} files compared · ${differing} differ · ${onlyA.length} only in a · ${onlyB.length} only in b`
);
process.exit(differing + onlyA.length + onlyB.length > 0 ? 1 : 0);
