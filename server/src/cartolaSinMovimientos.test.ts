import { describe, expect, it } from "vitest";
import {
  cartolaPdfPreferenceScore,
  textIndicatesCartolaSinMovimientos,
} from "./cartolaSinMovimientos.js";

describe("cartolaSinMovimientos", () => {
  it("detects sin movimientos marker in text", () => {
    expect(
      textIndicatesCartolaSinMovimientos("** CARTOLA SIN MOVIMIENTOS **")
    ).toBe(true);
    expect(textIndicatesCartolaSinMovimientos("MOVIMIENTO DE SU CUENTA")).toBe(false);
  });

  it("prefers PDFs with movements over sin-movimientos", () => {
    expect(cartolaPdfPreferenceScore("/tmp/a.pdf", 5)).toBeGreaterThan(
      cartolaPdfPreferenceScore("/tmp/b.pdf", 0)
    );
  });
});
