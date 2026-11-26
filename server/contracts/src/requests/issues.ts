import { z } from "zod";

/**
 * What a write route answers for a body its schema refuses: one sentence naming the first failing
 * field (`{ error }`, read by the client's `apiErrorMessage`).
 *
 * - a missing field: «<field> is required»;
 * - a message the schema wrote that already names its field («label required», «dfl2 must be a
 *   boolean», «invalid color_rgb»): that message as it is, a missing field included;
 * - any other: «<field>: <zod's message>»;
 * - a body that is no JSON object: «request body must be a JSON object».
 */
export function requestIssueMessage(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String).join(".");
  if (path === "") {
    return issue.code === "invalid_type" ? "request body must be a JSON object" : issue.message;
  }
  if (namesField(issue.message, path)) return issue.message;
  if (issue.code === "invalid_type" && issue.input === undefined) return `${path} is required`;
  return `${path}: ${issue.message}`;
}

/** Whether `message` names the field `path` as a word of its own («invalid color_rgb», not «Invalid» for `id`). */
function namesField(message: string, path: string): boolean {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w.])${escaped}($|[^\\w.])`).test(message);
}

/** The request body as `schema` reads it, or the sentence naming why not. */
export function parseRequestBody<S extends z.ZodType>(
  schema: S,
  body: unknown
): { ok: true; data: z.output<S> } | { ok: false; error: string } {
  // An absent body (no JSON content type) reads as `{}`: its fields are then missing by name.
  const r = schema.safeParse(body ?? {}, { reportInput: true });
  if (r.success) return { ok: true, data: r.data };
  const first = r.error.issues[0];
  return { ok: false, error: first ? requestIssueMessage(first) : "invalid request body" };
}
