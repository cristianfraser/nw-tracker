import { describe, expect, it } from "vitest";
import {
  appStoreLabel,
  brandsFromPayees,
  cleanBankMerchant,
  counterpartyLabel,
  counterpartyNamesFromRows,
  expenseLineDisplayNames,
  receiptLabel,
  splitProcessorPrefix,
  type DisplayNameContext,
} from "./expenseDisplayNames.js";
import { shortPersonName, stripLegalSuffix, titleCaseName } from "./expenseNameText.js";
import { foldVendorName, vendorCatalogFromEntries, type VendorCatalogEntry } from "./vendorCatalog.js";
import { repairMojibake } from "./textRepair.js";
import type { PaymentReceiptDto } from "./paymentProcessorReceipts.js";

const seed = (kind: VendorCatalogEntry["kind"], pattern: string, display: string): VendorCatalogEntry => ({
  kind,
  pattern: kind === "rut" ? pattern : foldVendorName(pattern),
  display,
  source: "seed",
});

const catalog = vendorCatalogFromEntries([
  seed("prefix", "AMZN MKTP", "Amazon.com"),
  seed("prefix", "MERCADOLIBRE", "Mercadolibre (Chile)"),
  seed("prefix", "MICOCA", "miCoca-Cola"),
  seed("prefix", "FIVE GUYS", "Five Guys"),
  seed("prefix", "FINTUAL", "Fintual"),
  seed("prefix", "TINDER", "Tinder"),
  seed("prefix", "ENEL", "Enel"),
  seed("exact", "UBER", "Uber"),
  seed("branch", "JUMBO", "Jumbo"),
  seed("branch", "AHUM", "Ahumada"),
  seed("branch", "EXPRESS", "Lider Express"),
  seed("rut", "11111111K", "Arriendo Prueba"),
  { kind: "prefix", pattern: "ENEL", display: "Enel (user)", source: "user" },
]);

const receipt = (processor: string, payee: string, extra: Partial<PaymentReceiptDto> = {}) =>
  ({ processor, payee, stay: null, guess: false, ...extra }) as PaymentReceiptDto;

describe("vendor catalog", () => {
  it("matches exact, prefix and branch, user entries first", () => {
    expect(catalog.lookup("AMZN Mktp US*403MJ2GN3")).toBe("Amazon.com");
    expect(catalog.lookup("uber")).toBe("Uber");
    expect(catalog.lookup("UBER TRIP")).toBeNull();
    expect(catalog.lookup("JUMBO BILBAO")).toBe("Jumbo (Bilbao)");
    expect(catalog.lookup("JUMBO")).toBe("Jumbo");
    expect(catalog.lookup("JUMBOX")).toBeNull();
    expect(catalog.lookup("AHUM L272 LOS LEONES 1")).toBe("Ahumada (Los Leones 1)");
    expect(catalog.lookup("ENEL")).toBe("Enel (user)");
    expect(catalog.lookupRut("11.111.111-k")).toBe("Arriendo Prueba");
  });
});

describe("text rules", () => {
  it("title-cases capitals and lower case, keeps someone's own mixed spelling", () => {
    expect(titleCaseName("COMUNIDAD EDIFICIO DE PRUEBA")).toBe("Comunidad Edificio de Prueba");
    expect(titleCaseName("ana perez")).toBe("Ana Perez");
    expect(titleCaseName("Ana de la Fuente")).toBe("Ana de la Fuente");
  });

  it("drops legal suffixes", () => {
    expect(stripLegalSuffix("SOCIEDAD COMERCIAL PRUEBA SPA")).toBe("SOCIEDAD COMERCIAL PRUEBA");
    expect(stripLegalSuffix("Grindr LLC")).toBe("Grindr");
    expect(stripLegalSuffix("COLCHONES PRUEBA SAIC")).toBe("COLCHONES PRUEBA");
    expect(stripLegalSuffix("PARQUE PRUEBA SA")).toBe("PARQUE PRUEBA");
    expect(stripLegalSuffix("UPS de Chile Ltda")).toBe("UPS de Chile");
  });

  it("shortens a person to first name + first surname", () => {
    expect(shortPersonName("Ana Maria Perez Soto")).toBe("Ana Perez");
    expect(shortPersonName("Pedro Perez Soto")).toBe("Pedro Perez");
    expect(shortPersonName("Ana Maria Lobo del Canto")).toBe("Ana Lobo");
    expect(shortPersonName("Ana Perez")).toBe("Ana Perez");
  });

  it("repairs UTF-8 read as Latin-1 and nothing else", () => {
    expect(repairMojibake("SebastiÃ¡n")).toBe("Sebastián");
    expect(repairMojibake("Sebastián")).toBe("Sebastián");
    expect(repairMojibake("Ãrbol")).toBe("Ãrbol");
  });
});

describe("merchant cleanup", () => {
  it("drops the bank's clutter and the processor prefix", () => {
    expect(cleanBankMerchant("EXPRESS LYON, SANTIAGO (T)")).toBe("EXPRESS LYON");
    expect(cleanBankMerchant("ENEL                            COMPRAS P.A.T.")).toBe("ENEL");
    expect(cleanBankMerchant("0081172943 Transf. Ana P")).toBe("Transf. Ana P");
    expect(cleanBankMerchant("Agustinas Giro en Cajero Automático")).toBe("Giro en Cajero Automático");
    expect(splitProcessorPrefix("MERPAGO*MICOCACOLA")).toEqual({ name: "MICOCACOLA", processor: "Mercado Pago" });
    expect(splitProcessorPrefix("PAYU   *UBER EATS")).toEqual({ name: "UBER EATS", processor: "PayU" });
    expect(splitProcessorPrefix("HAULMER*PAPAS RICAS Y")).toEqual({ name: "PAPAS RICAS Y", processor: "Haulmer" });
    expect(splitProcessorPrefix("JUMBO BILBAO")).toEqual({ name: "JUMBO BILBAO", processor: null });
  });
});

describe("link labels", () => {
  const brands = brandsFromPayees(["Streat Burger - Isidora", "La Birra Bar (Lira)", "Five Guys - Burgers, Fries & Shakes"]);

  it("receipts: the payee, a branch in parentheses, never the processor", () => {
    expect(receiptLabel(receipt("uber_eats", "Streat Burger - Isidora"), catalog, brands)?.text).toBe("Streat Burger (Isidora)");
    expect(receiptLabel(receipt("uber_eats", "Streat Burger Isidora"), catalog, brands)?.text).toBe("Streat Burger (Isidora)");
    expect(receiptLabel(receipt("uber_eats", "Streat Burger (Isidora)"), catalog, brands)?.text).toBe("Streat Burger (Isidora)");
    expect(receiptLabel(receipt("uber_eats", "Five Guys - Burgers, Fries & Shakes"), catalog, brands)?.text).toBe("Five Guys");
    expect(receiptLabel(receipt("uber_eats", "⚡️SPID Express (Los Leones)"), catalog, brands)?.text).toBe("SPID Express (Los Leones)");
    expect(receiptLabel(receipt("uber_eats", "The Frita's Empanadas Gourmet."), catalog, brands)?.text).toBe("The Frita's Empanadas Gourmet");
  });

  it("receipts: MercadoLibre sellers, URLs, e-mails, placeholders", () => {
    expect(receiptLabel(receipt("mercadolibre", "MERCADOLIBRE CHILE LIMITADA"), catalog, brands)?.text).toBe("Mercadolibre (Chile)");
    expect(receiptLabel(receipt("mercadolibre", "TIENDA UNO SPA, TIENDA DOS SPA"), catalog, brands)?.text).toBe("Tienda Uno +1");
    expect(receiptLabel(receipt("mercadolibre", "REQUETEOFERTAS SPA"), catalog, brands)?.text).toBe("Requeteofertas");
    expect(receiptLabel(receipt("pago_facil", "http://www.example.cl"), catalog, brands)?.text).toBe("example.cl");
    expect(receiptLabel(receipt("flow", "someone@example.com"), catalog, brands)).toBeNull();
    expect(receiptLabel(receipt("pago_facil", "Servicio Creado Automáticamente"), catalog, brands)).toBeNull();
    expect(receiptLabel(receipt("shopify", "CORRALES DEL SUR"), catalog, brands)?.text).toBe("Corrales del Sur");
    expect(receiptLabel(receipt("adidas", "adidas"), catalog, brands)?.text).toBe("adidas");
  });

  it("receipts: a stay is its city and nights", () => {
    const stay = receipt("booking", "Some Long Apartment Name", { stay: { check_in: "2026-01-10", check_out: "2026-01-13", city: "Lisboa" } });
    expect(receiptLabel(stay, catalog, brands)).toEqual({ text: "Lisboa", nights: 3 });
  });

  it("App Store: the app's name before its tagline, several apps joined", () => {
    expect(appStoreLabel("Grindr - Gay Dating & Chat", catalog)).toBe("Grindr");
    expect(appStoreLabel("Tinder Dating App: Meet & Date + Grindr - Gay Dating & Chat", catalog)).toBe("Tinder + Grindr");
    expect(appStoreLabel("Kingdom Rush: Tower Defense TD", catalog)).toBe("Kingdom Rush");
  });

  it("transfers: catalog by RUT, the name the RUT is known by, short people and companies", () => {
    const names = counterpartyNamesFromRows([
      { rut: "22222222-2", name: "ANA MARIA PEREZ SOTO", n: 5, last: "2024-01-01" },
      { rut: "22222222-2", name: "anita", n: 1, last: "2023-01-01" },
      { rut: "33333333-3", name: "PEREZ SOTO PEDRO", n: 2, last: "2024-01-01" },
      { rut: "33333333-3", name: "PEDRO PEREZ SOTO", n: 9, last: "2023-01-01" },
    ]);
    expect(counterpartyLabel({ rut: "11.111.111-K", name: "INMOBILIARIA X" }, catalog, names)).toBe("Arriendo Prueba");
    expect(counterpartyLabel({ rut: "22222222-2", name: "ANA MARIA PEREZ SOTO" }, catalog, names)).toBe("Anita");
    expect(counterpartyLabel({ rut: "33333333-3", name: "PEREZ SOTO PEDRO" }, catalog, names)).toBe("Pedro Perez");
    expect(counterpartyLabel({ rut: null, name: "SOCIEDAD COMERCIAL PRUEBA SPA" }, catalog, names)).toBe("Sociedad Comercial Prueba");
    expect(counterpartyLabel({ rut: null, name: "FINTUAL ADMINISTRADORA GENERAL DE FONDOS S.A." }, catalog, names)).toBe("Fintual");
  });
});

describe("expenseLineDisplayNames", () => {
  const ctx: DisplayNameContext = { catalog, counterparties: new Map(), brands: [] };

  it("a card line: cleaned, processor split, catalog applied", () => {
    expect(expenseLineDisplayNames({ source: "cc", merchant: "MERPAGO*MICOCACOLA" }, ctx)).toEqual({
      display_merchant: "miCoca-Cola",
      merchant_processor: "Mercado Pago",
    });
    expect(expenseLineDisplayNames({ source: "cc", merchant: "JUMBO BILBAO" }, ctx)).toEqual({ display_merchant: "Jumbo (Bilbao)" });
    expect(expenseLineDisplayNames({ source: "cc", merchant: "SOMEWHERE" }, ctx)).toEqual({});
  });

  it("a receipt's label is not repeated on the row when the merchant says it", () => {
    const names = expenseLineDisplayNames(
      { source: "cc", merchant: "UBER", payment_receipt: receipt("uber", "Uber") },
      ctx
    );
    expect(names.link_label).toEqual({ arrow: "→", text: "Uber", nights: null, inline: false });
  });

  it("a checking transfer reads «Transf a <label>», label not repeated", () => {
    const names = expenseLineDisplayNames(
      {
        source: "checking",
        merchant: "Transf a INMOBILIARIA Y CONSTR",
        transfer_counterparty: {
          direction: "out", name: "ANA MARIA PEREZ SOTO", rut: null, bank: "Banco Prueba", account_type: null,
          account_number: null, email: null, comment: null, sent_at_chile: "2026-01-01 10:00",
        },
      },
      ctx
    );
    expect(names.display_merchant).toBe("Transf a Ana Perez");
    expect(names.link_label).toEqual({ arrow: "→", text: "Ana Perez", nights: null, inline: false });
  });
});
