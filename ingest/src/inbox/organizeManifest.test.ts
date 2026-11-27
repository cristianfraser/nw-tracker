import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { heldFileNotices, loadCfraserOrganizeManifest } from "./organizeManifest.js";

describe("held files in the organize manifest", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const manifestFile = (body: unknown) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "organize-manifest-"));
    dirs.push(dir);
    const file = path.join(dir, "manifest.json");
    fs.writeFileSync(file, JSON.stringify(body));
    return file;
  };

  it("turns each held file into one notice naming the file, the reason and where it is kept", () => {
    const manifest = loadCfraserOrganizeManifest(
      manifestFile({
        cuenta_vista_pdfs: [],
        checking_pdfs: [],
        credit_card_pdfs: [],
        held: [
          { file: "DOC-1_2.pdf", held_as: "inbox/held/DOC-1_2.pdf", reason: "not_a_known_document" },
          {
            file: "DOC-9_9.pdf",
            held_as: "inbox/held/DOC-9_9 (2).pdf",
            reason: "cannot_decrypt",
            hint: "set SANTANDER_CC_STATEMENT_PDF_PASSWORD and/or LIDER_CC_STATEMENT_PDF_PASSWORD",
          },
          { file: "DOC-7_7.pdf", held_as: "inbox/held/DOC-7_7.pdf", reason: "unrecognised_bank_document", word: "SANTANDER" },
        ],
      })
    );
    expect(heldFileNotices(manifest.held)).toEqual([
      "Held, not imported: DOC-1_2.pdf — readable, with no bank document word in it; kept in cfraser/inbox/held/",
      "Held, not imported: DOC-9_9.pdf — no configured statement password opens it; kept in cfraser/inbox/held/ as DOC-9_9 (2).pdf" +
        " — set SANTANDER_CC_STATEMENT_PDF_PASSWORD and/or LIDER_CC_STATEMENT_PDF_PASSWORD in the root .env, then move it back to cfraser/inbox/ to retry",
      "Held, not imported: DOC-7_7.pdf — prints «SANTANDER» but is not a statement or cartola the organizer recognises; " +
        "if it is one, the parser needs to learn its layout (kept in cfraser/inbox/held/)",
    ]);
    expect(heldFileNotices(manifest.held.slice(0, 1), { dryRun: true })[0]).toMatch(/^Would hold, not imported: DOC-1_2\.pdf/);
  });

  it("reads a manifest from before held files as holding none, and refuses an entry it cannot name", () => {
    expect(loadCfraserOrganizeManifest(manifestFile({ cuenta_vista_pdfs: [], checking_pdfs: ["a.pdf"], credit_card_pdfs: [] })).held).toEqual([]);
    expect(() => loadCfraserOrganizeManifest(manifestFile({ held: [{ file: "a.pdf", held_as: "inbox/held/a.pdf", reason: "other" }] }))).toThrow(
      /not a held file/
    );
    expect(() =>
      loadCfraserOrganizeManifest(manifestFile({ held: [{ file: "a.pdf", held_as: "inbox/held/a.pdf", reason: "unrecognised_bank_document" }] }))
    ).toThrow(/not a held file/);
  });
});
