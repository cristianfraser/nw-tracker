#!/usr/bin/env python3
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from lider_browser_cache import clear_http_cache


class ClearHttpCacheTest(unittest.TestCase):
    def test_removes_the_caches_and_keeps_the_sign_in_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            default = Path(tmp) / "Default"
            (default / "Cache" / "Cache_Data").mkdir(parents=True)
            (default / "Cache" / "Cache_Data" / "entry").write_bytes(b"stale page shell")
            (default / "Code Cache" / "js").mkdir(parents=True)
            (default / "Local Storage").mkdir()
            (default / "Cookies").write_bytes(b"session")
            self.assertEqual(clear_http_cache(Path(tmp)), ["Cache", "Code Cache"])
            self.assertFalse((default / "Cache").exists())
            self.assertFalse((default / "Code Cache").exists())
            self.assertTrue((default / "Cookies").is_file())
            self.assertTrue((default / "Local Storage").is_dir())
            self.assertEqual(clear_http_cache(Path(tmp)), [])

    def test_a_profile_never_used_has_nothing_to_remove(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(clear_http_cache(Path(tmp)), [])


if __name__ == "__main__":
    unittest.main()
