import { describe, expect, it } from "vitest";
import { fintualCertGoalImportKeyById, matchFintualCertificadoInvestment } from "./fintualCertV2.js";
import { FINTUAL_GOALS } from "./fintualGoals.js";

const reserve = FINTUAL_GOALS.find((g) => g.importKey.endsWith("key=reserva2"))!;
const apvB = FINTUAL_GOALS.find((g) => g.importKey.endsWith("key=apv_b"))!;

describe("Fintual goal → certificado account", () => {
  it("a live goal resolves by its id alone: a name that reads like a tracked goal's is not evidence", () => {
    expect(fintualCertGoalImportKeyById(reserve.goalId)).toBe(reserve.importKey);
    expect(fintualCertGoalImportKeyById("999999999")).toBeNull();
  });

  it("a certificado row resolves by its investment id first, whatever its name", () => {
    expect(matchFintualCertificadoInvestment(apvB.goalId, "Fondo Reserva viaje")).toBe(apvB.importKey);
  });

  it("a certificado row whose id no tracked goal carries falls back to one name rule", () => {
    expect(matchFintualCertificadoInvestment("999999999", "Fondo Reserva viaje")).toBe(reserve.importKey);
    expect(matchFintualCertificadoInvestment("999999999", "Vacaciones")).toBeNull();
  });

  it("a certificado name meeting two goals' rules throws", () => {
    expect(() => matchFintualCertificadoInvestment("999999999", `${reserve.name} ${apvB.name}`)).toThrow(
      /matches 2 tracked goals by name/
    );
  });
});
