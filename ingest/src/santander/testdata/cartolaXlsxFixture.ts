/**
 * A synthetic cuenta corriente cartola workbook for the xlsx download's tests: the bank's header
 * layout (rows 1–21 of its workbook) with made-up account, holder and figures.
 */
import XLSX from "xlsx";

export const SYNTHETIC_ACCOUNT = "0-000-00-12345-6";

export function syntheticCartolaXlsx(
  opts: { account?: string; type?: string; desde?: string; hasta?: string; title?: string } = {}
): Buffer {
  const rows: unknown[][] = [
    ["Banco Santander", "", "", "", opts.title ?? "Cartola de cuenta Corriente - Julio 2026", "", ""],
    [],
    [],
    ["Sr(a)", "TITULAR DE PRUEBA", "", "", "Cartola N°", "7", ""],
    ["Rut", "11.111.111-1", "", "", "Desde", opts.desde ?? "30/06/2026", ""],
    ["E-mail", "titular@example.com", "", "", "Hasta", opts.hasta ?? "31/07/2026", ""],
    [],
    [],
    ["INFORMACIÓN CUENTA CORRIENTE", "", "", "", "", "", ""],
    ["Tipo de Cuenta:", opts.type ?? "CUENTA CORRIENTE ML", "", "", "N° Cuenta:", opts.account ?? SYNTHETIC_ACCOUNT, ""],
    ["Saldo inicial:", "$100.000", "", "", "Impuestos:", "$0", ""],
    ["Saldo final:", "$130.000", "", "", "Depósitos:", "$0", ""],
    [],
    ["DETALLE DE MOVIMIENTOS", "", "", "", "", "SALDOS DIARIOS", ""],
    ["FECHA", "SUCURSAL", "DESCRIPCIÓN", "N° DOCUMENTO", "CHEQUES Y OTROS CARGOS", "DEPOSITOS Y OTROS ABONOS", "SALDO"],
    ["03/07", "Agustinas", "Transf. de Prueba SpA", "123", "", 50000, ""],
    ["15/07", "Internet", "Pago tarjeta de prueba", "", 20000, "", "$130.000"],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Cartola de Cuenta");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
