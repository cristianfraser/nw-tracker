import { describe, expect, it } from "vitest";
import type { ArchivedMail } from "../email/santanderMailArchive.js";
import { decodeMaipuVehiclePermit } from "./vehiclePermitMails.js";

/**
 * Synthetic permit PDFs. The layout text is built cell by cell at fixed columns, the way
 * `pdftotext -layout` places the graphics' text, so the decoder's column logic is exercised.
 */
type Permit = {
  folio: string;
  year: number;
  paid: string;
  plate: string;
  parts: [string, string];
  tax: string;
  /** The amount as printed three times (the vehicle block's copy last). */
  copies: string[];
  expiry: string;
  kind: string;
  make: string;
  model: string;
  vehicleYear: number;
};

const FIRST: Permit = {
  folio: "11223344",
  year: 2026,
  paid: "25/03/2026",
  plate: "AB1234-5",
  parts: ["10.400", "17.600"],
  tax: "4.100.000",
  copies: ["28.000", "28.000", "28.000"],
  expiry: "31/08/2026",
  kind: "AUTOMOVIL",
  make: "TOYOTA",
  model: "YARIS",
  vehicleYear: 2017,
};

const at = (...cells: [number, string][]): string => {
  let line = "";
  for (const [col, text] of cells) line = line.padEnd(col) + text;
  return line;
};

function layout(p: Permit): string {
  const rows = [
    at([128, p.folio]),
    at([44, String(p.year)], [70, p.paid], [101, p.plate]),
    at([33, "NOMBRE EJEMPLO"], [102, "1150302001001"], [119, p.parts[0]]),
    at([102, "1150302001002"], [119, p.parts[1]]),
    at([10, "11.111.111-1"]),
    at([19, "(HB0000001)"], [53, p.tax]),
    at([69, p.copies[0] ?? ""]),
    at([137, p.copies[1] ?? ""]),
    at([14, p.kind], [46, p.make], [80, String(p.vehicleYear)], [93, p.copies[2] ?? ""], [112, "FIRMANTE EJEMPLO"]),
    at([11, "BLANCO"], [46, p.model]),
    at([92, p.expiry]),
    at([15, "ABC1234567890"], [46, "0,00"], [80, "2"]),
    at([128, p.folio]),
  ];
  return rows.join("\n") + "\n";
}

function permitMail(text: string, over: Partial<ArchivedMail> = {}): ArchivedMail {
  return {
    message_id: "<permit-test@test>",
    sent_at_chile: "2026-03-25 10:00",
    from: "Municipalidad <permisocirculacion@maipu.cl>",
    subject: "Permiso de Circulación",
    text: "",
    attachments: [{ filename: "Permiso de Circulacion 2026 - AB1234-5.pdf", file: "permit.pdf", text }],
    ...over,
  };
}

const withPermit = (p: Partial<Permit>) => permitMail(layout({ ...FIRST, ...p }));

describe("decodeMaipuVehiclePermit", () => {
  it("reads a first-cuota permit", () => {
    expect(decodeMaipuVehiclePermit(withPermit({}))).toEqual({
      issuer: "municipalidad_maipu",
      municipality: "Maipú",
      folio: "11223344",
      permit_year: 2026,
      paid_on: "2026-03-25",
      plate: "AB1234-5",
      amount: 28000,
      parts: [
        { account: "1150302001001", amount: 10400 },
        { account: "1150302001002", amount: 17600 },
      ],
      tax_value: 4100000,
      expires_on: "2026-08-31",
      cuota: 1,
      cuotas: 2,
      vehicle: { kind: "AUTOMOVIL", make: "TOYOTA", model: "YARIS", year: 2017 },
    });
  });

  it("reads a second-cuota permit (expiry 31/03 of the next year)", () => {
    const r = decodeMaipuVehiclePermit(
      withPermit({
        folio: "11223355",
        paid: "27/08/2026",
        parts: ["10.650", "18.050"],
        copies: ["28.700", "28.700", "28.700"],
        expiry: "31/03/2027",
      }),
    );
    expect(r).toMatchObject({
      folio: "11223355",
      paid_on: "2026-08-27",
      amount: 28700,
      parts: [
        { account: "1150302001001", amount: 10650 },
        { account: "1150302001002", amount: 18050 },
      ],
      expires_on: "2027-03-31",
      cuota: 2,
      cuotas: 2,
      tax_value: 4100000,
    });
  });

  it("reads a whole-year permit paid in March (expiry 31/03 of the next year)", () => {
    const r = decodeMaipuVehiclePermit(
      withPermit({ parts: ["20.800", "35.200"], copies: ["56.000", "56.000", "56.000"], expiry: "31/03/2027" }),
    );
    expect(r).toMatchObject({ paid_on: "2026-03-25", amount: 56000, expires_on: "2027-03-31", cuota: 1, cuotas: 1 });
  });

  it("reads a four-letter plate", () => {
    expect(decodeMaipuVehiclePermit(withPermit({ plate: "BCDF12-K" }))).toMatchObject({ plate: "BCDF12-K" });
  });

  it("reads the 2025 variant with a dashed payment date and other vehicle", () => {
    const r = decodeMaipuVehiclePermit(
      withPermit({
        folio: "30000001",
        year: 2025,
        paid: "25-03-2025",
        plate: "CD5678-9",
        parts: ["13.200", "22.300"],
        tax: "4.600.000",
        copies: ["35.500", "35.500", "35.500"],
        expiry: "31/08/2025",
        kind: "CAMIONETA",
        make: "TOYOTA",
        model: "HILUX",
        vehicleYear: 2015,
      }),
    );
    expect(r).toMatchObject({
      permit_year: 2025,
      paid_on: "2025-03-25",
      plate: "CD5678-9",
      amount: 35500,
      tax_value: 4600000,
      expires_on: "2025-08-31",
      cuota: 1,
      vehicle: { kind: "CAMIONETA", make: "TOYOTA", model: "HILUX", year: 2015 },
    });
  });

  it("keeps the RUT, the name and the signer out of the output", () => {
    const out = JSON.stringify(decodeMaipuVehiclePermit(withPermit({})));
    expect(out).not.toMatch(/11\.111\.111|NOMBRE|FIRMANTE|EJEMPLO/);
  });

  it("returns null for a mail that is not a permit", () => {
    expect(decodeMaipuVehiclePermit(permitMail(layout(FIRST), { from: "other@example.test" }))).toBeNull();
    expect(decodeMaipuVehiclePermit(permitMail(layout(FIRST), { subject: "Recordatorio de pago" }))).toBeNull();
    expect(decodeMaipuVehiclePermit(permitMail(layout(FIRST), { attachments: [] }))).toBeNull();
    expect(decodeMaipuVehiclePermit(permitMail(layout(FIRST), { attachments: undefined }))).toBeNull();
  });

  it("throws when the parts do not add up to the amount", () => {
    expect(() => decodeMaipuVehiclePermit(withPermit({ parts: ["10.400", "17.599"] }))).toThrow(/add up to 27999/);
  });

  it("throws when the printed amounts disagree", () => {
    expect(() => decodeMaipuVehiclePermit(withPermit({ copies: ["28.000", "28.000", "28.050"] }))).toThrow(/disagree/);
  });

  it("throws when the amount is not printed three times", () => {
    expect(() => decodeMaipuVehiclePermit(withPermit({ copies: ["28.000", "28.000"] }))).toThrow(/three times/);
  });

  it("throws on an expiry that is neither cuota's", () => {
    expect(() => decodeMaipuVehiclePermit(withPermit({ expiry: "30/06/2026" }))).toThrow(/expiry 2026-06-30/);
  });

  it("throws when the tasación beside the vehicle code is missing", () => {
    expect(() => decodeMaipuVehiclePermit(withPermit({ tax: "" }))).toThrow(/tasación/);
  });

  it("throws on a payment date in an unknown format", () => {
    expect(() => decodeMaipuVehiclePermit(withPermit({ paid: "2026.03.25" }))).toThrow(/no permit line/);
  });

  it("throws on a payment date that does not exist", () => {
    expect(() => decodeMaipuVehiclePermit(withPermit({ paid: "31/02/2026" }))).toThrow(/no such date/);
  });

  it("throws when the model under the make is missing", () => {
    expect(() => decodeMaipuVehiclePermit(withPermit({ model: "" }))).toThrow(/model/);
  });
});
