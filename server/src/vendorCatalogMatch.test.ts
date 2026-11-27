import { describe, expect, it } from "vitest";
import { vendorCatalogFromEntries } from "./vendorCatalogMatch.js";

describe("a carried spelling in the vendor catalog", () => {
  it("is consulted only when no other entry matches: a user's prefix or exact entry wins", () => {
    const catalog = vendorCatalogFromEntries([
      { kind: "exact", pattern: "TIENDA EJEMPLO CENTRO", display: "Tienda Vieja", source: "spelling" },
      { kind: "prefix", pattern: "TIENDA EJEMPLO", display: "Tienda Nueva", source: "user" },
      { kind: "exact", pattern: "OTRA TIENDA", display: "Otra (usuario)", source: "user" },
      { kind: "exact", pattern: "OTRA TIENDA", display: "Otra (deletreo)", source: "spelling" },
      { kind: "exact", pattern: "SOLO DELETREO", display: "Solo Deletreo", source: "spelling" },
    ]);
    expect(catalog.lookup("Tienda Ejemplo Centro")).toBe("Tienda Nueva");
    expect(catalog.lookup("Otra Tienda")).toBe("Otra (usuario)");
    expect(catalog.lookup("Solo Deletreo")).toBe("Solo Deletreo");
  });
});
