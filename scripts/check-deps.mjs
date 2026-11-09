/**
 * Dependency guard (docs/untangle-plan.md F1): the TypeScript import graph of server/src,
 * client/src, ingest/src and server/contracts/src (tests excluded) against a committed baseline,
 * `scripts/check-deps.baseline.json`. It fails when
 *
 * 1. a file joins an import cycle that the baseline does not list (cycles may only shrink);
 * 2. a new edge crosses a forbidden boundary: server/contracts/src → server/src, client or ingest;
 *    client ↔ server/src; ingest ↔ server/src (contracts is the only shared code);
 * 3. `server/src/cacheRegistry.ts` imports a module the baseline does not list (the cache registry must not
 *    learn about more domain modules).
 *
 * It prints the largest cycle, the total edge count against the baseline's, and the top fan-in,
 * fan-out and transitive-reach files. Type-only imports count: they tie the files together all the
 * same. `--write-baseline` rewrites the baseline from the current tree — only when a change shrinks
 * the graph, or deliberately accepts a new edge.
 *
 * Run: `node scripts/check-deps.mjs` (root) — part of `npm run check:conventions`.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const ROOTS = ["server/src", "client/src", "ingest/src", "server/contracts/src"];
const BASELINE = path.join(ROOT, "scripts", "check-deps.baseline.json");
const CONTRACTS_ENTRY = "server/contracts/src/index.ts";
const AGGREGATION_CACHE = "server/src/cacheRegistry.ts";

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "test" || entry.name === "__tests__") continue;
      yield* walk(p);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      yield p;
    }
  }
}

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join("/");

const files = new Set();
for (const r of ROOTS) for (const f of walk(path.join(ROOT, r))) files.add(rel(f));

/** Comments blanked so a commented-out import is no edge. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

const SPECIFIER = /(?:\bimport|\bexport)\s+(?:type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

function resolve(fromFile, spec) {
  if (spec === "nw-tracker-contracts") return CONTRACTS_ENTRY;
  if (spec.startsWith("nw-tracker-contracts/")) {
    const sub = `server/contracts/src/${spec.slice("nw-tracker-contracts/".length)}`;
    for (const c of [`${sub}.ts`, `${sub}/index.ts`]) if (files.has(c)) return c;
    return null;
  }
  if (!spec.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  const stem = base.replace(/\.(js|jsx|ts|tsx|mjs)$/, "");
  for (const c of [`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, `${stem}/index.tsx`, base]) {
    if (files.has(c)) return c;
  }
  return null;
}

/** file → sorted unique imported files */
const graph = new Map();
for (const f of files) {
  const src = stripComments(fs.readFileSync(path.join(ROOT, f), "utf8"));
  const out = new Set();
  for (const m of src.matchAll(SPECIFIER)) {
    const target = resolve(f, m[1] ?? m[2]);
    if (target && target !== f) out.add(target);
  }
  graph.set(f, [...out].sort());
}

// --- strongly connected components (iterative Tarjan) ---
const index = new Map();
const low = new Map();
const onStack = new Set();
const stack = [];
const sccs = [];
let counter = 0;
for (const start of [...files].sort()) {
  if (index.has(start)) continue;
  const work = [[start, 0]];
  index.set(start, counter);
  low.set(start, counter);
  counter++;
  stack.push(start);
  onStack.add(start);
  while (work.length) {
    const frame = work[work.length - 1];
    const [v, i] = frame;
    const succ = graph.get(v);
    if (i < succ.length) {
      frame[1]++;
      const w = succ[i];
      if (!index.has(w)) {
        index.set(w, counter);
        low.set(w, counter);
        counter++;
        stack.push(w);
        onStack.add(w);
        work.push([w, 0]);
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
      continue;
    }
    work.pop();
    if (work.length) {
      const parent = work[work.length - 1][0];
      low.set(parent, Math.min(low.get(parent), low.get(v)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      sccs.push(comp.sort());
    }
  }
}
const cycles = sccs.filter((c) => c.length > 1).sort((a, b) => b.length - a.length);
const cycleMembers = new Set(cycles.flat());

// --- transitive reach through the condensation (Tarjan emits components in reverse topological order) ---
const compOf = new Map();
sccs.forEach((c, i) => c.forEach((f) => compOf.set(f, i)));
const reachOfComp = new Array(sccs.length);
for (let i = 0; i < sccs.length; i++) {
  const reach = new Set(sccs[i]);
  for (const f of sccs[i]) {
    for (const w of graph.get(f)) {
      const j = compOf.get(w);
      if (j !== i) for (const x of reachOfComp[j]) reach.add(x);
    }
  }
  reachOfComp[i] = reach;
}
const reachSize = (f) => reachOfComp[compOf.get(f)].size - 1;

// --- boundaries ---
function area(f) {
  if (f.startsWith("server/contracts/src/")) return "contracts";
  if (f.startsWith("server/src/")) return "server";
  if (f.startsWith("client/src/")) return "client";
  if (f.startsWith("ingest/src/")) return "ingest";
  return "other";
}
const FORBIDDEN = new Set([
  "contracts>server",
  "contracts>client",
  "contracts>ingest",
  "client>server",
  "server>client",
  "ingest>server",
  "server>ingest",
]);
const crossEdges = [];
let edgeCount = 0;
for (const [f, outs] of graph) {
  for (const t of outs) {
    edgeCount++;
    if (FORBIDDEN.has(`${area(f)}>${area(t)}`)) crossEdges.push(`${f} -> ${t}`);
  }
}
crossEdges.sort();
const cacheImports = graph.get(AGGREGATION_CACHE) ?? [];

const current = {
  note: "Written by `node scripts/check-deps.mjs --write-baseline`. Cycles and the listed edges may only shrink.",
  edge_count: edgeCount,
  largest_cycle: cycles[0]?.length ?? 0,
  cycle_members: [...cycleMembers].sort(),
  forbidden_edges: crossEdges,
  aggregation_cache_imports: cacheImports,
};

if (process.argv.includes("--write-baseline")) {
  fs.writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`check-deps: baseline written (${files.size} files, ${edgeCount} edges, ${cycleMembers.size} files in cycles)`);
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
  console.error("check-deps: no baseline; run `node scripts/check-deps.mjs --write-baseline`");
  process.exit(1);
}
const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
const problems = [];
const baseCycle = new Set(baseline.cycle_members);
for (const f of cycleMembers) if (!baseCycle.has(f)) problems.push(`joins an import cycle: ${f}`);
const baseCross = new Set(baseline.forbidden_edges);
for (const e of crossEdges) if (!baseCross.has(e)) problems.push(`crosses a forbidden boundary: ${e}`);
const baseCache = new Set(baseline.aggregation_cache_imports);
for (const t of cacheImports) if (!baseCache.has(t)) problems.push(`cacheRegistry.ts imports a new module: ${t}`);

const top = (pairs) =>
  pairs
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([f, n]) => `${n} ${f}`)
    .join(", ");
const fanIn = new Map([...files].map((f) => [f, 0]));
for (const outs of graph.values()) for (const t of outs) fanIn.set(t, fanIn.get(t) + 1);
console.log(
  `check-deps: ${files.size} files, ${edgeCount} edges (baseline ${baseline.edge_count}); ` +
    `largest cycle ${current.largest_cycle} files (baseline ${baseline.largest_cycle}), ` +
    `${cycleMembers.size} files in cycles (baseline ${baseCycle.size})`
);
console.log(`  fan-in:  ${top([...fanIn])}`);
console.log(`  fan-out: ${top([...graph].map(([f, o]) => [f, o.length]))}`);
console.log(`  reach:   ${top([...files].map((f) => [f, reachSize(f)]))}`);

const shrunk =
  [...baseCycle].some((f) => !cycleMembers.has(f)) ||
  [...baseCross].some((e) => !crossEdges.includes(e)) ||
  [...baseCache].some((t) => !cacheImports.includes(t));
if (problems.length) {
  console.error(`check-deps: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
if (shrunk) console.log("  the graph shrank below the baseline: run with --write-baseline to lock it in");
console.log("check-deps: ok");
