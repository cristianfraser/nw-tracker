#!/usr/bin/env python3
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import List

from cc_pdf_ocr import cached_ocr_flat


class CachedOcrFlatTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.cache_dir = root / "cache"
        self.pdf = root / "scan.pdf"
        self.pdf.write_bytes(b"synthetic scan A")
        self.reads: List[Path] = []

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _ocr(self, path: Path) -> str:
        self.reads.append(path)
        return f"text of read {len(self.reads)}"

    def _read(self, pdf: Path, *, model: str = "model-1", dpi: int = 400, engine: str = "engine-1") -> str:
        return cached_ocr_flat(
            pdf, cache_dir=self.cache_dir, model_sha256=model, dpi=dpi, engine=engine, run_ocr=self._ocr
        )

    def test_a_pdf_is_read_once(self) -> None:
        self.assertEqual(self._read(self.pdf), "text of read 1")
        self.assertEqual(self._read(self.pdf), "text of read 1")
        self.assertEqual(len(self.reads), 1)

    def test_a_copy_under_another_name_shares_the_read(self) -> None:
        copy = self.pdf.with_name("copy.pdf")
        copy.write_bytes(self.pdf.read_bytes())
        self._read(self.pdf)
        self.assertEqual(self._read(copy), "text of read 1")
        self.assertEqual(len(self.reads), 1)

    def test_changed_bytes_are_read_again(self) -> None:
        self._read(self.pdf)
        self.pdf.write_bytes(b"synthetic scan B")
        self.assertEqual(self._read(self.pdf), "text of read 2")

    def test_another_model_dpi_or_engine_replaces_the_entry(self) -> None:
        self._read(self.pdf)
        self.assertEqual(self._read(self.pdf, model="model-2"), "text of read 2")
        self.assertEqual(self._read(self.pdf, model="model-2", dpi=300), "text of read 3")
        self.assertEqual(self._read(self.pdf, model="model-2", dpi=300, engine="engine-2"), "text of read 4")
        # The entry now belongs to the last identity; the first one is read again.
        self.assertEqual(self._read(self.pdf), "text of read 5")

    def test_a_failed_read_stores_nothing(self) -> None:
        def boom(_path: Path) -> str:
            raise RuntimeError("ocr failed")

        with self.assertRaises(RuntimeError):
            cached_ocr_flat(
                self.pdf, cache_dir=self.cache_dir, model_sha256="model-1", dpi=400, engine="engine-1", run_ocr=boom
            )
        self.assertEqual(self._read(self.pdf), "text of read 1")


if __name__ == "__main__":
    unittest.main()
