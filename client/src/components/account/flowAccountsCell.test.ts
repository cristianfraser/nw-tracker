import { describe, expect, it } from "vitest";
import { flowAccountsCell } from "./FlowRows";

const row = (over: Partial<Parameters<typeof flowAccountsCell>[1]>) => ({
  account_name: "Cuenta corriente",
  from_account_name: null,
  to_account_name: null,
  counterpart_account_name: null,
  money_direction: "in" as "in" | "out" | null,
  ...over,
});

describe("flowAccountsCell", () => {
  it("reads origin → target on a group page, both legs or one", () => {
    const transfer = row({ from_account_name: "Fintual CLP", to_account_name: "Fintual USD", money_direction: "out" });
    expect(flowAccountsCell("group", transfer)).toEqual({ left: "Fintual CLP", arrow: "→", right: "Fintual USD" });
    // The row of the target, when the origin is outside the group, still reads origin → target.
    const inbound = row({ account_name: "SPY", from_account_name: "Broker USD", to_account_name: "SPY" });
    expect(flowAccountsCell("group", inbound)).toEqual({ left: "Broker USD", arrow: "→", right: "SPY" });
  });

  it("points money from or to the outside world on a group page", () => {
    expect(flowAccountsCell("group", row({ money_direction: "in" }))).toEqual({ left: null, arrow: "→", right: "Cuenta corriente" });
    expect(flowAccountsCell("group", row({ money_direction: "out" }))).toEqual({ left: "Cuenta corriente", arrow: "→", right: null });
  });

  it("leaves the page's account out on its own page, the arrow from its side", () => {
    expect(flowAccountsCell("account", row({ counterpart_account_name: "Broker USD", money_direction: "in" }))).toEqual({
      left: null,
      arrow: "←",
      right: "Broker USD",
    });
    expect(flowAccountsCell("account", row({ money_direction: "out" }))).toEqual({ left: null, arrow: "→", right: null });
  });

  it("draws no arrow on a movement of nothing", () => {
    expect(flowAccountsCell("account", row({ money_direction: null }))).toEqual({ left: null, arrow: null, right: null });
  });
});
