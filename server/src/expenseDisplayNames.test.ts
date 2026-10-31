import { describe, expect, it } from "vitest";
import {
  appStoreLabel,
  brandsFromPayees,
  cardMerchantsByAccount,
  cleanBankMerchant,
  counterpartyLabel,
  counterpartyNamesFromRows,
  expenseLineDisplayNames,
  payslipLineName,
  receiptLabel,
  splitProcessorPrefix,
  type DisplayNameContext,
} from "./expenseDisplayNames.js";
import { shortPersonName, stripLegalSuffix, titleCaseName } from "./expenseNameText.js";
import {
  foldVendorName,
  loadVendorCatalog,
  saveVendorBranchChoice,
  vendorCatalogFromEntries,
  type VendorCatalogEntry,
} from "./vendorCatalog.js";
import { placeBranch } from "./chilePlaces.js";
import { db } from "./db.js";
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
  seed("branch", "STREAT BURGER", "Streat Burger"),
  seed("exact", "UBER EATS", "Uber Eats"),
  seed("prefix", "UBER EAT Z", "Zona Prueba"),
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

  it("seeds the brands migration 249 adds", () => {
    const seeded = loadVendorCatalog();
    expect(seeded.lookup("ARCOSDEVALPARAISO")).toBe("McDonald's (San Martín)");
    expect(seeded.lookup("SABA ARAUCO PAO")).toBe("Saba (Parque Arauco)");
    expect(seeded.lookup("SABA PLAZA BELLAVISTA")).toBe("Saba (Plaza Bellavista)");
    expect(seeded.lookup("IKEA OPEN KENNEDY")).toBe("Ikea (Open Kennedy)");
    expect(seeded.lookup("CLINICA ALEMANA PZA EGANA")).toBe("Clínica Alemana (Plaza Egaña)");
    expect(seeded.lookup("DL*GOOGLE YOUTUBE")).toBe("YouTube Premium");
    expect(seeded.lookup("ANTHROPIC* CLAUDE SUB")).toBe("Claude");
    expect(seeded.lookup("RENDER.COM")).toBe("render.com");
  });

  it("seeds the brands migration 250 adds", () => {
    const seeded = loadVendorCatalog();
    expect(seeded.lookup("AMAZON* 4H4FI9OJ5")).toBe("Amazon.com");
    expect(seeded.lookup("MERCADO PAGO 4 TCOM")).toBe("Mercado Pago");
    expect(seeded.lookup("MUEVO COPEC")).toBe("Copec (App)");
    expect(seeded.lookup("OKM SUECIA")).toBe("OK Market");
    expect(seeded.lookup("LONDON COFFEE ALCANT")).toBe("Santander Work/Café (Alcántara)");
    expect(seeded.lookup("HIPER PUENTE NUEVO.")).toBe("Hiper Lider (Puente Nuevo)");
    expect(seeded.lookup("IKEA COM")).toBe("Ikea");
    expect(seeded.lookup("GOOGLE PLAY-YO")).toBe("YouTube Premium");
    expect(seeded.lookup("OK MARKET S.A.")).toBe("OK Market");
  });

  it("spells a branch's places and completes the one a cut branch starts", () => {
    expect(catalog.lookup("JUMBO PENALOLEN")).toBe("Jumbo (Peñalolén)");
    expect(catalog.lookup("JUMBO J875 VINA DEL MA")).toBe("Jumbo (Viña del Mar)");
    expect(catalog.lookup("EXPRESS AVDA VALPARAI")).toBe("Lider Express (Avda Valparaíso)");
    expect(catalog.lookup("AHUM L272 LOS LEONES 1160")).toBe("Ahumada (Los Leones 1160)");
    // Short enough not to be cut: a partial word stays as printed.
    expect(catalog.lookup("JUMBO VALPA")).toBe("Jumbo (Valpa)");
    expect(placeBranch("Santi", true)).toEqual({ text: "Santiago", choices: null });
  });

  it("a cut branch several places could be stays as printed, with the choices", () => {
    const placed = placeBranch("Las", true);
    expect(placed.text).toBe("Las");
    expect(placed.choices).toEqual(expect.arrayContaining(["Las Condes", "Las Catalpas"]));
    const m = catalog.match("EXPRESS VERY LONG NAME LAS");
    expect(m?.display).toBe("Lider Express (Very Long Name las)");
    expect(m?.branchChoices).toEqual(expect.arrayContaining(["Lider Express (Very Long Name Las Condes)"]));
  });

  it("stores a picked branch, matched before the seed's branch row", () => {
    db.prepare(`DELETE FROM vendor_catalog WHERE source = 'choice'`).run();
    try {
      expect(() => saveVendorBranchChoice("EXPRESS VERY LONG NAME LAS", "Lider Express (Nowhere)")).toThrow(/not a branch/);
      saveVendorBranchChoice("EXPRESS VERY LONG NAME LAS", "Lider Express (Very Long Name Las Condes)");
      const after = loadVendorCatalog().match("EXPRESS VERY LONG NAME LAS");
      expect(after).toEqual({ display: "Lider Express (Very Long Name Las Condes)", branchChoices: null });
    } finally {
      db.prepare(`DELETE FROM vendor_catalog WHERE source = 'choice'`).run();
    }
  });

  it("does not wrap a branch the name already sets apart", () => {
    expect(catalog.lookup("Streat Burger (Isidora)")).toBe("Streat Burger (Isidora)");
    expect(catalog.lookup("Streat Burger - Isidora")).toBe("Streat Burger (Isidora)");
    expect(catalog.lookup("Jumbo - Costanera Center")).toBe("Jumbo (Costanera Center)");
    expect(catalog.lookup("Jumbo – Bilbao")).toBe("Jumbo (Bilbao)");
    expect(catalog.lookup("Jumbo -")).toBe("Jumbo");
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
    expect(splitProcessorPrefix("DL     *GOOGLE PLAY-YO")).toEqual({ name: "GOOGLE PLAY-YO", processor: "dLocal" });
    expect(splitProcessorPrefix("PAYPAL *EPOCH ICFTECHN")).toEqual({ name: "EPOCH ICFTECHN", processor: "PayPal" });
    expect(splitProcessorPrefix("IZ *Phone HUB")).toEqual({ name: "Phone HUB", processor: "Zettle" });
  });

  it("drops an old listing's «COMPRA» before the merchant, not the statement's own lines", () => {
    expect(cleanBankMerchant("COMPRA JUMBO PENALOLEN")).toBe("JUMBO PENALOLEN");
    expect(cleanBankMerchant("Compra Nacional Llaves Servicat")).toBe("Llaves Servicat");
    expect(cleanBankMerchant("Compras Sodimac")).toBe("Sodimac");
    expect(cleanBankMerchant("COMPRAS DEL PERIODO (ESTIMADO)")).toBe("COMPRAS DEL PERIODO (ESTIMADO)");
    expect(cleanBankMerchant("COMPRAS INTERNACIONALES (ESTIMADO)")).toBe("COMPRAS INTERNACIONALES (ESTIMADO)");
    expect(cleanBankMerchant("Compras Internet")).toBe("Compras Internet");
  });

  it("payslip lines: the employer without its legal suffix, words spelled", () => {
    expect(payslipLineName("Comisión AFP · EMPRESA PRUEBA SPA")).toBe("Comisión AFP · Empresa Prueba");
    expect(payslipLineName("Impuesto Unico (LQ) · PRUEBA CHILE SPA")).toBe("Impuesto Único · Prueba Chile");
    expect(payslipLineName("IMPUESTO UNICO TRABAJADORES · PRUEBA S.A.")).toBe("Impuesto Único Trabajadores · Prueba");
    expect(payslipLineName("Cotizacion Salud · PRUEBA LTDA")).toBe("Cotización Salud · Prueba");
  });
});

describe("link labels", () => {
  const brands = brandsFromPayees(["Streat Burger - Isidora", "La Birra Bar (Lira)", "Five Guys - Burgers, Fries & Shakes"]);

  it("receipts: the payee, a branch in parentheses, never the processor", () => {
    expect(receiptLabel(receipt("uber_eats", "Streat Burger - Isidora"), catalog, brands)?.text).toBe("Streat Burger (Isidora)");
    expect(receiptLabel(receipt("uber_eats", "Streat Burger Isidora"), catalog, brands)?.text).toBe("Streat Burger (Isidora)");
    expect(receiptLabel(receipt("uber_eats", "Streat Burger (Isidora)"), catalog, brands)?.text).toBe("Streat Burger (Isidora)");
    expect(receiptLabel(receipt("uber_eats", "Jumbo - Costanera Center"), catalog, brands)?.text).toBe("Jumbo (Costanera Center)");
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
  const ctx: DisplayNameContext = {
    catalog,
    counterparties: new Map(),
    brands: [],
    cardMerchantsByAccount: cardMerchantsByAccount([
      { source: "cc", merchant: "PAYU   *UBER EATS", account_id: 1 },
      { source: "cc", merchant: "PAYU *UBER EATS", account_id: 1 },
      { source: "cc", merchant: "PAYU *UBER EATS", account_id: 2 },
      { source: "cc", merchant: "PAYU *UBER EAT ZONA", account_id: 2 },
    ]),
  };

  it("a card line: cleaned, processor split, catalog applied", () => {
    expect(expenseLineDisplayNames({ source: "cc", merchant: "MERPAGO*MICOCACOLA", account_id: 1 }, ctx)).toEqual({
      display_merchant: "miCoca-Cola",
      merchant_processor: "Mercado Pago",
    });
    expect(expenseLineDisplayNames({ source: "cc", merchant: "JUMBO BILBAO", account_id: 1 }, ctx)).toEqual({ display_merchant: "Jumbo (Bilbao)" });
    expect(expenseLineDisplayNames({ source: "cc", merchant: "SOMEWHERE", account_id: 1 }, ctx)).toEqual({});
  });

  it("a merchant the listing cut reads as the longer one it starts on the same account", () => {
    // The bank collapses the cut row's spaces: «PAYU   *UBER EATS» arrives as «PAYU *UBER EA».
    expect(expenseLineDisplayNames({ source: "cc", merchant: "PAYU   *UBER EA", account_id: 1 }, ctx)).toEqual({
      display_merchant: "Uber Eats",
      merchant_processor: "PayU",
    });
    expect(expenseLineDisplayNames({ source: "cc", merchant: "PAYU *UBER EA", account_id: 1 }, ctx).display_merchant).toBe("Uber Eats");
  });

  it("a cut merchant stays as printed without one reading of the longer merchants", () => {
    // Account 2 prints two longer merchants that read differently: no pick.
    expect(expenseLineDisplayNames({ source: "cc", merchant: "PAYU *UBER EA", account_id: 2 }, ctx)).toEqual({
      display_merchant: "UBER EA",
      merchant_processor: "PayU",
    });
    // No longer merchant on the account: another account's lines are not evidence.
    expect(expenseLineDisplayNames({ source: "cc", merchant: "PAYU *UBER EA", account_id: 3 }, ctx).display_merchant).toBe("UBER EA");
    // Longer than the cut width: not a cut name.
    expect(
      expenseLineDisplayNames({ source: "cc", merchant: "PAYU *UBER EA EXTRA", account_id: 1 }, ctx).display_merchant
    ).toBe("UBER EA EXTRA");
  });

  it("a shop's own receipt names the merchant the bank's name hides", () => {
    const shop = expenseLineDisplayNames(
      { source: "cc", merchant: "COMERCIALPRUEBA", account_id: 1, payment_receipt: receipt("shopify", "CORRALES DEL SUR") },
      ctx
    );
    expect(shop.display_merchant).toBe("Corrales del Sur");
    expect(shop.link_label?.inline).toBe(false);
    // A platform selling for others keeps the platform as the merchant.
    const platform = expenseLineDisplayNames(
      { source: "cc", merchant: "PAYU *UBER EATS", account_id: 1, payment_receipt: receipt("uber_eats", "Streat Burger (Isidora)") },
      ctx
    );
    expect(platform.display_merchant).toBe("Uber Eats");
    expect(platform.link_label).toMatchObject({ text: "Streat Burger (Isidora)", inline: true });
  });

  it("a receipt's label is not repeated on the row when the merchant says it", () => {
    const names = expenseLineDisplayNames(
      { source: "cc", merchant: "UBER", account_id: 1, payment_receipt: receipt("uber", "Uber") },
      ctx
    );
    expect(names.link_label).toEqual({ arrow: "→", text: "Uber", nights: null, inline: false });
  });

  it("a checking transfer reads «Transf a <label>», label not repeated", () => {
    const names = expenseLineDisplayNames(
      {
        source: "checking",
        merchant: "Transf a INMOBILIARIA Y CONSTR",
        account_id: 3,
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
