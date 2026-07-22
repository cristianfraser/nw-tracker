/**
 * One-time repair: make the Nov-2024 cuota 9 / prepago 1 `depto_payments` rows sequential.
 *
 * The Numbers export applied prepago 1 (2024-11-18) at month grain: cuota 9 (2024-11-11)
 * carries the post-prepago balance (3126.219 UF) while prepago 1's own row holds a
 * non-sequential 3191.9385 (= cuota 8 − 515, ignoring cuota 9). On the daily grid that
 * misplaces the 515-UF balance drop a week early and invents a ±19.7M CLP P/L couplet.
 *
 * True chronology (exact from the stored amortization amounts):
 *   cuota 8  2024-10-11  3706.9385
 *   cuota 9  2024-11-11  3706.9385 − 4.14 − 61.58 = 3641.2185
 *   prepago1 2024-11-18  3641.2185 − 515.0        = 3126.2185 (kept as the stored 3126.219)
 *
 * `valor_neto_uf/clp` follow (vivienda 5400 − restante; CLP at the row's uf_daily).
 * Report-only by default; `--apply` writes. Updates BOTH mirrors (property + mortgage rows).
 * Refuses to run when current values don't match the expected pre-repair state.
 */
import { db } from "../src/db.js";

type Target = {
  cuota: string;
  occurred_on: string;
  expect_cruf: number;
  new_cruf: number;
};

const TARGETS: Target[] = [
  { cuota: "9", occurred_on: "2024-11-11", expect_cruf: 3126.219, new_cruf: 3641.2185 },
  { cuota: "prepago 1", occurred_on: "2024-11-18", expect_cruf: 3191.9385, new_cruf: 3126.219 },
];

const apply = process.argv.includes("--apply");

const rows = db
  .prepare(
    `SELECT dp.movement_id, dp.kind, dp.cuota, m.occurred_on,
            dp.credito_restante_uf, dp.valor_neto_uf, dp.valor_neto_clp, dp.valor_vivienda_uf
     FROM depto_payments dp JOIN movements m ON m.id = dp.movement_id
     WHERE m.occurred_on BETWEEN '2024-11-01' AND '2024-11-30'
     ORDER BY m.occurred_on, dp.kind`
  )
  .all() as {
  movement_id: number;
  kind: string;
  cuota: string;
  occurred_on: string;
  credito_restante_uf: number | null;
  valor_neto_uf: number | null;
  valor_neto_clp: number | null;
  valor_vivienda_uf: number | null;
}[];

const ufOn = (ymd: string): number => {
  const r = db
    .prepare(`SELECT clp_per_uf FROM uf_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`)
    .get(ymd) as { clp_per_uf: number } | undefined;
  if (r == null || !Number.isFinite(r.clp_per_uf)) throw new Error(`no uf_daily row <= ${ymd}`);
  return r.clp_per_uf;
};

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

let planned = 0;
const updates: { movement_id: number; cruf: number; vnuf: number; vnclp: number }[] = [];

for (const target of TARGETS) {
  const matches = rows.filter(
    (r) => r.cuota === target.cuota && r.occurred_on === target.occurred_on
  );
  if (matches.length !== 2) {
    throw new Error(
      `expected exactly 2 mirror rows for cuota "${target.cuota}" on ${target.occurred_on}, found ${matches.length} — already repaired or unexpected state, aborting`
    );
  }
  for (const r of matches) {
    if (r.credito_restante_uf !== target.expect_cruf) {
      throw new Error(
        `cuota "${r.cuota}" (movement ${r.movement_id}, ${r.kind}): credito_restante_uf is ${r.credito_restante_uf}, expected pre-repair ${target.expect_cruf} — aborting`
      );
    }
    if (r.valor_vivienda_uf == null) {
      throw new Error(`cuota "${r.cuota}" (movement ${r.movement_id}): missing valor_vivienda_uf`);
    }
    const vnuf = round4(r.valor_vivienda_uf - target.new_cruf);
    const vnclp = Math.round(vnuf * ufOn(target.occurred_on));
    updates.push({ movement_id: r.movement_id, cruf: target.new_cruf, vnuf, vnclp });
    planned++;
    console.log(
      `${r.cuota} (movement ${r.movement_id}, ${r.kind}, ${r.occurred_on}):\n` +
        `  credito_restante_uf ${r.credito_restante_uf} -> ${target.new_cruf}\n` +
        `  valor_neto_uf       ${r.valor_neto_uf} -> ${vnuf}\n` +
        `  valor_neto_clp      ${r.valor_neto_clp} -> ${vnclp}`
    );
  }
}

if (!apply) {
  console.log(`\nreport only — ${planned} rows would change. Re-run with --apply to write.`);
} else {
  const stmt = db.prepare(
    `UPDATE depto_payments SET credito_restante_uf = ?, valor_neto_uf = ?, valor_neto_clp = ?
     WHERE movement_id = ?`
  );
  db.transaction(() => {
    for (const u of updates) {
      const res = stmt.run(u.cruf, u.vnuf, u.vnclp, u.movement_id);
      if (res.changes !== 1) throw new Error(`movement ${u.movement_id}: ${res.changes} rows changed`);
    }
  })();
  console.log(`\napplied — ${planned} rows updated.`);
}
