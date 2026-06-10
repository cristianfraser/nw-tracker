import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FINTUAL_CERTIFICADO_CANONICAL_NAME,
  findFintualCertificadoInboxCsv,
  processFintualCertificadoInboxCsv,
  validateFintualCertificadoCsv,
} from "./fintualCertificadoInbox.js";
import * as cfraserPaths from "./cfraserPaths.js";

const NATIVE_HEADER =
  "Fecha,Hora,Id Inversión,Nombre Inversión,Nombre Fondo,Serie Fondo,Aporte Cuotas,Rescate Cuotas,Valor Cuota,Saldo Cuotas Final Dia,Aporte Pesos Chilenos,Rescate Pesos Chilenos,Medio,Saldo Pesos Chilenos Final Dia";

const SAMPLE_ROW =
  '14/05/2026,12:00:00,1164983, Reserva,Very Conservative Streep,A,"1.955,9173",0,"1.431,5534","19.107,7578",$2.800.000,0,Transferencia electronica,$27.353.776';

describe("fintualCertificadoInbox", () => {
  let tmpRoot: string;
  let cfraserDir: string;
  let inboxDir: string;
  let prevInboxEnv: string | undefined;
  let prevCsvEnv: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevInboxEnv === undefined) delete process.env.CFRASER_INBOX_DIR;
    else process.env.CFRASER_INBOX_DIR = prevInboxEnv;
    if (prevCsvEnv === undefined) delete process.env.CFRASER_CSV_DIR;
    else process.env.CFRASER_CSV_DIR = prevCsvEnv;
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function setupDirs(): void {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fintual-inbox-"));
    cfraserDir = path.join(tmpRoot, "cfraser");
    inboxDir = path.join(cfraserDir, "inbox");
    fs.mkdirSync(inboxDir, { recursive: true });
    prevInboxEnv = process.env.CFRASER_INBOX_DIR;
    prevCsvEnv = process.env.CFRASER_CSV_DIR;
    process.env.CFRASER_INBOX_DIR = inboxDir;
    process.env.CFRASER_CSV_DIR = cfraserDir;
    vi.spyOn(cfraserPaths, "resolveCfraserInboxDir").mockReturnValue(inboxDir);
    vi.spyOn(cfraserPaths, "resolveCfraserCsvDir").mockReturnValue(cfraserDir);
  }

  it("finds exact certificado_de_transacciones.csv in inbox", () => {
    setupDirs();
    const csvPath = path.join(inboxDir, "certificado_de_transacciones.csv");
    fs.writeFileSync(csvPath, "x", "utf8");
    expect(findFintualCertificadoInboxCsv(cfraserDir)).toBe(csvPath);
  });

  it("returns null when inbox has no certificado CSV", () => {
    setupDirs();
    expect(findFintualCertificadoInboxCsv(cfraserDir)).toBeNull();
  });

  it("validates native Fintual export headers", () => {
    setupDirs();
    const csvPath = path.join(tmpRoot, "cert.csv");
    fs.writeFileSync(csvPath, [NATIVE_HEADER, SAMPLE_ROW].join("\n"), "utf8");
    expect(validateFintualCertificadoCsv(csvPath)).toBe(1);
  });

  it("throws when required columns are missing", () => {
    setupDirs();
    const csvPath = path.join(tmpRoot, "bad.csv");
    fs.writeFileSync(csvPath, "fecha,aporte_pesos_chilenos\n01/01/2025,100\n", "utf8");
    expect(() => validateFintualCertificadoCsv(csvPath)).toThrow(/missing required column/i);
  });

  it("installs inbox CSV to canonical path and archives source", () => {
    setupDirs();
    const inboxCsv = path.join(inboxDir, "certificado_de_transacciones.csv");
    fs.writeFileSync(inboxCsv, [NATIVE_HEADER, SAMPLE_ROW].join("\n"), "utf8");

    const r = processFintualCertificadoInboxCsv({ cfraserDir });

    expect(r.inboxPath).toBe(inboxCsv);
    expect(r.rows).toBe(1);
    expect(r.csvPath).toBe(path.join(cfraserDir, FINTUAL_CERTIFICADO_CANONICAL_NAME));
    expect(r.archivedTo).toBe(
      path.join(cfraserDir, "fintual-certificado", "certificado_de_transacciones.csv")
    );
    expect(fs.existsSync(inboxCsv)).toBe(false);
    expect(fs.readFileSync(r.csvPath!, "utf8")).toContain("1164983");
    expect(fs.readFileSync(r.archivedTo!, "utf8")).toContain("1164983");
  });

  it("no-ops when inbox is empty", () => {
    setupDirs();
    const r = processFintualCertificadoInboxCsv({ cfraserDir });
    expect(r).toEqual({ inboxPath: null, csvPath: null, rows: 0, archivedTo: null });
  });
});
