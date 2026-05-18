/**
 * One-off: print Fintual API token (same login as `fintualApiLib` / fetch-goals).
 *
 * Usage (repo root):
 *   npm run fintual:token -w nw-tracker-server
 *   FINTUAL_QUIET_TOKEN=1 npm run fintual:token -w nw-tracker-server
 */
import {
  loadRootDotenv,
  loginFintualApi,
  requireFintualPasswordEnv,
} from "./fintualApiLib.js";

function maskToken(tok: string): string {
  if (tok.length <= 12) return `${tok.slice(0, 4)}…`;
  return `${tok.slice(0, 6)}…${tok.slice(-4)}`;
}

function quietStdoutToken(): boolean {
  return /^(1|true|yes)$/i.test(String(process.env.FINTUAL_QUIET_TOKEN ?? "").trim());
}

async function main(): Promise<void> {
  loadRootDotenv();
  const { email, password } = requireFintualPasswordEnv();
  const { token } = await loginFintualApi(email, password);

  if (quietStdoutToken()) {
    process.stdout.write(`${token}\n`);
    return;
  }

  console.error("Do not commit, paste into tickets, or log this token.\n");
  console.log("Fintual API access token obtained.\n");
  console.log("Authenticated requests use headers (see GET /api/goals in Swagger):");
  console.log(`  X-User-Email: ${email}`);
  console.log(`  X-User-Token: ${token}\n`);
  console.log(`Preview (masked): ${maskToken(token)}`);
  console.log(
    "\nFor scripts: FINTUAL_QUIET_TOKEN=1 npm run fintual:token -w nw-tracker-server  → stdout is only the token."
  );
  console.log(
    "\nPrefer: npm run fintual:fetch-goals -w nw-tracker-server (stores token in server/data/.fintual-api-session.json)."
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
