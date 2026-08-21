#!/usr/bin/env python3
"""
Funbox fast cart-grabber.

The real race is getting a slot in the cart the instant a model is listed.
This script does NOT drive the browser UI (slow) - it replays the store's own
add-to-cart HTTP call using your logged-in session cookie:

    POST https://shop.funbox.com.tw/cart/add   body: id=<variant_id>&quantity=N

On detection it: (1) scrapes the product's variant id, (2) fires /cart/add to
secure the cart, (3) opens the checkout page in your browser so you finish the
payment yourself.

IT NEVER PAYS OR SUBMITS THE ORDER. Store pickup on funbox is prepay
(credit card / LINE Pay / Google Pay); entering the card and pressing the final
button are always your job.

Setup:
    pip install requests beautifulsoup4
    Fill config.json -> fast_cart.session_cookie  (see note in that file)

Run:
    python fast_cart.py
"""

import json
import re
import sys
import time
import webbrowser
from datetime import datetime
from pathlib import Path

import requests

import monitor  # reuse search-url / parse / match helpers

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "config.json"
LOG_PATH = HERE / "fast_cart.log"
BASE = "https://shop.funbox.com.tw"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def log(msg: str) -> None:
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    print(line, flush=True)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def make_session(cookie: str) -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": UA,
        "Accept-Language": "zh-TW,zh;q=0.9",
    })
    if cookie:
        s.headers["Cookie"] = cookie.strip()
    return s


def scrape_variant_id(session: requests.Session, product_url: str) -> str | None:
    """Fetch a product page and pull its variant id out of the inline JSON."""
    r = session.get(product_url, timeout=15)
    r.raise_for_status()
    html = r.text
    m = re.search(r'variant_id["\']?\s*[:=]\s*["\']?(\d+)', html)
    if m:
        return m.group(1)
    # fallback: the add-to-cart button carries data-id
    m = re.search(r'class="[^"]*addToCart[^"]*"[^>]*data-id="(\d+)"', html)
    return m.group(1) if m else None


def add_to_cart(session: requests.Session, variant_id: str, qty: int) -> bool:
    r = session.post(
        f"{BASE}/cart/add",
        data={"id": variant_id, "quantity": qty},
        headers={"X-Requested-With": "XMLHttpRequest",
                 "Content-Type": "application/x-www-form-urlencoded"},
        timeout=15,
    )
    ok = r.status_code in (200, 201, 302)
    log(f"/cart/add id={variant_id} qty={qty} -> HTTP {r.status_code} ({'OK' if ok else 'FAIL'})")
    return ok


def grab(session: requests.Session, hit: dict, cfg: dict) -> None:
    fc = cfg.get("fast_cart", {})
    qty = int(fc.get("quantity", 1))
    log(f"*** HIT {hit['matched']}: {hit['title']}  {hit['url']}")
    try:
        vid = scrape_variant_id(session, hit["url"])
        if not vid:
            log("  could not find variant id - opening product page for manual add")
            webbrowser.open(hit["url"])
            return
        log(f"  variant_id={vid}")
        if add_to_cart(session, vid, qty):
            log("  cart slot secured.")
        else:
            log("  add failed (cookie expired? logged out?) - opening product page")
            webbrowser.open(hit["url"])
            return
    except requests.RequestException as e:
        log(f"  network error: {e} - opening product page")
        webbrowser.open(hit["url"])
        return

    # Hand off to you for payment + final submit. We NEVER submit or pay.
    if fc.get("open_checkout_after_add", True):
        webbrowser.open(f"{BASE}/cart")
    print("\a", end="", flush=True)
    if sys.platform.startswith("win"):
        try:
            import winsound
            winsound.Beep(880, 200); winsound.Beep(1320, 350)
        except Exception:
            pass
    log("  >>> checkout page opened. Finish payment + press the final button yourself. <<<")


def main() -> None:
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    fc = cfg.get("fast_cart", {})
    if not fc.get("enabled"):
        print("fast_cart.enabled is false in config.json"); sys.exit(1)
    cookie = fc.get("session_cookie", "")
    if not cookie:
        print("Fill fast_cart.session_cookie in config.json first (see the note there).")
        sys.exit(1)

    targets = [t.strip() for t in cfg.get("targets", []) if t.strip()]
    query = cfg.get("search_query", "UX")
    interval = max(30, int(cfg.get("check_interval_seconds", 60)))
    url = monitor.build_search_url(query)
    session = make_session(cookie)

    log(f"Fast cart-grabber started. Targets={targets} interval={interval}s")
    grabbed: set[str] = set()

    while True:
        try:
            html = monitor.fetch(url)
            products = monitor.parse_products(html)
            hits = [h for h in monitor.match_targets(products, targets) if not h["sold_out"]]
            log(f"checked: {len(products)} results, {len(hits)} buyable target(s)")
            for h in hits:
                if h["matched"] not in grabbed:
                    grab(session, h, cfg)
                    grabbed.add(h["matched"])
        except Exception as e:
            log(f"loop error (will retry): {e}")
        time.sleep(interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("Stopped by user.")
