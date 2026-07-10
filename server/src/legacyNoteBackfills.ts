/**
 * One-time note→table backfills for migration 157 (run as a post-migration hook from
 * `db.ts`, inside the migration transaction; idempotent and a no-op on fresh DBs).
 *
 * The parsers below are FROZEN copies of the legacy note codecs (deptoDividendosLedger /
 * movementMirrorConvert) as of their deletion from runtime. Machine payloads move into
 * `depto_payments` and `movement_mirror_merges`; the movement notes are rewritten to human
 * summaries. This module must stay pure (no imports from modules that import `db`).
 */
import type { Database } from "better-sqlite3";

// ---------- frozen depto note codec ----------

const DEPTO_NOTE_PREFIXES = [
  "import:excel|depto-dividendos",
  "import:excel|depto-mortgage",
  "manual|depto-dividendos",
  "manual|depto-mortgage",
] as const;

/** Numeric fields carried by the legacy depto note (tag → depto_payments column). */
const DEPTO_NOTE_NUM_FIELDS: Record<string, string> = {
  uf: "amount_uf",
  cruf: "credito_restante_uf",
  vvuf: "valor_vivienda_uf",
  vnuf: "valor_neto_uf",
  vnclp: "valor_neto_clp",
  pnuf: "pagado_neto_uf",
  paclp: "pago_acumulado_clp",
  minuf: "min_uf",
  amclp: "amortizacion_clp",
  amuf: "amortizacion_uf",
  axclp: "amortizacion_ext_clp",
  axuf: "amortizacion_ext_uf",
  iclp: "interes_clp",
  iuf: "interes_uf",
  fireclp: "incendio_clp",
  desclp: "desgravamen_clp",
};

/** Note fields the legacy builder wrote pre-rounded to whole CLP (Math.round). */
const DEPTO_CLP_ROUNDED = new Set([
  "valor_neto_clp",
  "pago_acumulado_clp",
  "amortizacion_clp",
  "amortizacion_ext_clp",
  "interes_clp",
  "incendio_clp",
  "desgravamen_clp",
]);

type ParsedDeptoNote = { cuota: string; fields: Record<string, number | null> };

function parseLegacyDeptoNote(note: string): ParsedDeptoNote | null {
  if (!DEPTO_NOTE_PREFIXES.some((p) => note.startsWith(p))) return null;
  const raw: Record<string, string> = {};
  for (const seg of note.split("|").slice(1)) {
    const eq = seg.indexOf("=");
    if (eq <= 0) continue;
    raw[seg.slice(0, eq)] = seg.slice(eq + 1);
  }
  if (raw.cuota == null) return null;
  let cuota: string;
  try {
    cuota = decodeURIComponent(raw.cuota);
  } catch {
    cuota = raw.cuota;
  }
  const fields: Record<string, number | null> = {};
  for (const [tag, col] of Object.entries(DEPTO_NOTE_NUM_FIELDS)) {
    const s = raw[tag];
    fields[col] = s == null || s === "" ? null : Number(s);
  }
  return { cuota, fields };
}

function isPieCuota(cuota: string): boolean {
  return cuota.trim().toLowerCase() === "pie";
}

function isPrepagoCuota(cuota: string): boolean {
  return /^prepago/i.test(cuota.trim());
}

// ---------- frozen mirror-merge note codec ----------

const MIRROR_MERGE_NOTE_RE =
  /^mirror-merge\|out\((\d+)@(\d{4}-\d{2}-\d{2})@(-?[\d.]+)@(-?[\d.]+|-)\):([^|]*)\|in\((\d+)@(\d{4}-\d{2}-\d{2})@(-?[\d.]+)@(-?[\d.]+|-)\):([^|]*)$/;

function decodeEmbeddedNote(encoded: string): string | null {
  if (encoded === "-") return null;
  return encoded.replace(/¦/g, "|");
}

function decodeNum(s: string): number | null {
  if (s === "-") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`mirror-merge note: invalid number "${s}"`);
  return n;
}

type MirrorLeg = {
  movement_id: number;
  occurred_on: string;
  amount_clp: number;
  units_delta: number | null;
  note: string | null;
};

function parseLegacyMirrorMergeNote(note: string): { out: MirrorLeg; in: MirrorLeg } {
  const m = MIRROR_MERGE_NOTE_RE.exec(note);
  if (!m) throw new Error(`not a mirror-merge note: ${note}`);
  return {
    out: {
      movement_id: Number(m[1]),
      occurred_on: m[2]!,
      amount_clp: decodeNum(m[3]!)!,
      units_delta: decodeNum(m[4]!),
      note: decodeEmbeddedNote(m[5]!),
    },
    in: {
      movement_id: Number(m[6]),
      occurred_on: m[7]!,
      amount_clp: decodeNum(m[8]!)!,
      units_delta: decodeNum(m[9]!),
      note: decodeEmbeddedNote(m[10]!),
    },
  };
}

// ---------- backfill ----------

function deptoHumanNote(kind: "dividendos" | "mortgage", cuota: string, manual: boolean): string {
  const base = isPieCuota(cuota)
    ? "Depto pie"
    : kind === "mortgage"
      ? `Pago hipoteca — cuota ${cuota}`
      : `Depto dividendo — cuota ${cuota}`;
  return manual ? `${base} (manual)` : base;
}

function crossCheckAgainstStaging(
  dbi: Database,
  cuota: string,
  occurredOn: string,
  fields: Record<string, number | null>
): void {
  const hasStaging = dbi
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='depto_dividendos_sheet_rows'`)
    .get();
  if (!hasStaging) return;
  const row = dbi
    .prepare(`SELECT row_json FROM depto_dividendos_sheet_rows WHERE cuota = ? AND occurred_on = ?`)
    .get(cuota, occurredOn) as { row_json: string } | undefined;
  if (!row) return; // manual rows post-date the staging mirror — the note is authoritative
  const json = JSON.parse(row.row_json) as Record<string, unknown>;
  for (const [col, noteVal] of Object.entries(fields)) {
    const jsonValRaw = json[col];
    const jsonVal = typeof jsonValRaw === "number" && Number.isFinite(jsonValRaw) ? jsonValRaw : null;
    if (noteVal == null || jsonVal == null) continue; // builder omitted nulls; only compare both-present
    const tol = DEPTO_CLP_ROUNDED.has(col) ? 0.501 : Math.max(1e-6, Math.abs(jsonVal) * 1e-9);
    if (Math.abs(noteVal - jsonVal) > tol) {
      throw new Error(
        `depto backfill: staging mismatch for cuota ${cuota} ${occurredOn} ${col}: note=${noteVal} staging=${jsonVal}`
      );
    }
  }
}

/** Post-migration hook for 157: promote depto + mirror-merge note payloads into their tables. */
export function runLegacyNoteBackfill157(dbi: Database): void {
  // --- depto payments ---
  const deptoRows = dbi
    .prepare(
      `SELECT id, occurred_on, note, flow_kind FROM movements
       WHERE note LIKE 'import:excel|depto-%' OR note LIKE 'manual|depto-%'
       ORDER BY occurred_on, id`
    )
    .all() as { id: number; occurred_on: string; note: string; flow_kind: string | null }[];

  const insDepto = dbi.prepare(
    `INSERT OR IGNORE INTO depto_payments (
       movement_id, kind, origin, cuota,
       amount_uf, credito_restante_uf, valor_vivienda_uf, valor_neto_uf, valor_neto_clp,
       pagado_neto_uf, pago_acumulado_clp, min_uf,
       amortizacion_clp, amortizacion_uf, amortizacion_ext_clp, amortizacion_ext_uf,
       interes_clp, interes_uf, incendio_clp, desgravamen_clp
     ) VALUES (
       @movement_id, @kind, @origin, @cuota,
       @amount_uf, @credito_restante_uf, @valor_vivienda_uf, @valor_neto_uf, @valor_neto_clp,
       @pagado_neto_uf, @pago_acumulado_clp, @min_uf,
       @amortizacion_clp, @amortizacion_uf, @amortizacion_ext_clp, @amortizacion_ext_uf,
       @interes_clp, @interes_uf, @incendio_clp, @desgravamen_clp
     )`
  );
  const updNote = dbi.prepare(`UPDATE movements SET note = ? WHERE id = ?`);
  const updFlowKind = dbi.prepare(`UPDATE movements SET flow_kind = ? WHERE id = ? AND flow_kind IS NULL`);

  let deptoDone = 0;
  for (const m of deptoRows) {
    const parsed = parseLegacyDeptoNote(m.note);
    if (!parsed) {
      throw new Error(`depto backfill: movement ${m.id} has an unparseable depto note: ${m.note}`);
    }
    const kind = m.note.includes("depto-mortgage") ? "mortgage" : "dividendos";
    const origin = m.note.startsWith("manual|") ? "manual" : "import";
    if (kind === "dividendos") {
      crossCheckAgainstStaging(dbi, parsed.cuota, m.occurred_on, parsed.fields);
    }
    insDepto.run({ movement_id: m.id, kind, origin, cuota: parsed.cuota, ...parsed.fields });
    if (kind === "mortgage") {
      updFlowKind.run(
        isPrepagoCuota(parsed.cuota) ? "prepago_parcial_hipotecario" : "pago_cuota_hipotecario",
        m.id
      );
    }
    updNote.run(deptoHumanNote(kind, parsed.cuota, origin === "manual"), m.id);
    deptoDone += 1;
  }

  // --- mirror merges ---
  const mirrorRows = dbi
    .prepare(`SELECT id, note FROM movements WHERE note LIKE 'mirror-merge|%'`)
    .all() as { id: number; note: string }[];
  const insMirror = dbi.prepare(
    `INSERT OR IGNORE INTO movement_mirror_merges (
       transfer_movement_id,
       out_movement_id, out_occurred_on, out_amount_clp, out_units_delta, out_note,
       in_movement_id, in_occurred_on, in_amount_clp, in_units_delta, in_note
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let mirrorDone = 0;
  for (const m of mirrorRows) {
    const d = parseLegacyMirrorMergeNote(m.note);
    insMirror.run(
      m.id,
      d.out.movement_id,
      d.out.occurred_on,
      d.out.amount_clp,
      d.out.units_delta,
      d.out.note,
      d.in.movement_id,
      d.in.occurred_on,
      d.in.amount_clp,
      d.in.units_delta,
      d.in.note
    );
    updNote.run(`Traspaso espejo (retiro ${d.out.occurred_on} → depósito ${d.in.occurred_on})`, m.id);
    mirrorDone += 1;
  }

  if (deptoDone > 0 || mirrorDone > 0) {
    console.log(
      `migration 157 backfill: ${deptoDone} depto payment(s), ${mirrorDone} mirror merge(s) promoted from notes`
    );
  }
}
