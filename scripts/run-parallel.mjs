#!/usr/bin/env node
// Runs shell commands concurrently, prefixing every output line with its label.
// Usage: node run-parallel.mjs "label=command" "label=command" ...
// Exits 0 only when every command exits 0; otherwise with the first non-zero code (in
// completion order) after all have finished. SIGINT/SIGTERM stop the children.
import { spawn } from "node:child_process";

const specs = process.argv.slice(2).map((arg) => {
  const i = arg.indexOf("=");
  if (i <= 0) throw new Error(`expected "label=command", got: ${arg}`);
  return { label: arg.slice(0, i), command: arg.slice(i + 1) };
});
if (specs.length === 0) throw new Error("no commands given");

const children = [];
let exitCode = 0;
let pending = specs.length;

function pipeLines(stream, label, out) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) out.write(`[${label}] ${line}\n`);
  });
  stream.on("end", () => {
    if (buf) out.write(`[${label}] ${buf}\n`);
  });
}

for (const { label, command } of specs) {
  const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"], detached: true });
  children.push(child);
  pipeLines(child.stdout, label, process.stdout);
  pipeLines(child.stderr, label, process.stderr);
  child.on("close", (code, signal) => {
    const c = code ?? (signal ? 1 : 0);
    if (c !== 0 && exitCode === 0) exitCode = c;
    process.stderr.write(`[${label}] exited with ${c}\n`);
    if (--pending === 0) process.exit(exitCode);
  });
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const c of children) {
      try {
        process.kill(-c.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    exitCode = exitCode || 130;
  });
}
