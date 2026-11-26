"""
The Lider fetcher's browser profile keeps its sign-in state, never its HTTP cache.

The site serves its page shell (index.html, the same document for every route) with a
Last-Modified date and no Cache-Control, so Chrome keeps it by its heuristic: fresh for a tenth of
the time since it was modified — days, for a build a month old. After the site publishes a new
build and removes the old one's scripts, a route whose shell is still cached asks for scripts that
no longer exist (the server answers them with the HTML shell), nothing starts and the page stays
blank: the login form never appears, or the movements page asks for no list (2026-11-26: every
fetch for 19 hours, each route failing until its own cached copy was reloaded by hand).
"""
from __future__ import annotations

import shutil
from pathlib import Path
from typing import List

# Chrome's per-profile HTTP cache and the compiled-script cache built from it. Cookies, local
# storage and the rest of the profile stay.
HTTP_CACHE_DIRS = ("Cache", "Code Cache")


def clear_http_cache(profile_dir: Path) -> List[str]:
    """Remove the profile's HTTP caches before the browser starts; returns what was removed."""
    removed: List[str] = []
    for name in HTTP_CACHE_DIRS:
        path = profile_dir / "Default" / name
        if path.is_dir():
            shutil.rmtree(path)
            removed.append(name)
    return removed
