import { describe, expect, it } from "vitest";
import { fintualGoalFromWithdrawalSubject } from "./fintualWithdrawalPairing.js";

describe("fintualGoalFromWithdrawalSubject", () => {
  it("reads the goal out of the subject, emoji and all", () => {
    expect(fintualGoalFromWithdrawalSubject("Pagamos tu retiro de 🏦 Reserva")).toBe("Reserva");
  });

  it("handles a multi-word goal", () => {
    expect(fintualGoalFromWithdrawalSubject("Pagamos tu retiro de 💰 Mega Caca")).toBe("Mega Caca");
  });

  it("returns null for an unrelated subject rather than guessing", () => {
    expect(fintualGoalFromWithdrawalSubject("Confirmación de transacciones en Acciones")).toBeNull();
  });
});
