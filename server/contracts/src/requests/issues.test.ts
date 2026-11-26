import { describe, expect, it } from "vitest";
import { z } from "zod";
import { requiredText, rowIdSchema } from "./fields.js";
import { parseRequestBody } from "./issues.js";

const schema = z
  .object({
    id: rowIdSchema,
    label: requiredText("label required"),
    tags: z.array(z.object({ key: z.string() })).optional(),
    a: z.boolean().optional(),
  })
  .refine((b) => b.a !== false, { message: "a may not be false" });

describe("parseRequestBody", () => {
  it("reads a body the schema takes, trimmed text included", () => {
    expect(parseRequestBody(schema, { id: 3, label: "  x ", extra: 1 })).toEqual({ ok: true, data: { id: 3, label: "x" } });
  });

  it("names a missing field", () => {
    expect(parseRequestBody(schema, { label: "x" })).toEqual({ ok: false, error: "id is required" });
  });

  it("an absent body reads as an empty object", () => {
    expect(parseRequestBody(schema, undefined)).toEqual({ ok: false, error: "id is required" });
  });

  it("keeps a message that already names its field", () => {
    expect(parseRequestBody(schema, { id: 1, label: "   " })).toEqual({ ok: false, error: "label required" });
    expect(parseRequestBody(schema, { id: 1 })).toEqual({ ok: false, error: "label required" });
  });

  it("prefixes zod's message with the field's path", () => {
    const r = parseRequestBody(schema, { id: 0, label: "x" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/^id: /);
    expect(parseRequestBody(schema, { id: 1, label: "x", tags: [{ key: 2 }] })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^tags\.0\.key: /),
    });
  });

  it("a body-level rule answers its own message; a body that is no object says so", () => {
    expect(parseRequestBody(schema, { id: 1, label: "x", a: false })).toEqual({ ok: false, error: "a may not be false" });
    expect(parseRequestBody(schema, [1, 2])).toEqual({ ok: false, error: "request body must be a JSON object" });
  });
});
