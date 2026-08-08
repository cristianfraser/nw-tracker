/** Timestamped stderr logging. Secrets never reach this module — nothing here needs redaction. */
export function log(message: string): void {
  const stamp = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[${stamp}] ${message}\n`);
}

export function logStep(step: string): void {
  log(`▸ ${step}`);
}
