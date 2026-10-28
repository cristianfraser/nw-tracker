import { describe, expect, it } from "vitest";
import { utilityBillKind } from "nw-tracker-contracts";
import type { ArchivedMail } from "../email/santanderMailArchive.js";
import { decodeHoaStatement, subjectMonth } from "./hoaStatementMails.js";
import { utilityBillsFromDecoded } from "./utilityBillMails.js";

/** A unit statement as `pdftotext -layout` prints it (synthetic building, unit and figures). */
function unitStatement(o: { header?: string; dated?: string; unit?: string; total?: string } = {}): string {
  return `
                                                  COMUNIDAD EDIFICIO EJEMPLO 100
                                                  DETALLE DE GASTOS COMUNES
                                                         ${o.header ?? "septiembre-2036"}
                                                                                                     ${o.dated ?? "Santiago 08 de octubre de 2036"}

REMUNERACIONES
                   Sueldo conserje                                                         500.000
Subtotal Gastos de Remuneración                                                                            $ 500.000

GASTO TOTAL                                                                                                $ 1.500.000

Es su responsabilidad cancelar sus Gastos Comunes extendiendo cheque cruzado y nominativo a
"Comunidad Edificio Ejemplo 100" dentro de los 5 días siguientes a la formulación de esta cobranza"

Sr(a).             Persona Ejemplo                         Depto             ${o.unit ?? "1203"}
Estacionamiento                      Saldo pendiente/favor           Inspección de gases                Gasto comun        $55.000

Fondo de reserva          $3.300 Seguro depto.                       comunes
                                                                                              $9.900 Total a pagar       ${o.total ?? "$68.200"}
`;
}

const mail = (subject: string, attachments: { filename: string; text: string }[], sent = "2036-10-11 13:45"): ArchivedMail => ({
  message_id: `<${subject.length}-${sent}@test>`,
  sent_at_chile: sent,
  from: "administracion@example.test",
  subject,
  text: "Administración",
  attachments: attachments.map((a) => ({ ...a, file: `/tmp/${a.filename}` })),
});

const pdfs = (text = unitStatement(), name = "1203.pdf") => [
  { filename: name, text },
  { filename: "DETALLE GENERAL.pdf", text: "DETALLE GENERAL" },
  { filename: "COMENTARIOS.pdf", text: "Comentarios" },
];

describe("gastos comunes statements", () => {
  it("reads the unit's total and files it in the month before the statement date", () => {
    const d = decodeHoaStatement(mail("BUENAS TARDES ACA DEJO GASTOS COMUNES SEPTIEMBRE 2036", pdfs()), "comunidad_edificio")!;
    expect(d).toMatchObject({
      provider: "comunidad_edificio",
      service: "hoa",
      service_account: "1203",
      bill_number: "1203-2036-09",
      issued_on: "2036-10-08",
      due_on: "2036-10-13",
      amount: 68200,
      period_from: "2036-09-01",
      period_to: "2036-09-30",
      kwh: null,
      m3: null,
    });
    expect(() => utilityBillKind.payload.parse({ bills: utilityBillsFromDecoded([d]) })).not.toThrow();
  });

  it("takes a subject with no month, an abbreviated one, and a January statement for December", () => {
    expect(decodeHoaStatement(mail("BUENAS TARDES, ACA DEJO GASTOS COMUNES", pdfs()), "c")?.bill_number).toBe("1203-2036-09");
    const dec = unitStatement({ header: "diciembre-2037", dated: "Santiago 08 de enero de 2037" });
    // The header's year is not read: one real statement printed the following year.
    expect(decodeHoaStatement(mail("ADJUNTO GASTOS COMUNES DIC.2036", pdfs(dec)), "c")).toMatchObject({
      bill_number: "1203-2036-12",
      issued_on: "2037-01-08",
      period_to: "2036-12-31",
    });
  });

  it("decodes other mails from the administration to null", () => {
    expect(decodeHoaStatement(mail("CITACION ASAMBLEA 28/06/2036", []), "c")).toBeNull();
    // A gas inspection report also comes as «<unit>.pdf».
    expect(decodeHoaStatement(mail("reparación de gases depto. con sello amarillo", pdfs("INFORME DE INSPECCION")), "c")).toBeNull();
  });

  it("throws on a statement it cannot read or that disagrees with itself", () => {
    expect(() => decodeHoaStatement(mail("adjunto gastos comunes septiembre", []), "c")).toThrow(/one unit statement PDF/);
    expect(() => decodeHoaStatement(mail("adjunto gastos comunes septiembre", pdfs("")), "c")).toThrow(/not a gastos comunes statement/);
    expect(() => decodeHoaStatement(mail("adjunto gastos comunes agosto 2036", pdfs()), "c")).toThrow(/subject names agosto/);
    expect(() => decodeHoaStatement(mail("adjunto gastos comunes", pdfs(unitStatement({ header: "agosto-2036" }))), "c")).toThrow(/header month/);
    expect(() => decodeHoaStatement(mail("adjunto gastos comunes", pdfs(unitStatement({ unit: "1204" }))), "c")).toThrow(/states unit 1204/);
    expect(() => decodeHoaStatement(mail("adjunto gastos comunes", pdfs(unitStatement({ total: "pendiente" }))), "c")).toThrow(/Total a pagar/);
  });
});

describe("subjectMonth", () => {
  it("reads a month name or a dotted abbreviation, with or without a year", () => {
    expect(subjectMonth("Buenos días, adjunto gasto común Julio 2036")).toEqual({ month: 6, year: 2036 });
    expect(subjectMonth("buenos días, acá adjunto gastos comunes Octubre")).toEqual({ month: 9, year: null });
    expect(subjectMonth("BUENOS DÍAS, ACA ADJUNTO GASTOS COMUNES NOV.2036")).toEqual({ month: 10, year: 2036 });
    expect(subjectMonth("BUENAS TARDES, ACA DEJO GASTOS COMUNES")).toBeNull();
  });
});
