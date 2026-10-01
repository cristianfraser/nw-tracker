import { describe, expect, it } from "vitest";
import { Recorder } from "./capture.js";

describe("Recorder secret redaction", () => {
  it("removes the clave from JSON and form-encoded bodies", () => {
    const recorder = new Recorder(false, "t", "afp-uno");
    recorder.redactSecrets(['p@ss "w0rd"']);
    const redact = (v: unknown) => (recorder as unknown as { redact: (x: unknown) => unknown }).redact(v);
    expect(redact({ requestBody: { rut: "1-9", clave: 'p@ss "w0rd"' } })).toEqual({ requestBody: { rut: "1-9", clave: "«redacted»" } });
    expect(redact({ requestBody: `rut=1-9&clave=${encodeURIComponent('p@ss "w0rd"')}` })).toEqual({ requestBody: "rut=1-9&clave=«redacted»" });
    expect(redact({ requestBody: "rut=1-9&clave=p%40ss+%22w0rd%22" })).toEqual({ requestBody: "rut=1-9&clave=«redacted»" });
  });
});
