/**
 * Places a card statement prints as a store's branch, spelled as they are written: the bank prints
 * them in capitals without accents («PENALOLEN», «VINA DEL MAR») and cuts its merchant column at
 * 22 characters, so the branch often ends mid-word («VINA DEL MA», «ALTO LAS CON»). Display only
 * (`vendorCatalog.ts` branch entries). A new place is one line here.
 */
import { foldVendorName } from "./expenseNameText.js";

const PLACES: readonly string[] = [
  // Comunas
  "Santiago",
  "Santiago Centro",
  "Providencia",
  "Las Condes",
  "Vitacura",
  "Lo Barnechea",
  "La Reina",
  "Ñuñoa",
  "Peñalolén",
  "Macul",
  "La Florida",
  "Maipú",
  "Pudahuel",
  "Quilicura",
  "Huechuraba",
  "Recoleta",
  "Independencia",
  "Estación Central",
  "San Miguel",
  "Puente Alto",
  "Viña del Mar",
  "Valparaíso",
  "Concepción",
  "Rancagua",
  // Malls, avenues and places stores are named after
  "Alto Las Condes",
  "Parque Arauco",
  "Costanera Center",
  "Plaza Egaña",
  "Plaza Vespucio",
  "Vespucio Sur",
  "Los Dominicos",
  "Los Presidentes",
  "Los Leones",
  "Pedro de Valdivia",
  "Irarrázaval",
  "Huérfanos",
  "Apoquindo",
  "Manquehue",
  "Tobalaba",
  "Ciudad Satélite",
  "Isabel la Católica",
  "Quilín",
  "Puente Nuevo",
  "Las Catalpas",
  "Consistorial",
  "Alcántara",
];

type Place = { words: string[]; folded: string; foldedWords: string[] };

const PLACE_ENTRIES: readonly Place[] = PLACES.map((p) => ({
  words: p.split(" "),
  folded: foldVendorName(p),
  foldedWords: foldVendorName(p).split(" "),
})).sort((a, b) => b.foldedWords.length - a.foldedWords.length);

export type PlacedBranch = {
  /** The branch with its places spelled out («Viña del Mar»). */
  text: string;
  /** When a cut branch could be several places: each full branch, for the user to pick. */
  choices: string[] | null;
};

/**
 * The candidates whose folded name starts with `tail`; one that every other one starts with
 * (word by word: «Santiago» before «Santiago Centro») is the cut's own place.
 */
function completionsOf(tail: string): Place[] {
  const cands = PLACE_ENTRIES.filter((p) => p.folded.length > tail.length && p.folded.startsWith(tail));
  if (cands.length <= 1) return cands;
  const shortest = [...cands].sort((a, b) => a.folded.length - b.folded.length)[0]!;
  return cands.every((c) => c === shortest || c.folded.startsWith(`${shortest.folded} `)) ? [shortest] : cands;
}

/**
 * A branch (title-cased, single spaces) with its places spelled out. When `cut`, a branch that
 * ends mid-word completes to the one place it starts («Vina del Ma» → «Viña del Mar»); several
 * places come back as `choices` and the text stays as printed.
 */
export function placeBranch(branch: string, cut: boolean): PlacedBranch {
  let words = branch.split(" ").filter(Boolean);
  let choices: string[] | null = null;
  const folded = words.map((w) => foldVendorName(w));
  const last = words[words.length - 1] ?? "";
  if (cut && /^\p{L}{2,}$/u.test(last)) {
    for (let i = 0; i < words.length; i++) {
      const tail = folded.slice(i).join(" ");
      if (PLACE_ENTRIES.some((p) => p.folded === tail)) break;
      const cands = completionsOf(tail);
      if (cands.length === 1) {
        words = [...words.slice(0, i), ...cands[0]!.words];
        break;
      }
      if (cands.length > 1) {
        choices = cands.map((c) => [...words.slice(0, i), ...c.words].join(" "));
        break;
      }
    }
  }
  // Accents: every whole-word run that is a place takes the place's spelling.
  const out: string[] = [];
  const fw = words.map((w) => foldVendorName(w));
  for (let i = 0; i < words.length; ) {
    const hit = PLACE_ENTRIES.find(
      (p) => p.foldedWords.length <= fw.length - i && p.foldedWords.every((w, k) => fw[i + k] === w)
    );
    if (hit) {
      out.push(...hit.words);
      i += hit.foldedWords.length;
    } else out.push(words[i++]!);
  }
  return { text: out.join(" "), choices };
}
