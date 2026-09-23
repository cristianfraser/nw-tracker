"""Text sources for staged grocery receipts: a PDF's layout text, or a photo's OCR text.

OCR = Apple Vision through the small Swift CLI beside this module (`grocery_receipt_ocr.swift`,
compiled on demand into `.ocr_bin/`, keyed by the source's sha256 — no Python deps, reads HEIC,
applies EXIF orientation). Vision returns text BLOCKS with geometry, not lines, so
`assemble_lines` rebuilds the receipt's rows: it de-skews block centres by the median text
angle (a phone photo is never level; a 2° tilt across a row is more than a row's height),
forms rows from confident blocks only, then attaches low-confidence blocks to the nearest row
— never lets one bridge two rows (a misread `$` came back as one tall low-confidence block
spanning two item lines) — and drops low-confidence digit-less blocks from the text (a junk
`cscs` where the `$` sits would otherwise be swallowed into a description).

Provenance and the human repair path per staged photo dir:
  ocr.json           the engine's blocks, verbatim (cache: engine version + image sha256)
  ocr.txt            the assembled lines the parser sees
  ocr.corrected.txt  hand-fixed text; when present it is what gets parsed (`text_source`
                     'ocr_corrected'), the two files above stay untouched as evidence
"""
from __future__ import annotations

import hashlib
import json
import math
import shutil
import statistics
import subprocess
from pathlib import Path

from grocery_receipt_model import ReceiptParseError

SCRIPT_DIR = Path(__file__).resolve().parent
OCR_SOURCE = SCRIPT_DIR / "grocery_receipt_ocr.swift"
OCR_BIN_DIR = SCRIPT_DIR / ".ocr_bin"
OCR_BIN = OCR_BIN_DIR / "grocery_receipt_ocr"
OCR_ENGINE = "apple-vision"
# Bump when the Swift source or the assembly rules change in a way that must re-OCR the corpus.
OCR_ENGINE_VERSION = 1

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".tif", ".tiff", ".webp"}
PDF_SUFFIXES = {".pdf"}

# Blocks at or above this confidence form rows; below it they may only join an existing row.
CONF_ANCHOR = 0.5
# Row-join tolerance as a fraction of the median block height (rows are ~1 block tall apart).
ROW_JOIN = 0.6
# A low-confidence block farther than this (× median height) from every row is dropped.
ATTACH_MAX = 1.0
# Blocks at least this wide (normalised) vote on the text angle.
ANGLE_MIN_WIDTH = 0.15


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def pdftotext_layout(pdf: Path) -> str:
    r = subprocess.run(["pdftotext", "-layout", str(pdf), "-"], capture_output=True, text=True)
    if r.returncode != 0:
        raise ReceiptParseError(f"pdftotext failed on {pdf.name}: {r.stderr.strip()}")
    return r.stdout


# ---------------------------------------------------------------------------------------------
# OCR runner (compile on demand)
# ---------------------------------------------------------------------------------------------


def ocr_binary() -> Path:
    """The compiled Vision CLI, rebuilt whenever the Swift source changed (sha256 beside it)."""
    src_sha = sha256_file(OCR_SOURCE)
    sha_file = OCR_BIN_DIR / "grocery_receipt_ocr.source.sha256"
    if OCR_BIN.is_file() and sha_file.is_file() and sha_file.read_text().strip() == src_sha:
        return OCR_BIN
    swiftc = shutil.which("swiftc")
    if not swiftc:
        raise ReceiptParseError(
            "swiftc not found — receipt-photo OCR needs the Xcode command-line tools (xcode-select --install)"
        )
    OCR_BIN_DIR.mkdir(exist_ok=True)
    r = subprocess.run([swiftc, "-O", "-o", str(OCR_BIN), str(OCR_SOURCE)], capture_output=True, text=True)
    if r.returncode != 0:
        raise ReceiptParseError(f"swiftc failed to build {OCR_SOURCE.name}:\n{r.stderr.strip()}")
    sha_file.write_text(src_sha + "\n")
    return OCR_BIN


def ocr_image(image: Path) -> dict:
    r = subprocess.run([str(ocr_binary()), str(image)], capture_output=True, text=True)
    if r.returncode != 0:
        raise ReceiptParseError(f"OCR failed on {image.name}: {r.stderr.strip()}")
    out = json.loads(r.stdout)
    if not isinstance(out.get("blocks"), list) or not out.get("width") or not out.get("height"):
        raise ReceiptParseError(f"OCR output malformed for {image.name}")
    return out


# ---------------------------------------------------------------------------------------------
# Blocks → lines
# ---------------------------------------------------------------------------------------------


def _text_angle(blocks: list[dict], width: float, height: float) -> float:
    """Median angle (radians, image space, y down) of the wide blocks' top edges."""
    angles: list[float] = []
    for b in blocks:
        if b.get("conf", 0.0) < CONF_ANCHOR or b["w"] < ANGLE_MIN_WIDTH:
            continue
        tl, tr = b.get("tl"), b.get("tr")
        if not tl or not tr:
            continue
        dx = (tr[0] - tl[0]) * width
        dy = -(tr[1] - tl[1]) * height  # Vision y is up; image rows go down
        if dx <= 0:
            continue
        angles.append(math.atan2(dy, dx))
    return statistics.median(angles) if angles else 0.0


def assemble_lines(ocr: dict) -> str:
    width, height = float(ocr["width"]), float(ocr["height"])
    blocks = [dict(b) for b in ocr["blocks"] if b.get("text", "").strip()]
    if not blocks:
        return ""
    theta = _text_angle(blocks, width, height)
    cos_t, sin_t = math.cos(-theta), math.sin(-theta)
    cx0, cy0 = width / 2, height / 2
    for b in blocks:
        px = (b["x"] + b["w"] / 2) * width
        py = (1.0 - (b["y"] + b["h"] / 2)) * height
        # De-skew: rotate the centre about the image centre by −θ so rows become horizontal.
        dx, dy = px - cx0, py - cy0
        b["_cx"] = cx0 + dx * cos_t - dy * sin_t
        b["_cy"] = cy0 + dx * sin_t + dy * cos_t
        b["_h"] = b["h"] * height
        b["_anchor"] = b.get("conf", 0.0) >= CONF_ANCHOR

    anchors = [b for b in blocks if b["_anchor"]]
    if not anchors:
        raise ReceiptParseError("OCR returned no confident text block")
    h_med = statistics.median(b["_h"] for b in anchors)
    rows: list[dict] = []  # {"cy": running mean, "blocks": [...]}
    for b in sorted(anchors, key=lambda b: b["_cy"]):
        if rows and abs(b["_cy"] - rows[-1]["cy"]) <= ROW_JOIN * h_med:
            row = rows[-1]
            n = len(row["blocks"])
            row["cy"] = (row["cy"] * n + b["_cy"]) / (n + 1)
            row["blocks"].append(b)
        else:
            rows.append({"cy": b["_cy"], "blocks": [b]})
    for b in blocks:
        if b["_anchor"]:
            continue
        nearest = min(rows, key=lambda r: abs(r["cy"] - b["_cy"]))
        if abs(nearest["cy"] - b["_cy"]) <= ATTACH_MAX * h_med:
            nearest["blocks"].append(b)
        # else: dropped from the text (still in ocr.json)

    out_lines: list[str] = []
    for row in sorted(rows, key=lambda r: r["cy"]):
        parts = []
        for b in sorted(row["blocks"], key=lambda b: b["_cx"]):
            if not b["_anchor"] and not any(ch.isdigit() for ch in b["text"]):
                continue  # low-confidence junk with no digit: never a price, never a code
            parts.append(b["text"].strip())
        if parts:
            out_lines.append("  ".join(parts))
    return "\n".join(out_lines) + "\n"


# ---------------------------------------------------------------------------------------------
# Staged text resolution
# ---------------------------------------------------------------------------------------------


def document_kind(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in PDF_SUFFIXES:
        return "pdf"
    if suffix in IMAGE_SUFFIXES:
        return "image"
    raise ReceiptParseError(f"unsupported receipt document type: {path.name}")


def staged_text_for_image(staged_dir: Path, image: Path) -> tuple[str, str]:
    """(text, text_source) for a staged photo: OCR cached in ocr.json/ocr.txt, hand-corrected
    text in ocr.corrected.txt taking precedence."""
    ocr_json = staged_dir / "ocr.json"
    ocr_txt = staged_dir / "ocr.txt"
    corrected = staged_dir / "ocr.corrected.txt"
    image_sha = sha256_file(image)
    cached: dict | None = None
    if ocr_json.is_file():
        try:
            cached = json.loads(ocr_json.read_text())
        except json.JSONDecodeError:
            cached = None
        if cached is not None and (
            cached.get("engine") != OCR_ENGINE
            or cached.get("engine_version") != OCR_ENGINE_VERSION
            or cached.get("source_sha256") != image_sha
        ):
            cached = None
    if cached is None or not ocr_txt.is_file():
        result = ocr_image(image)
        result["engine_version"] = OCR_ENGINE_VERSION
        result["source_sha256"] = image_sha
        result["source_file"] = image.name
        ocr_json.write_text(json.dumps(result, ensure_ascii=False))
        ocr_txt.write_text(assemble_lines(result))
    if corrected.is_file():
        return corrected.read_text(), "ocr_corrected"
    return ocr_txt.read_text(), "ocr"


def text_for_document(staged_dir: Path, document: Path) -> tuple[str, str]:
    """(text, text_source) — 'pdftotext' | 'ocr' | 'ocr_corrected'."""
    kind = document_kind(document)
    if kind == "pdf":
        return pdftotext_layout(document), "pdftotext"
    return staged_text_for_image(staged_dir, document)
