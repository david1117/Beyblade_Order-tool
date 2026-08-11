#!/usr/bin/env python3
"""
Funbox shelf monitor.

Polls the Funbox shop search on an interval and alerts you the moment one of
your target model codes appears (and looks buyable). It does NOT place orders.
When a target is detected it plays a sound, shows a desktop popup, and opens
the product page in your browser so you can check out in a couple of clicks.

Runs entirely on your machine. No AI tokens are used.

Setup (once):
    pip install requests beautifulsoup4 plyer

Run:
    python monitor.py

Stop:
    Ctrl+C
"""

import json
import re
import sys
import time
import webbrowser
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import requests
from bs4 import BeautifulSoup

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "config.json"
LOG_PATH = HERE / "watchlist.log"
BASE = "https://shop.funbox.com.tw"


def log(msg: str) -> None:
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    print(line, flush=True)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def load_config() -> dict:
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def build_search_url(query: str) -> str:
    # Mirrors the shop's own search-results URL. Returns server-rendered HTML.
    json_state = json.dumps([
        {"collection_handles": [], "product_type": []},
        {"collection_handles": []},
        {"on_sale": False},
        {"channel_name": ""},
        {"q": query},
    ], ensure_ascii=False)
    return (f"{BASE}/search?json={quote(json_state)}"
            f"&q={quote(query)}&sort_by=sell_from-desc")


def fetch(url: str) -> str:
    headers = {
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/124.0 Safari/537.36"),
        "Accept-Language": "zh-TW,zh;q=0.9",
    }
    r = requests.get(url, headers=headers, timeout=20)
    r.raise_for_status()
    return r.text


def parse_products(html: str) -> list[dict]:
    """Extract product cards from the search results HTML.

    Returns a list of {title, url, sold_out} dicts. Selectors are kept broad
    on purpose so minor theme changes don't break detection; if the shop
    restructures its markup, adjust the anchor filter below.
    """
    soup = BeautifulSoup(html, "html.parser")
    products = []
    seen = set()
    for a in soup.select('a[href*="/products/"]'):
        href = a.get("href", "")
        if "/products/" not in href:
            continue
        url = href if href.startswith("http") else BASE + href
        if url in seen:
            continue
        seen.add(url)
        # Title: prefer the link text, fall back to img alt.
        title = a.get_text(" ", strip=True)
        if not title:
            img = a.find("img")
            title = img.get("alt", "").strip() if img else ""
        block = a.get_text(" ", strip=True)
        sold_out = any(k in block for k in ("售完", "缺貨", "補貨", "SOLD OUT", "Sold out"))
        products.append({"title": title, "url": url, "sold_out": sold_out})
    return products


def match_targets(products: list[dict], targets: list[str]) -> list[dict]:
    hits = []
    for p in products:
        hay = (p["title"] + " " + p["url"]).upper()
        for t in targets:
            code = t.upper()
            # match "UX-04", "UX04", "UX 04"
            pattern = re.escape(code).replace(r"\-", r"[-\s]?")
            if re.search(pattern, hay):
                hits.append({**p, "matched": t})
                break
    return hits


def alert(hit: dict, cfg: dict) -> None:
    notify = cfg.get("notify", {})
    status = "SOLD OUT" if hit["sold_out"] else "BUYABLE"
    log(f"*** MATCH: {hit['matched']}  [{status}]  {hit['title']}  {hit['url']}")

    if notify.get("sound", True):
        try:
            # Cross-platform-ish beep
            print("\a", end="", flush=True)
            if sys.platform.startswith("win"):
                import winsound
                winsound.Beep(880, 250); winsound.Beep(1175, 400)
        except Exception:
            pass

    if notify.get("desktop_popup", True):
        try:
            from plyer import notification
            notification.notify(
                title=f"Funbox 上架偵測: {hit['matched']}",
                message=f"{status} - {hit['title']}",
                timeout=15,
            )
        except Exception as e:
            log(f"(popup unavailable: {e})")

    # Only auto-open when it's actually buyable, to avoid opening sold-out pages.
    if notify.get("open_browser_on_hit", True) and not hit["sold_out"]:
        try:
            webbrowser.open(hit["url"])
        except Exception as e:
            log(f"(could not open browser: {e})")


def main() -> None:
    if not CONFIG_PATH.exists():
        print(f"Missing config.json next to this script ({CONFIG_PATH}).")
        sys.exit(1)

    cfg = load_config()
    targets = [t.strip() for t in cfg.get("targets", []) if t.strip()]
    query = cfg.get("search_query", "UX")
    interval = max(30, int(cfg.get("check_interval_seconds", 60)))
    url = build_search_url(query)

    log(f"Monitor started. Targets={targets}  query='{query}'  interval={interval}s")
    already_alerted: set[str] = set()

    while True:
        try:
            html = fetch(url)
            products = parse_products(html)
            hits = match_targets(products, targets)
            buyable = [h for h in hits if not h["sold_out"]]
            log(f"checked: {len(products)} results, {len(hits)} target match(es), "
                f"{len(buyable)} buyable")
            for h in hits:
                key = h["matched"] + ("|buy" if not h["sold_out"] else "|out")
                if key not in already_alerted:
                    alert(h, cfg)
                    already_alerted.add(key)
        except requests.HTTPError as e:
            log(f"HTTP error: {e}")
        except requests.RequestException as e:
            log(f"network error (will retry): {e}")
        except Exception as e:
            log(f"unexpected error (will retry): {e}")
        time.sleep(interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("Monitor stopped by user.")
