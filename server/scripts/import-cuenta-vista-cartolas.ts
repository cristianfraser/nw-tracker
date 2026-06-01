import { importCuentaVistaCartolasFromPdfs } from "../src/cuentaVistaCartolaImport.js";

function main() {
  const wipe = process.argv.includes("--wipe");
  const dryRun = process.argv.includes("--dry-run");
  const skipPdfParse = process.argv.includes("--skip-pdf-parse");
  const forceReimport = process.argv.includes("--force-reimport");
  const dirArg = process.argv.find((a) => a.startsWith("--dir="));
  const dir = dirArg?.slice("--dir=".length);

  const result = importCuentaVistaCartolasFromPdfs({
    wipe,
    dryRun,
    skipPdfParse,
    forceReimport,
    pdfsDir: dir,
  });

  if (result.errors.length) {
    process.exit(1);
  }
}

main();
