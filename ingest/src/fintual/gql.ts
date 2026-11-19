/**
 * One query to Fintual's own `/gql/` with the session cookie the server's evening Fintual poll uses
 * (`FINTUAL_COOKIE` in the root `.env`). The queries are the ones Fintual's web app sends (its
 * bundle carries their text). An HTTP error, a GraphQL error or a non-JSON answer throws.
 */
import { loadRootDotenv } from "../rootDotenv.js";

export const FINTUAL_GQL_URL = "https://fintual.cl/gql/";

export function fintualSessionCookie(): string {
  loadRootDotenv();
  const raw = process.env.FINTUAL_COOKIE?.trim().replace(/^["']|["']$/g, "");
  if (!raw) throw new Error("FINTUAL_COOKIE is not set in the root .env (the session cookie the Fintual poll uses)");
  return raw.includes("=") ? raw : `_fintual_session_cookie=${raw}`;
}

export async function fintualGql(
  operation: string,
  query: string,
  variables: Record<string, unknown>,
  opts: { cookie?: string; referer: string }
): Promise<unknown> {
  const res = await fetch(FINTUAL_GQL_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: "https://fintual.cl",
      Referer: opts.referer,
      Cookie: opts.cookie ?? fintualSessionCookie(),
    },
    body: JSON.stringify({ operationName: operation, query, variables }),
  });
  const text = await res.text();
  let body: { data?: unknown; errors?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error(`Fintual /gql ${operation}: non-JSON HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok || (Array.isArray(body.errors) && body.errors.length > 0)) {
    throw new Error(`Fintual /gql ${operation}: HTTP ${res.status} ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
  }
  return body.data;
}
