import { describe, expect, it } from "vitest";
import { apiErrorMessage } from "./api";

describe("apiErrorMessage", () => {
  it("unwraps the server's { error } body", () => {
    expect(
      apiErrorMessage(JSON.stringify({ error: "Credit card master 7 has no credit_card_account_config.card_last4" }))
    ).toBe("Credit card master 7 has no credit_card_account_config.card_last4");
  });

  it("keeps any other body as the message", () => {
    expect(apiErrorMessage("upstream timeout")).toBe("upstream timeout");
    expect(apiErrorMessage(JSON.stringify({ errors: ["a", "b"] }))).toBe('{"errors":["a","b"]}');
    expect(apiErrorMessage(JSON.stringify({ error: "" }))).toBe('{"error":""}');
  });

  it("words a coded error itself: a movement a cartola on file contradicts", () => {
    const body = JSON.stringify({ error: "server English", code: "checking_ledger_contradicted", account_id: 22, month: "2026-09", difference: 5000 });
    const message = apiErrorMessage(body);
    expect(message).toContain("2026-09");
    expect(message).not.toBe("server English");
  });
});
