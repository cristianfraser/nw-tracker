/**
 * Migration 325's hook: the seed names it adds and the rules they move (`vendorCatalogChange.ts`).
 */
import type { Database as DatabaseType } from "better-sqlite3";
import { applyVendorCatalogChange, describeVendorCatalogChange } from "./vendorCatalogChange.js";
import { foldVendorName, type VendorCatalogKind } from "./vendorCatalogMatch.js";

const SEED: readonly [VendorCatalogKind, string, string][] = [
  // OK Market's stores are Oxxo since 2022.
  ["branch", "OKM", "Oxxo"],
  ["branch", "OXXO", "Oxxo"],
  ["exact", "OK MARKET S.A.", "Oxxo"],
  ["exact", "OK MARKET S A", "Oxxo"],
  // Pharmacies by store number.
  ["branch", "SB", "Salcobrand"],
  ["branch", "CRUZ VERDE", "Cruz Verde"],
  ["branch", "CRUZVERDE", "Cruz Verde"],
  ["branch", "FARM CRUZ VERDE", "Cruz Verde"],
  ["branch", "C. VERDE", "Cruz Verde"],
  ["branch", "CV", "Cruz Verde"],
  // Copec's store is not its gas.
  ["branch", "PUNTO COPEC", "Punto Copec"],
  ["prefix", "CPS COPEC", "Copec"],
  // Shops and food.
  ["branch", "PAPA JOHNS", "Papa John's"],
  ["exact", "PAPA JOHNS PJ CH", "Papa John's"],
  ["prefix", "MELTPIZZAS", "Melt Pizza"],
  ["prefix", "MCDONALDSCHI", "McDonald's"],
  ["prefix", "ARCOSDEV", "McDonald's"],
  ["exact", "UBER EA", "Uber Eats"],
  ["prefix", "GLOVO #", "Glovo"],
  ["prefix", "GLOVOX", "Glovox"],
  ["prefix", "REDELCO*GLOVOX", "Glovox"],
  ["exact", "ROSEN", "Rosen"],
  ["exact", "MK WEBPAY.CL", "mk.cl"],
  ["exact", "ROCA WEBPAY", "chc.cl"],
  ["exact", "VISTA LIBRE", "Vista Libre"],
  ["exact", "RESTAURANT DON CARLOS", "Restaurant Don Carlos"],
  ["prefix", "CK ECOMMERCE", "Calvin Klein"],
  ["branch", "TOTTUS", "Tottus"],
  ["branch", "DECATHLON", "Decathlon"],
  ["branch", "LA CABRERA", "La Cabrera"],
  ["branch", "UPA!", "Upa!"],
  ["branch", "UPA]", "Upa!"],
  ["prefix", "UNIFICADO ENTEL", "Entel"],
  ["prefix", "NAME-CHEAP.COM", "namecheap.com"],
  // Getting around.
  ["exact", "MIBICIO", "mibicio"],
  ["prefix", "BICICLETASPUBLICA", "Bike Itaú"],
  ["prefix", "BRITISH A", "British Airways"],
  ["prefix", "KLM AIRLINE", "KLM"],
  ["prefix", "KLM NETHERLA", "KLM"],
  ["prefix", "IBERIA", "Iberia"],
  ["prefix", "NLOV", "OVpay"],
  ["prefix", "TFL TRAVEL", "TfL"],
  ["prefix", "BOOKINGCOM", "Booking.com"],
  ["prefix", "BOOKING.COM", "Booking.com"],
  ["prefix", "BKG*HOTEL AT BOOKING", "Booking.com"],
  // The bank's own lines.
  ["exact", "INTERESES", "Intereses"],
  ["exact", "IMPUESTOS", "Impuestos"],
  ["prefix", "IMPUESTO DL 3475", "Impuesto de timbres"],
  ["prefix", "-50% DCTO COM ADM", "Descuento comisión de administración"],
  ["exact", "IVA USO INTERNACIONAL", "IVA uso internacional"],
  ["exact", "SERVICIO USO INTERNACIONAL", "Servicio uso internacional"],
  ["prefix", "TRASPASO A DEUDA", "Traspaso de deuda"],
];

export function runVendorCatalog325(dbi: DatabaseType): void {
  const report = applyVendorCatalogChange(dbi, {
    // «OKM SUECIA» read «OK Market»; the «OKM» branch names it now.
    remove: [{ kind: "prefix", pattern: "OKM SUECIA", source: "seed" }],
    upsert: SEED.map(([kind, pattern, display]) => ({ kind, pattern: foldVendorName(pattern), display, source: "seed" as const })),
    // An exact entry «Brand (branch)» now shares its brand's rule («Clínica Alemana (Plaza Egaña)»).
  }, { exactBrand: "display" });
  const lines = describeVendorCatalogChange(report);
  if (lines.length > 0 && !process.env.VITEST) console.log(["[migration 325] vendor catalog:", ...lines].join("\n"));
}
