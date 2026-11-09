import type { Page, Response } from "playwright-core";
import { describe, expect, it } from "vitest";
import { Recorder } from "./capture.js";

/** A page that hands every listener one response whose request posted `postData`. */
function pageAnswering(postData: string): Page {
  const response = {
    url: () => "https://bank.test/api/login",
    status: () => 200,
    json: async () => ({ ok: true }),
    request: () => ({ resourceType: () => "fetch", postData: () => postData }),
  } as unknown as Response;
  return { on: (_event: string, listener: (r: Response) => void) => listener(response) } as unknown as Page;
}

async function recordedRequestBody(postData: string): Promise<unknown> {
  const recorder = new Recorder(false, "t", "afp-uno", "bank.test");
  recorder.redactSecrets(['p@ss "w0rd"']);
  recorder.attach(pageAnswering(postData));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(recorder.calls).toHaveLength(1);
  return recorder.calls[0]!.requestBody;
}

describe("Recorder secret redaction", () => {
  it("removes the clave from JSON and form-encoded bodies of a recorded call", async () => {
    expect(await recordedRequestBody(JSON.stringify({ rut: "1-9", clave: 'p@ss "w0rd"' }))).toEqual({ rut: "1-9", clave: "«redacted»" });
    expect(await recordedRequestBody(`rut=1-9&clave=${encodeURIComponent('p@ss "w0rd"')}`)).toBe("rut=1-9&clave=«redacted»");
    expect(await recordedRequestBody("rut=1-9&clave=p%40ss+%22w0rd%22")).toBe("rut=1-9&clave=«redacted»");
  });
});
