/**
 * Saved-payload guard: a payload the client keeps in localStorage (`persistedPayload(…)`,
 * client/src/queries/persistedPayloadCache.ts) is read back under its version only, so a change to
 * its shape needs a version bump (`DTO_SCHEMA_VERSIONS` in contracts, or the client's own
 * `CLIENT_SCHEMA_VERSIONS`), or a browser that saved the old shape feeds it to the new code. On
 * 2026-11-23 a renamed expense-row field (96b8cebf) reached the home page's stored «Últimos
 * movimientos» without a bump and the page failed on every phone that had it.
 *
 * For each `persistedPayload("<name>", isValid)` call in client/src this expands the type it stores
 * (the `T` of `PersistedPayload<T>`), every nested and shared type included, into one canonical text
 * (properties sorted, unions sorted) and hashes it. `client/src/queries/persistedPayloadFingerprints.json`
 * holds `{ <name>: { version, hash } }`. It fails when
 *
 * 1. a payload's hash changed and its version did not: bump the version;
 * 2. a version, a hash or a name differs from the file otherwise (a bump, a new or removed
 *    payload): run with `--write` to record it.
 *
 * It cannot see a change of meaning with the same type (a field switching currency): that bump
 * stays a decision. Run: `node scripts/check-persisted-payloads.mjs [--write]` (root) — part of
 * `npm run check:conventions`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const CLIENT_SRC = path.join(ROOT, "client", "src");
const CACHE_MODULE = path.join(CLIENT_SRC, "queries", "persistedPayloadCache.ts");
const FINGERPRINTS = path.join(CLIENT_SRC, "queries", "persistedPayloadFingerprints.json");
const WRITE = process.argv.includes("--write");

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) yield p;
  }
}

// Only the files that store a payload (and the cache module, for the versions) are roots; the
// program follows their imports.
const roots = [...walk(CLIENT_SRC)].filter((f) => f === CACHE_MODULE || fs.readFileSync(f, "utf8").includes("persistedPayload"));

const config = ts.getParsedCommandLineOfConfigFile(path.join(ROOT, "client", "tsconfig.json"), {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (d) => {
    throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  },
});
const program = ts.createProgram(roots, { ...config.options, noEmit: true });
const checker = program.getTypeChecker();

function fail(message) {
  console.error(`check-persisted-payloads: ${message}`);
  process.exitCode = 1;
}

// The version each name is read under: the literal types of `PERSISTED_PAYLOAD_VERSIONS` (`as const`).
function readVersions() {
  const source = program.getSourceFile(CACHE_MODULE);
  const symbol = checker.getSymbolAtLocation(source)?.exports?.get("PERSISTED_PAYLOAD_VERSIONS");
  if (!symbol) throw new Error("PERSISTED_PAYLOAD_VERSIONS not found in persistedPayloadCache.ts");
  const versions = new Map();
  for (const prop of checker.getPropertiesOfType(checker.getTypeOfSymbol(symbol))) {
    const t = checker.getTypeOfSymbol(prop);
    if (!t.isNumberLiteral()) throw new Error(`PERSISTED_PAYLOAD_VERSIONS.${prop.name} is not a number literal`);
    versions.set(prop.name, t.value);
  }
  return versions;
}

/** One canonical text per type: structure only, independent of names, order and file layout. */
function canonical(type, stack = []) {
  if (stack.includes(type)) return `#${stack.length - stack.indexOf(type)}`;
  const flags = type.flags;
  if (flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.BigIntLiteral)) {
    return checker.typeToString(type);
  }
  if (
    flags &
    (ts.TypeFlags.String | ts.TypeFlags.Number | ts.TypeFlags.Boolean | ts.TypeFlags.BigInt | ts.TypeFlags.Null |
      ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)
  ) {
    return checker.typeToString(type);
  }
  const inner = [...stack, type];
  if (type.isUnion()) return `(${type.types.map((t) => canonical(t, inner)).sort().join("|")})`;
  if (checker.isTupleType(type)) return `[${checker.getTypeArguments(type).map((t) => canonical(t, inner)).join(",")}]`;
  if (checker.isArrayType(type)) return `${canonical(checker.getTypeArguments(type)[0], inner)}[]`;
  if (type.getCallSignatures().length > 0) return "fn";
  // Objects and intersections: their properties, sorted, and index signatures.
  const parts = checker
    .getPropertiesOfType(type)
    .map((p) => {
      const optional = p.flags & ts.SymbolFlags.Optional ? "?" : "";
      return `${p.name}${optional}:${canonical(checker.getTypeOfSymbol(p), inner)}`;
    })
    .sort();
  for (const info of checker.getIndexInfosOfType(type)) {
    parts.push(`[${canonical(info.keyType, inner)}]:${canonical(info.type, inner)}`);
  }
  return `{${parts.join(";")}}`;
}

// Every `persistedPayload("<name>", …)` call and the type it stores.
function storedTypes() {
  const found = new Map();
  for (const file of roots) {
    const source = program.getSourceFile(file);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "persistedPayload") {
        const [nameArg] = node.arguments;
        const where = `${path.relative(ROOT, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        if (!nameArg || !ts.isStringLiteral(nameArg)) throw new Error(`${where}: persistedPayload's name must be a string literal`);
        const [stored] = checker.getTypeArguments(checker.getTypeAtLocation(node));
        if (!stored) throw new Error(`${where}: no stored type for ${nameArg.text}`);
        if (found.has(nameArg.text)) throw new Error(`${where}: ${nameArg.text} is stored by two calls`);
        found.set(nameArg.text, { type: stored, where });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

const versions = readVersions();
const current = {};
for (const [name, { type, where }] of [...storedTypes()].sort(([a], [b]) => a.localeCompare(b))) {
  if (!versions.has(name)) throw new Error(`${where}: ${name} has no version in PERSISTED_PAYLOAD_VERSIONS`);
  const hash = crypto.createHash("sha256").update(canonical(type)).digest("hex").slice(0, 16);
  current[name] = { version: versions.get(name), hash };
}

if (WRITE) {
  fs.writeFileSync(FINGERPRINTS, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`check-persisted-payloads: wrote ${Object.keys(current).length} fingerprints`);
} else {
  const recorded = fs.existsSync(FINGERPRINTS) ? JSON.parse(fs.readFileSync(FINGERPRINTS, "utf8")) : {};
  const write = "run `node scripts/check-persisted-payloads.mjs --write`";
  for (const [name, now] of Object.entries(current)) {
    const was = recorded[name];
    if (!was) fail(`${name} is a new saved payload: ${write}`);
    else if (was.hash !== now.hash && was.version === now.version) {
      fail(
        `${name} changed shape but is still read under version ${now.version}: bump it (DTO_SCHEMA_VERSIONS in ` +
          `server/contracts/src/dto/schemaVersions.ts, or CLIENT_SCHEMA_VERSIONS), then ${write}`
      );
    } else if (was.hash !== now.hash || was.version !== now.version) fail(`${name}: version ${was.version} → ${now.version}; ${write}`);
  }
  for (const name of Object.keys(recorded)) if (!current[name]) fail(`${name} is no longer saved: ${write}`);
  if (!process.exitCode) console.log(`check-persisted-payloads: ok (${Object.keys(current).length} saved payloads)`);
}
