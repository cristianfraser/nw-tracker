"""Lider BCI web session through Scrapling's stealth browser.

The earlier Playwright fetcher (scraper/src/lider, deleted 2026-08) could not get past the
Cloudflare Turnstile box on the login form. Scrapling's StealthySession solves embedded Turnstile
widgets (`solve_cloudflare=True`), so this script retries the session with it.

Modes:
  * feed (default): log in, open the movements page, keep the bank's answers for the national and
    international «Por facturar» lists (`movfacturarpesos`, `movfacturardolares`), the credit-line
    balances (`consultasaldos`) and the card header (`consultadatoscabecera`), and stage them as
    ONE file cfraser/lider-card-feed/lider-card-movements-<UTC stamp>.json holding the raw bodies
    (decoding is `ingest/src/lider/cardFeed.ts`'s job). No national list → no file, exit 1.
  * --capture: the old full capture — screenshots and every JSON answer under
    cfraser/lider-captures/<stamp>/.
  * --form-only: load the page, pass Turnstile, type RUT + clave, check the form; nothing is sent.

Safety, since the bank blocks the clave after 3 failed logins:
  * the form is sent once, and only when the Turnstile token is issued, both fields hold exactly
    what was typed and the button is enabled;
  * a login that stays on /login writes cfraser/.lider-login-rejected.json ONLY when the page
    states a wrong credential (`lider_login_failure.classify_login_failure`, unverified wording);
    later runs then refuse to log in until the Keychain item is newer than the rejection (or
    --force). Any other failure (generic site error, unknown text) is transient: diagnostics
    saved, no latch, non-zero exit, the page text logged so a human can add real wording;
  * a Turnstile box that never issues a token writes cfraser/.lider-turnstile-failed.json and
    exits 3; later runs refuse for 20 hours, unless --retry-turnstile (the nightly run: one retry a
    day) or --force. --retry-turnstile never overrides the rejected-login latch.
Request bodies are never kept (the login request carries the clave); the password is never printed.

Run: ingest/python/.scrapling-venv/bin/python ingest/python/lider_bci_fetch.py [--capture|--form-only] [--headless] [--retry-turnstile] [--force]
The last line printed is a machine-readable summary: `[lider] summary {json}`.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from scrapling.fetchers import StealthySession

from lider_login_failure import classify_login_failure

REPO = Path(__file__).resolve().parents[2]
CFRASER = REPO / "cfraser"
CONFIG_PATH = CFRASER / "lider-fetch.json"
LATCH_PATH = CFRASER / ".lider-login-rejected.json"
TURNSTILE_LATCH_PATH = CFRASER / ".lider-turnstile-failed.json"
TURNSTILE_RETRY_HOURS = 20
FEED_DIR = CFRASER / "lider-card-feed"
DIAGNOSTICS = CFRASER / "scraper-diagnostics"
EXIT_TURNSTILE = 3
PROFILE_DIR = CFRASER / ".lider-browser-profile"
CAPTURES = CFRASER / "lider-captures"

ORIGIN = "https://www.liderbciserviciosfinancieros.cl"
LOGIN_URL = f"{ORIGIN}/login"
MOVEMENTS_URL = f"{ORIGIN}/private-home/my-card/movements"

SEL_RUT = 'input[placeholder="Rut" i]'
SEL_PASS = 'input[formcontrolname="pass"]'
SEL_SUBMIT = 'button[type="submit"]:not(.evg-nav-btn)'
SEL_TOKEN = 'input[name="cf-turnstile-response"]'

# Third-party traffic the page makes; never the bank's own data.
NOISE_HOSTS = re.compile(r"medallia|google|doubleclick|facebook|cloudflare|hotjar|clarity|evergage|newrelic|nr-data")


def log(msg: str) -> None:
    print(f"[lider] {msg}", flush=True)


def keychain_password(service: str, account: str) -> str:
    out = subprocess.run(
        ["security", "find-generic-password", "-s", service, "-a", account, "-w"],
        capture_output=True,
        text=True,
    )
    if out.returncode != 0:
        raise SystemExit(f"Keychain item {service!r} / {account!r} not found: {out.stderr.strip()}")
    return out.stdout.rstrip("\n")


def keychain_modified_at(service: str, account: str) -> datetime:
    out = subprocess.run(
        ["security", "find-generic-password", "-s", service, "-a", account],
        capture_output=True,
        text=True,
        check=True,
    )
    m = re.search(r'"mdat"<timedate>=0x[0-9A-F]+\s+"(\d{14})Z', out.stdout)
    if not m:
        raise SystemExit("Could not read the Keychain item's modification date.")
    return datetime.strptime(m.group(1), "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)


def check_latch(service: str, account: str, force: bool) -> None:
    if not LATCH_PATH.exists() or force:
        return
    latch = json.loads(LATCH_PATH.read_text())
    rejected_at = datetime.fromisoformat(latch["rejected_at"])
    if keychain_modified_at(service, account) > rejected_at:
        log("Keychain item changed since the last rejected login; clearing the latch.")
        LATCH_PATH.unlink()
        return
    raise SystemExit(
        f"The bank rejected the stored clave at {latch['rejected_at']} ({latch.get('message', '')!r}). "
        f"Not logging in again: update the Keychain item {service!r} or pass --force."
    )


def check_turnstile_latch(force: bool) -> None:
    if not TURNSTILE_LATCH_PATH.exists() or force:
        return
    latch = json.loads(TURNSTILE_LATCH_PATH.read_text())
    failed_at = datetime.fromisoformat(latch["failed_at"])
    age_h = (datetime.now(timezone.utc) - failed_at).total_seconds() / 3600
    if age_h >= TURNSTILE_RETRY_HOURS:
        log(f"Turnstile failure of {latch['failed_at']} is {age_h:.1f} h old; trying again.")
        return
    print(f"[lider] summary {json.dumps({'ok': False, 'reason': 'turnstile_latched', 'failed_at': latch['failed_at']})}")
    sys.exit(EXIT_TURNSTILE)


class TurnstileFailed(RuntimeError):
    pass


# The feed's endpoints (last path segment on api-ssff.retailcard.cl/ssff-api-creditcard/api/).
EP_NATIONAL = "movfacturarpesos"
EP_INTERNATIONAL_PREFIX = "movfacturar"
EP_BALANCES = "consultasaldos"
EP_HEADER = "consultadatoscabecera"


def endpoint_name(url: str) -> str:
    return url.split("?")[0].rstrip("/").rsplit("/", 1)[-1]


def normalize_rut(value: str) -> str:
    return re.sub(r"[.\-\s]", "", value).upper()


def main() -> None:
    ap = argparse.ArgumentParser()
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--capture", action="store_true", help="full capture: screenshots + every JSON answer")
    mode.add_argument("--form-only", action="store_true", help="check the login form; send nothing")
    ap.add_argument("--headless", action="store_true")
    ap.add_argument("--force", action="store_true", help="ignore the rejected-login and Turnstile latches (by hand only)")
    ap.add_argument("--retry-turnstile", action="store_true", help="ignore only the Turnstile latch (the nightly run)")
    args = ap.parse_args()
    feed = not args.capture and not args.form_only
    submit = not args.form_only

    cfg = json.loads(CONFIG_PATH.read_text())
    rut, service = cfg["rut"], cfg["keychain_service"]
    if submit:
        check_latch(service, rut, args.force)
        check_turnstile_latch(args.force or args.retry_turnstile)
    password = keychain_password(service, rut)

    now = datetime.now(timezone.utc)
    stamp = now.strftime("%Y-%m-%dT%H-%M-%S")
    out_dir = CAPTURES / stamp if not feed else DIAGNOSTICS / f"lider-{stamp}"
    if not feed:
        out_dir.mkdir(parents=True, exist_ok=True)
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)

    result: dict[str, Any] = {"stamp": stamp, "mode": "feed" if feed else ("capture" if args.capture else "form-only")}
    saved: list[str] = []
    # Feed mode: the latest body per endpoint, and every bank endpoint seen after a mark.
    latest: dict[str, Any] = {}
    seen_order: list[str] = []

    def on_response(response: Any) -> None:
        url = response.url
        if NOISE_HOSTS.search(url):
            return
        if "json" not in (response.headers.get("content-type") or ""):
            return
        try:
            body = response.json()
        except Exception:
            return
        if feed:
            if "retailcard.cl" in url:
                ep = endpoint_name(url)
                latest[ep] = {"status": response.status, "body": body}
                seen_order.append(ep)
            return
        name = f"{len(saved) + 1:03d}-" + re.sub(r"[^A-Za-z0-9_-]+", "_", url.split("?")[0].rsplit("/", 1)[-1])[:60]
        (out_dir / f"{name}.json").write_text(
            json.dumps({"url": url, "status": response.status, "method": response.request.method, "body": body},
                       ensure_ascii=False, indent=2)
        )
        saved.append(url)

    def shot(page: Any, label: str, always: bool = False) -> None:
        # Feed mode keeps screenshots only for errors (`always`), under scraper-diagnostics/.
        if feed and not always:
            return
        out_dir.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(out_dir / f"{label}.png"), full_page=True)

    def action(page: Any) -> None:
        try:
            run(page)
        except Exception as e:  # Scrapling only logs page_action errors; keep ours
            result["error"] = f"{type(e).__name__}: {e}"
            if isinstance(e, TurnstileFailed):
                result["turnstile_failed"] = True
            try:
                shot(page, "error", always=True)
                (out_dir / "error-page.txt").write_text(page.inner_text("body"))
            except Exception:
                pass

    def run(page: Any) -> None:
        page.on("response", on_response)
        result["landed_url"] = page.url
        if "/login" not in page.url:
            log(f"session still valid ({page.url})")
            result["logged_in"] = True
        else:
            rut_in = page.locator(SEL_RUT).first
            pass_in = page.locator(SEL_PASS).first
            rut_in.wait_for(state="visible", timeout=30_000)

            token = ""
            for _ in range(120):
                token = page.locator(SEL_TOKEN).first.input_value() if page.locator(SEL_TOKEN).count() else ""
                if token:
                    break
                page.wait_for_timeout(500)
            result["turnstile_token"] = bool(token)
            log(f"Turnstile token issued: {bool(token)}")
            if not token:
                shot(page, "turnstile-not-passed", always=True)
                raise TurnstileFailed("Turnstile never issued a token")

            rut_in.click()
            rut_in.press_sequentially(rut, delay=80)
            pass_in.click()
            pass_in.press_sequentially(password, delay=80)
            page.wait_for_timeout(800)

            rut_val = rut_in.input_value()
            pass_len = len(pass_in.input_value())
            submit = page.locator(SEL_SUBMIT).first
            enabled = submit.is_enabled()
            token_after = page.locator(SEL_TOKEN).first.input_value()
            result.update(rut_ok=normalize_rut(rut_val) == normalize_rut(rut),
                          pass_ok=pass_len == len(password), submit_enabled=enabled,
                          token_still_set=bool(token_after))
            log(f"form: rut_ok={result['rut_ok']} pass_ok={result['pass_ok']} "
                f"button_enabled={enabled} token_still_set={bool(token_after)}")
            shot(page, "form-ready")
            if not (result["rut_ok"] and result["pass_ok"] and enabled and token_after):
                raise RuntimeError("form not ready; not submitting")
            if not submit:
                log("form-only: form ready, not submitting")
                return

            submit.click()
            try:
                page.wait_for_url(lambda u: "/login" not in u, timeout=60_000)
            except Exception:
                text = page.inner_text("body")
                out_dir.mkdir(parents=True, exist_ok=True)
                (out_dir / "login-rejected.txt").write_text(text)
                shot(page, "login-rejected", always=True)
                message = " ".join(text.split())[:300]
                if classify_login_failure(text) == "wrong_clave":
                    LATCH_PATH.write_text(json.dumps({
                        "rejected_at": datetime.now(timezone.utc).isoformat(),
                        "message": message,
                    }, ensure_ascii=False, indent=2))
                    raise RuntimeError("the bank rejected the clave; latched further logins")
                log(f"login failure not recognised as a wrong clave (no latch); page text: {message!r}")
                raise RuntimeError(
                    "still on /login after submitting, page does not state a wrong clave "
                    "(transient site error?); NOT latched, see login-rejected.txt and the screenshot"
                )
            result["logged_in"] = True
            log(f"logged in: {page.url}")
            page.wait_for_timeout(4000)
            page.keyboard.press("Escape")  # promotional modal on the dashboard
            shot(page, "dashboard")

        page.goto(MOVEMENTS_URL, wait_until="domcontentloaded")
        if not feed:
            page.wait_for_timeout(8000)
            shot(page, "movements")
            (out_dir / "movements-page.txt").write_text(page.inner_text("body"))
            result["movements_url"] = page.url
            return
        read_feed(page)

    def wait_for(page: Any, pred: Any, seconds: float) -> Any:
        for _ in range(int(seconds * 2)):
            hit = pred()
            if hit:
                return hit
            page.wait_for_timeout(500)
        return pred()

    def read_feed(page: Any) -> None:
        national = wait_for(page, lambda: latest.get(EP_NATIONAL), 30)
        if not national:
            raise RuntimeError(f"the national «Por facturar» list ({EP_NATIONAL}) never arrived")
        staged["national"] = national
        mark = len(seen_order)
        tab = page.get_by_text("Internacionales", exact=True).first
        try:
            tab.click(timeout=15_000)

            def intl() -> Any:
                for ep in seen_order[mark:]:
                    if ep.startswith(EP_INTERNATIONAL_PREFIX) and ep != EP_NATIONAL:
                        return ep
                return None

            ep = wait_for(page, intl, 20)
            result["after_international_click"] = sorted(set(seen_order[mark:]))
            if ep:
                staged["international"] = {"endpoint": ep, **latest[ep]}
            else:
                staged["international_error"] = "no movfacturar* answer after clicking «Internacionales»"
        except Exception as e:
            staged["international_error"] = f"{type(e).__name__}: {e}"
        if "international_error" in staged:
            shot(page, "international-missing", always=True)
            (out_dir / "international-page.txt").write_text(page.inner_text("body"))
        balances = latest.get(EP_BALANCES) or wait_for(page, lambda: latest.get(EP_BALANCES), 5)
        if balances:
            staged["balances"] = balances
        else:
            staged["balances_error"] = f"{EP_BALANCES} was not answered in this session"
        header = latest.get(EP_HEADER)
        if header:
            staged["header"] = header

    staged: dict[str, Any] = {}

    with StealthySession(headless=args.headless, solve_cloudflare=True,
                         user_data_dir=str(PROFILE_DIR), network_idle=True) as session:
        session.fetch(LOGIN_URL, page_action=action, solve_cloudflare=True, network_idle=True)

    if result.get("turnstile_failed"):
        TURNSTILE_LATCH_PATH.write_text(json.dumps({
            "failed_at": datetime.now(timezone.utc).isoformat(),
            "reason": result["error"],
        }, ensure_ascii=False, indent=2))
        summary(result, ok=False, reason="turnstile_failed")
        sys.exit(EXIT_TURNSTILE)
    if result.get("logged_in") and TURNSTILE_LATCH_PATH.exists():
        TURNSTILE_LATCH_PATH.unlink()

    if not feed:
        result["saved_json"] = saved
        (out_dir / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
        log(f"capture: {out_dir}")
        log(f"{len(saved)} JSON responses saved")
        summary(result, ok="error" not in result)
        if "error" in result:
            sys.exit(1)
        return

    if "error" in result or "national" not in staged:
        summary(result, ok=False, reason=result.get("error", "no national list"))
        sys.exit(1)
    card_last4 = None
    titular = ((staged.get("header") or {}).get("body") or {}).get("titular") or {}
    m = re.search(r"(\d{4})$", str(titular.get("tarjeta") or ""))
    if m:
        card_last4 = m.group(1)
    if not card_last4:
        summary(result, ok=False, reason=f"no card number from {EP_HEADER}")
        sys.exit(1)
    observed_at = now.astimezone().isoformat(timespec="seconds")
    doc: dict[str, Any] = {
        "observed_at": observed_at,
        "card_last4": card_last4,
        "national": staged["national"]["body"],
        "international": (staged.get("international") or {}).get("body"),
        "international_endpoint": (staged.get("international") or {}).get("endpoint"),
        "balances": (staged.get("balances") or {}).get("body"),
    }
    if "international_error" in staged:
        doc["international_error"] = staged["international_error"]
    if "balances_error" in staged:
        doc["balances_error"] = staged["balances_error"]
    FEED_DIR.mkdir(parents=True, exist_ok=True)
    path = FEED_DIR / f"lider-card-movements-{stamp}.json"
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2))
    result["staged"] = str(path.relative_to(REPO))
    result["national_rows"] = len((doc["national"] or {}).get("movimiento") or [])
    result["international_rows"] = len((doc["international"] or {}).get("movimiento") or []) if doc["international"] else None
    result["balances"] = doc["balances"] is not None
    log(f"staged {path}")
    summary(result, ok=True)


def summary(result: dict[str, Any], ok: bool, reason: str | None = None) -> None:
    keep = {k: v for k, v in result.items() if k not in ("saved_json",)}
    keep["ok"] = ok
    if reason:
        keep["reason"] = reason
    print(f"[lider] summary {json.dumps(keep, ensure_ascii=False)}", flush=True)


if __name__ == "__main__":
    main()
