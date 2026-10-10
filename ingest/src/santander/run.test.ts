import { describe, expect, it } from "vitest";
import { sessionVerdict } from "./run.js";

const PRIVATE = "https://mibanco.santander.cl/UI.Web.HB/Private_new/frame/#/private/saldos/main/movimientos";
const PUBLIC = "https://banco.santander.cl/";

describe("sessionVerdict", () => {
  it("a private route that held still is logged in", () => {
    expect(sessionVerdict(PRIVATE, PRIVATE)).toBe("logged_in");
  });

  it("the public site that held still is logged out", () => {
    expect(sessionVerdict(PUBLIC, PUBLIC)).toBe("logged_out");
  });

  it("a URL that changed between the reads is a navigation in flight — no verdict", () => {
    // The inactivity logout: the first read still says private, the second the public site.
    expect(sessionVerdict(PRIVATE, PUBLIC)).toBe("moving");
    expect(sessionVerdict(PUBLIC, PRIVATE)).toBe("moving");
  });
});
