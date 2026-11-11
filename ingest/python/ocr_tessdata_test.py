#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from ocr_tessdata import require_tessdata_prefix


def _tessdata_dir(root: Path, name: str, model: bytes | None) -> str:
    d = root / name
    d.mkdir()
    if model is not None:
        (d / "eng.traineddata").write_bytes(model)
    return str(d)


class RequireTessdataPrefixTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.expected = hashlib.sha256(b"expected model").hexdigest()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_first_standard_folder_with_the_expected_model(self) -> None:
        other = _tessdata_dir(self.root, "other", b"another model")
        empty = _tessdata_dir(self.root, "empty", None)
        good = _tessdata_dir(self.root, "good", b"expected model")
        got = require_tessdata_prefix(
            env_prefix="", candidates=(other, empty, good), expected_sha256=self.expected
        )
        self.assertEqual(got, good)

    def test_no_folder_has_the_model(self) -> None:
        other = _tessdata_dir(self.root, "other", b"another model")
        missing = str(self.root / "missing")
        with self.assertRaises(RuntimeError) as ctx:
            require_tessdata_prefix(
                env_prefix="", candidates=(other, missing), expected_sha256=self.expected
            )
        message = str(ctx.exception)
        self.assertIn("OCR model mismatch", message)
        self.assertIn(hashlib.sha256(b"another model").hexdigest()[:16], message)
        self.assertIn("no eng.traineddata", message)

    def test_env_prefix_is_the_only_folder_considered(self) -> None:
        other = _tessdata_dir(self.root, "other", b"another model")
        good = _tessdata_dir(self.root, "good", b"expected model")
        self.assertEqual(
            require_tessdata_prefix(
                env_prefix=good, candidates=(other,), expected_sha256=self.expected
            ),
            good,
        )
        with self.assertRaises(RuntimeError) as ctx:
            require_tessdata_prefix(
                env_prefix=other, candidates=(good,), expected_sha256=self.expected
            )
        self.assertIn("TESSDATA_PREFIX", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
