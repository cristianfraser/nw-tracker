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
});
