#!/usr/bin/env python3
"""
Funbox local monitor server.

Runs entirely on your computer. A background thread polls the funbox shop for
your target models; a tiny web server shows a live dashboard (dashboard.html)
and exposes two endpoints:

    GET  /api/status         -> current availability of every target
    POST /api/add            -> {variant_id, qty}  fires /cart/add on funbox

When you click "確認" on the dashboard it calls /api/add, which uses your
logged-in session cookie to secure the cart slot instantly. No AI is involved,
so there is zero thinking delay. It NEVER pays or submits the order - you finish
payment yourself in the funbox tab that opens.

Setup:
    pip install requests beautifulsoup4
    Put your session cookie in config.json -> fast_cart.session_cookie
Run:
    double-click start_funbox.bat   (or: python server.py)
"""

import json
import re
import threading
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlparse

import requests

# 誠品/momo 用 Akamai 這類防爬，會用 TLS 指紋擋掉一般 python 請求(回 429)。
# curl_cffi 能偽裝成真瀏覽器的 TLS 指紋，繞過這種封鎖；裝不起來就退回 requests。
try:
    from curl_cffi import requests as creq  # type: ignore
    HAS_CURL = True
except Exception:
    creq = None
    HAS_CURL = False

import monitor  # reuse build_search_url / fetch / parse_products / match_targets

# 東海模型（ehobbyshop）—— 純抓取/解析層放在獨立檔，可離線測試（tests/test_ehobby.py）。
# 檔案不在也不能讓整個程式開不起來，所以包起來。
try:
    import ehobby_core
    HAS_EHOBBY = True
except Exception as _e:
    ehobby_core = None
    HAS_EHOBBY = False
    print(f"[警告] 載入 ehobby_core 失敗，東海分頁停用：{_e}")

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "config.json"
DASHBOARD = HERE / "dashboard.html"
BASE = "https://shop.funbox.com.tw"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

STATE_LOCK = threading.Lock()
STATE = {"targets": {}, "last_checked": None, "logged_in": None,
         "eslite": {}, "momo": {}, "tcsb": {}, "ehobby": {}, "mm": {},
         "ehobby_meta": {"last_scan": "", "known_max": 0, "new_ids": 0,
                         "checked": 0, "keywords": [], "note": "尚未掃描"}}

# ---------- 動作紀錄：每次偵測到/加入/失敗都留下時間戳 ----------
# 目的：事後可以確認「到底有沒有成功搶到」，不會錯過了卻不知道。
EVENTS_PATH = HERE / "events.jsonl"
EVENTS_LOCK = threading.Lock()
EVENTS: list = []          # 最近 300 筆（給儀表板用）
EVENTS_MAX = 300

STORE_LABEL = {"funbox": "Funbox", "eslite": "誠品", "momo": "momo",
               "tcsb": "墊腳石", "ehobby": "東海", "mm": "M.M小舖"}


def log_event(store: str, item: str, action: str, ok=None, detail: str = "", url: str = "") -> None:
    """記一筆動作。action 例如：偵測到有貨 / 已加入購物車 / 加入失敗 / 已開商品頁。"""
    ev = {
        "ts": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "store": store, "storeName": STORE_LABEL.get(store, store),
        "item": item, "action": action,
        "ok": ok, "detail": detail, "url": url,
    }
    with EVENTS_LOCK:
        EVENTS.append(ev)
        del EVENTS[:-EVENTS_MAX]
        try:
            with EVENTS_PATH.open("a", encoding="utf-8") as f:
                f.write(json.dumps(ev, ensure_ascii=False) + "\n")
        except Exception:
            pass


def load_events() -> None:
    """啟動時把最近的紀錄讀回來，關掉重開也看得到之前發生什麼。"""
    global EVENTS
    try:
        lines = EVENTS_PATH.read_text(encoding="utf-8").splitlines()[-EVENTS_MAX:]
        EVENTS = [json.loads(x) for x in lines if x.strip()]
    except Exception:
        EVENTS = []


ESLITE_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def _extract_icode(s: str) -> str:
    """從商品網址或字串抽出 momo 商品編號 i_code。
    接受：純數字、含 i_code=xxxx 的網址、或 /product/xxxx 形式。"""
    s = str(s).strip()
    m = re.search(r"i_code=(\d+)", s) or re.search(r"/product/(\d+)", s)
    if m:
        return m.group(1)
    if s.isdigit():
        return s
    return ""


TCSB_BASE = "https://www.tcsb.com.tw"


def _extract_tcsb_code(s: str) -> str:
    """從墊腳石商品網址或字串抽出商品編號（ISBN/條碼），例如
    https://www.tcsb.com.tw/4711438507363 -> 4711438507363"""
    s = str(s).strip()
    m = re.search(r"tcsb\.com\.tw/(\d{8,14})", s)
    if m:
        return m.group(1)
    if s.isdigit() and 8 <= len(s) <= 14:
        return s
    return ""


def normalize_tcsb(raw) -> list:
    """墊腳石目標：
       - 關鍵字字串（用 /api/products?query= 搜尋，跟 funbox/誠品一樣）
       - 商品網址／條碼（精準鎖定該商品）
       - {name, query, match} 或 {name, code}
    """
    out = []
    for t in raw:
        if isinstance(t, str):
            s = t.strip()
            if not s:
                continue
            c = _extract_tcsb_code(s)
            if c:                       # 純條碼／商品網址 → 鎖定商品
                out.append({"name": c, "code": c, "query": "", "match": ""})
            else:                        # 一般關鍵字 → 搜尋
                out.append({"name": s, "code": "", "query": s, "match": s})
        elif isinstance(t, dict):
            c = _extract_tcsb_code(t.get("code", "") or t.get("url", ""))
            q = str(t.get("query", "") or t.get("name", "")).strip()
            nm = str(t.get("name", "") or c or q).strip()
            if c:
                out.append({"name": nm, "code": c, "query": "", "match": ""})
            elif q:
                out.append({"name": nm, "code": "", "query": q,
                            "match": str(t.get("match", "") or q).strip()})
    return out


def _tcsb_get(url: str, cookie: str = ""):
    headers = {"User-Agent": ESLITE_UA, "Accept": "application/json, text/plain, */*",
               "Accept-Language": "zh-TW,zh;q=0.9", "Referer": TCSB_BASE + "/"}
    if cookie:
        headers["Cookie"] = cookie
    if HAS_CURL:
        return creq.get(url, headers=headers, impersonate="chrome", timeout=15)
    return requests.get(url, headers=headers, timeout=15)


TCSB_PID_CACHE: dict = {}


def tcsb_product_id(code: str, cookie: str = ""):
    """由商品條碼取得墊腳石內部 product_id（加入購物車要用）。結果會快取。"""
    if code in TCSB_PID_CACHE:
        return TCSB_PID_CACHE[code]
    try:
        r = _tcsb_get(f"{TCSB_BASE}/{code}", cookie)
        if r.status_code != 200:
            return ""
        h = r.text
        m = (re.search(r'"product_id"\s*:\s*"?(\d+)"?', h)
             or re.search(r'product/(\d+)/shipping-methods', h)
             or re.search(r'/product/(\d+)/', h)
             or re.search(r'"id"\s*:\s*(\d+)', h))
        pid = m.group(1) if m else ""
        if pid:
            TCSB_PID_CACHE[code] = pid
        return pid
    except Exception:
        return ""


def tcsb_cart_items(cookie: str):
    """讀墊腳石購物車內容，回傳 [{pid, name, qty}]；讀不到回 None。"""
    try:
        r = _tcsb_get(f"{TCSB_BASE}/api/checkout/cart/mini", cookie)
        if r.status_code != 200:
            return None
        d = (r.json() or {})
        d = d.get("data", d)
        out = []
        for it in (d.get("items", []) or []):
            out.append({"pid": str(it.get("product_id") or it.get("id") or ""),
                        "name": it.get("name", ""),
                        "qty": it.get("quantity", 1)})
        return out
    except Exception:
        return None


def tcsb_add_to_cart(cfg: dict, code: str, qty: int = 1):
    """把墊腳石商品加入購物車（購物車在伺服器端，用你的登入 cookie）。
    每件上限 1：已經在購物車裡就不再加。
    只搶位子，付款與送出訂單一律你自己在網站上完成。"""
    cookie = str(cfg.get("tcsb", {}).get("session_cookie", "")).strip()
    if not cookie:
        return {"ok": False, "reason": "no_cookie"}
    pid = tcsb_product_id(code, cookie)
    if not pid:
        return {"ok": False, "reason": "no_product_id"}
    # 已在購物車就跳過（避免數量變 2，也少打一次請求）
    items = tcsb_cart_items(cookie)
    if items is not None and any(i["pid"] == str(pid) for i in items):
        _addlog(f"TCSB skip code={code} pid={pid} (已在購物車)")
        return {"ok": True, "reason": "already_in_cart", "skipped": True,
                "cart_url": f"{TCSB_BASE}/checkout/onepage"}
    xsrf = ""
    m = re.search(r"XSRF-TOKEN=([^;]+)", cookie)
    if m:
        from urllib.parse import unquote
        xsrf = unquote(m.group(1))
    headers = {"User-Agent": ESLITE_UA, "Accept": "application/json",
               "Content-Type": "application/json",
               "X-Requested-With": "XMLHttpRequest",
               "Referer": f"{TCSB_BASE}/{code}", "Cookie": cookie}
    if xsrf:
        headers["X-XSRF-TOKEN"] = xsrf
    payload = json.dumps({"product_id": int(pid), "quantity": int(qty), "is_buy_now": 0})
    try:
        url = f"{TCSB_BASE}/api/checkout/cart"
        if HAS_CURL:
            r = creq.post(url, headers=headers, data=payload,
                          impersonate="chrome", timeout=15)
        else:
            r = requests.post(url, headers=headers, data=payload, timeout=15)
        ok = r.status_code in (200, 201)
        _addlog(f"TCSB add code={code} pid={pid} -> {r.status_code}")
        return {"ok": ok, "reason": "ok" if ok else f"http_{r.status_code}",
                "cart_url": f"{TCSB_BASE}/checkout/onepage"}
    except Exception as e:
        return {"ok": False, "reason": f"network: {str(e)[:80]}"}


def tcsb_status(t: dict, skip_books: bool = True, exclude: list = None):
    """墊腳石偵測。
    關鍵字模式：打 /api/products?query=…（官方搜尋 API），比對商品名，
                讀 is_saleable 判斷可否購買。
    條碼模式：直接抓商品頁的 schema.org availability。
    skip_books=True 會濾掉書籍／雜誌／漫畫（它們的 sku 是 ISBN，978/979 開頭），
    exclude 是商品名要排除的關鍵字清單。
    回傳 dict 或 None（抓取失敗時保留上次狀態）。"""
    exclude = exclude or []
    try:
        if t.get("query"):
            url = f"{TCSB_BASE}/api/products?query={quote(t['query'])}"
            r = _tcsb_get(url)
            if r.status_code != 200:
                return None
            items = (r.json() or {}).get("data", []) or []

            def wanted(it) -> bool:
                nm = it.get("name", "")
                if not title_matches(nm, "", t["match"]):
                    return False
                # 書籍/雜誌/漫畫：sku 是 ISBN（978/979 開頭）→ 排除
                if skip_books and re.match(r"^97[89]", str(it.get("sku", "") or "")):
                    return False
                if any(x and x in nm for x in exclude):
                    return False
                return True

            cand = next((it for it in items if wanted(it)), None)
            if not cand:
                return {"listed": False, "buyable": False, "code": "",
                        "url": f"{TCSB_BASE}/search?query={quote(t['query'])}"}
            sku = str(cand.get("sku", "") or cand.get("url_key", ""))
            return {"listed": True, "buyable": bool(cand.get("is_saleable")),
                    "code": sku, "url": f"{TCSB_BASE}/{sku}",
                    "name": cand.get("name", ""),
                    "price": str(cand.get("min_price", "")).replace("NT$", "")}
        # 條碼模式：直接看商品頁
        code = t["code"]
        url = f"{TCSB_BASE}/{code}"
        r = _tcsb_get(url)
        if r.status_code != 200:
            return None
        h = r.text
        mt = re.search(r'og:title"\s+content="([^"]+)"', h)
        name = mt.group(1).strip() if mt else ""
        if not name:
            return {"listed": False, "buyable": False, "code": code, "url": url}
        mp = re.search(r'"price":"?([\d.]+)"?', h)
        instock = bool(re.search(r'"availability":"[^"]*InStock"', h))
        return {"listed": True, "buyable": instock, "code": code, "url": url,
                "name": name, "price": mp.group(1) if mp else ""}
    except Exception:
        return None


def normalize_momo(raw) -> list:
    """Each momo target 鎖定官方指定商品：i_code 字串/網址，或 {name, i_code}。"""
    out = []
    for t in raw:
        if isinstance(t, str):
            ic = _extract_icode(t)
            if ic:
                out.append({"name": ic, "i_code": ic})
        elif isinstance(t, dict):
            ic = _extract_icode(t.get("i_code", "") or t.get("url", ""))
            if ic:
                out.append({"name": str(t.get("name", "") or ic).strip(), "i_code": ic})
    return out


def momo_status(t: dict, brand: str = ""):
    """抓指定 i_code 的 momo 商品頁（curl_cffi 繞過 Akamai），解析正價、開賣時間、
    庫存與是否可買。回傳 dict 或 None（抓取失敗，保留上次狀態）。
    判斷：有「M/D H:MM 開賣」橫幅 → 官方預售未開賣；否則 goodsStock>0 且未售完 → 可買。"""
    ic = t["i_code"]
    url = f"https://www.momoshop.com.tw/goods/GoodsDetail.jsp?i_code={ic}"
    try:
        headers = {"User-Agent": ESLITE_UA, "Referer": "https://www.momoshop.com.tw/",
                   "Accept-Language": "zh-TW,zh;q=0.9"}
        if HAS_CURL:
            r = creq.get(url, headers=headers, impersonate="chrome", timeout=15)
        else:
            r = requests.get(url, headers=headers, timeout=15)
        if r.status_code != 200:
            return None
        h = r.text
        # 商品不存在 / 下架
        if "EC404" in h or len(h) < 2000:
            return {"listed": False, "buyable": False, "i_code": ic, "url": url}
        # 名稱（og:title，去掉 momo 後綴）
        mname = re.search(r'og:title"\s+content="([^"]+)"', h)
        name = (mname.group(1).split(" - momo")[0].strip() if mname else "")
        # 正價（schema.org price）
        mprice = re.search(r'"price"\s*:\s*"?(\d+)"?', h)
        price = mprice.group(1) if mprice else ""
        # 開賣時間橫幅（官方預售才有）
        msale = re.search(r"(\d{1,2}/\d{1,2}\s+\d{1,2}:\d{2})\s*開賣", h)
        sale_time = msale.group(1) if msale else ""
        # 庫存
        mstock = re.search(r"goodsStock\D{0,6}(\d+)", h)
        stock = int(mstock.group(1)) if mstock else 1
        soldout = bool(re.search(r"貨到通知|補貨中|已售完|完售", h))
        # 有開賣橫幅＝尚未開賣；否則有庫存且沒售完＝可買
        buyable = (not sale_time) and (stock > 0) and (not soldout)
        return {"listed": True, "buyable": buyable, "i_code": ic, "url": url,
                "name": name, "price": price, "sale_time": sale_time}
    except Exception:
        return None


def parse_momo_sale(sale_time: str):
    """把 momo 的「M/D H:MM 開賣」轉成 (epoch秒, ISO字串)。用今年；若已過超過一天就當明年。"""
    m = re.match(r"(\d{1,2})/(\d{1,2})\s+(\d{1,2}):(\d{2})", sale_time or "")
    if not m:
        return None, ""
    mon, day, hh, mm = (int(x) for x in m.groups())
    now = datetime.now()
    try:
        dt = datetime(now.year, mon, day, hh, mm, 0)
    except ValueError:
        return None, ""
    if (now - dt).total_seconds() > 86400:      # 明顯已過 → 明年
        dt = dt.replace(year=now.year + 1)
    return dt.timestamp(), dt.strftime("%Y-%m-%dT%H:%M:%S")


def normalize_eslite(raw) -> list:
    """Each eslite target: a keyword string, or {name, query, match}.
    query = what to search on 誠品; match = must appear in product name
    (defaults to query); name = card label (defaults to query)."""
    out = []
    for t in raw:
        if isinstance(t, str):
            s = t.strip()
            if s:
                out.append({"name": s, "query": s, "match": s})
        elif isinstance(t, dict):
            q = str(t.get("query", "") or t.get("name", "")).strip()
            if not q:
                continue
            out.append({"name": str(t.get("name", "") or q).strip(),
                        "query": q, "match": str(t.get("match", "") or q).strip()})
    return out


def eslite_search(query: str):
    """打誠品 holmes 搜尋。優先用 curl_cffi 偽裝瀏覽器 TLS 指紋（繞過 429 防爬），
    否則退回一般 requests 並帶上完整的瀏覽器風格標頭。回傳 response 物件。"""
    url = "https://holmes.eslite.com/v1/search"
    params = {"q": query, "page_size": 20, "page_no": 1,
              "final_price": "0,", "visitor_id": "funboxtool",
              "sort": "desc", "branch_id": 0, "facet": "false"}
    headers = {
        "User-Agent": ESLITE_UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
        "Origin": "https://www.eslite.com",
        "Referer": "https://www.eslite.com/",
    }
    last = None
    for attempt in range(3):   # 遇 429 短暫退避重試，把多數限流救回 200
        if HAS_CURL:
            # impersonate 讓 TLS/JA3 與標頭看起來就是 Chrome，最能繞過 Akamai 429
            last = creq.get(url, params=params, headers=headers,
                            impersonate="chrome", timeout=15)
        else:
            last = requests.get(url, params=params, headers=headers, timeout=15)
        if last.status_code != 429:
            return last
        time.sleep(0.8 * (attempt + 1))
    return last


def eslite_status(t: dict):
    """Search 誠品 (holmes) by keyword, match the product by name, and read its
    button_status. Buyable when button_status == 'add_to_shopping_cart'."""
    try:
        r = eslite_search(t["query"])
        # 被誠品限流(429)或其他非200：回 None，保留上次狀態，別誤翻成缺貨
        if r.status_code != 200:
            return None
        results = (r.json() or {}).get("results", [])
        cand = next((it for it in results
                     if title_matches(it.get("name", ""), "", t["match"])), None)
        if not cand:
            return {"listed": False, "buyable": False}
        eid = str(cand.get("id", ""))
        return {"listed": True,
                "buyable": cand.get("button_status") == "add_to_shopping_cart",
                "name": cand.get("name", ""), "price": cand.get("final_price", ""),
                "url": f"https://www.eslite.com/product/{eid}"}
    except Exception:
        return None

# Background-updated login validity (True/False/None) so add_to_cart stays fast.
LOGIN_STATE = {"val": None, "ts": 0.0}

# Set by /api/refresh to make the poller run a cycle immediately (skip the wait).
REFRESH_EVENT = threading.Event()

# Per-model auto-add OFF switch (persisted). Models here won't be auto-added.
DISABLED_PATH = HERE / "disabled.json"
DISABLED_LOCK = threading.Lock()
DISABLED: set = set()


STORES = ("funbox", "eslite", "momo", "tcsb", "ehobby", "mm")


def dis_key(store: str, name: str) -> str:
    """關閉清單的鍵：每個分頁各自獨立，所以要帶商店名。"""
    return f"{store}:{name}"


def is_off(store: str, name: str) -> bool:
    return dis_key(store, name) in DISABLED


def load_disabled() -> None:
    global DISABLED
    try:
        raw = set(json.loads(DISABLED_PATH.read_text(encoding="utf-8")))
        # 舊格式沒有商店前綴 → 升級成四家都關（保留你原本的設定，之後可個別打開）
        DISABLED = set()
        for x in raw:
            if ":" in x:
                DISABLED.add(x)
            else:
                for st in STORES:
                    DISABLED.add(dis_key(st, x))
    except Exception:
        DISABLED = set()


def save_disabled() -> None:
    try:
        DISABLED_PATH.write_text(json.dumps(sorted(DISABLED), ensure_ascii=False),
                                 encoding="utf-8")
    except Exception:
        pass


# Per-store detection ON/OFF (persisted). Off = stop polling that store.
STORES_PATH = HERE / "stores.json"
STORE_LOCK = threading.Lock()
STORE_ON = {"funbox": True, "eslite": True, "momo": True, "tcsb": True,
            "ehobby": True, "mm": True}


def load_stores() -> None:
    try:
        saved = json.loads(STORES_PATH.read_text(encoding="utf-8"))
        for k in STORE_ON:
            if k in saved:
                STORE_ON[k] = bool(saved[k])
    except Exception:
        pass


def save_stores() -> None:
    try:
        STORES_PATH.write_text(json.dumps(STORE_ON, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


CONFIG_DIR = HERE / "config"


CONFIG_ERRORS: list = []       # 壞掉的 config 檔清單（顯示在儀表板最上方）


def _read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {} if default is None else default


def _read_cfg_file(fname: str):
    """讀 config/ 下的檔案。檔案存在但 JSON 壞掉 → 記進 CONFIG_ERRORS 大聲顯示，
    絕對不要默默當成空設定 —— mm.json 曾因一個多打的 { 讓整家店無聲消失。"""
    p = CONFIG_DIR / fname
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        msg = f"config/{fname} 格式錯誤（該店設定全部失效）：{e}"
        if msg not in CONFIG_ERRORS:
            CONFIG_ERRORS.append(msg)
            print(f"[警告] {msg}")
        return {}


def split_config_files(cfg: dict) -> None:
    """把舊的單一 config.json 拆成 config/ 資料夾裡四家各自的檔案（只做一次）。
    這樣新手一看就知道要改哪一家，不用在一大包 JSON 裡找。"""
    CONFIG_DIR.mkdir(exist_ok=True)
    fc = cfg.get("fast_cart", {})

    files = {
        "funbox.json": {
            "_說明": "Funbox（shop.funbox.com.tw）。購物車在伺服器端，填 session_cookie 就能自動放入購物車。",
            "enabled": True,
            "auto_add": bool(fc.get("auto_add", True)),
            "session_cookie": fc.get("session_cookie", ""),
            "_cookie怎麼拿": "登入 funbox → F12 → Network → 重新整理 → 點第一筆 → 複製 Request Headers 的整行 cookie（要含 _cyberbiz_session）",
            "check_interval_seconds": cfg.get("check_interval_seconds", 10),
            "search_groups": cfg.get("search_groups", ["UX", "BX", "CX"]),
            "_targets說明": "一行一個型號或商品名，逗號分隔，最後一行不加逗號。",
            "targets": cfg.get("targets", []),
        },
        "eslite.json": {
            "_說明": "誠品線上（eslite.com）。購物車在瀏覽器端，需搭配 eslite_grab.user.js。",
            "enabled": bool(cfg.get("eslite", {}).get("enabled", True)),
            "auto_grab": bool(cfg.get("eslite", {}).get("auto_grab", True)),
            "_targets說明": "誠品是綜合書店，關鍵字要精確，否則會搜到無關的書。",
            "targets": cfg.get("eslite", {}).get("targets", []),
        },
        "momo.json": {
            "_說明": "momo（momoshop.com.tw）。鎖定官方商品編號 i_code，避開溢價賣家。需搭配 momo_grab.user.js。",
            "enabled": bool(cfg.get("momo", {}).get("enabled", True)),
            "auto_grab": bool(cfg.get("momo", {}).get("auto_grab", True)),
            "poll_interval_seconds": cfg.get("momo", {}).get("poll_interval_seconds", 60),
            "_targets說明": '每筆 {"name":"顯示名","i_code":"商品編號"}；i_code 也可直接貼商品網址。',
            "targets": cfg.get("momo", {}).get("targets", []),
        },
        "tcsb.json": {
            "_說明": "墊腳石（tcsb.com.tw）。購物車在伺服器端，填 session_cookie 就能自動放入購物車。",
            "enabled": bool(cfg.get("tcsb", {}).get("enabled", True)),
            "auto_grab": bool(cfg.get("tcsb", {}).get("auto_grab", True)),
            "session_cookie": cfg.get("tcsb", {}).get("session_cookie", ""),
            "_cookie怎麼拿": "登入 tcsb.com.tw → F12 → Network → 重新整理 → 點 www.tcsb.com.tw 那筆 → 複製整行 cookie（要含 XSRF-TOKEN 與 _session）",
            "poll_interval_seconds": cfg.get("tcsb", {}).get("poll_interval_seconds", 60),
            "skip_books": bool(cfg.get("tcsb", {}).get("skip_books", False)),
            "exclude": cfg.get("tcsb", {}).get("exclude", []),
            "_targets說明": "一行一個關鍵字；也可寫商品網址或條碼精準鎖定單一商品。",
            "targets": cfg.get("tcsb", {}).get("targets", []),
        },
        "ehobby.json": {
            "_說明": "東海模型（ehobbyshop.com.tw）。這家跟其他四家不一樣：陀螺類商品目前還沒上架，"
                     "站內也搜不到，所以沒有『目標商品』可以盯 —— 改成盯「有沒有新商品上架」。",
            "_做法": "每輪只讀 sitemap.xml 的開頭（新品排最前面），比對出比上次更新的商品 ID，"
                     "只抓那幾個商品頁的前 8KB 拿標題，標題命中關鍵字才抓整頁看庫存。"
                     "穩定狀態下每輪只有 1 個請求。",
            "enabled": True,
            "poll_interval_seconds": 600,
            "_間隔警告": "600 秒＝10 分鐘。新品上架不是秒殺場，不需要更快；調太快只會增加被鎖 IP 的風險。",
            "_keywords說明": "商品標題含任一關鍵字就通知你。大小寫不敏感。寧可寬一點，反正只是通知。",
            "keywords": ["陀螺", "BEYBLADE", "TAKARA TOMY", "UX-", "BX-", "CX-", "BXG-"],
            "open_page": True,
            "_open_page說明": "命中時要不要自動幫你開商品頁。false = 只通知不開頁。",
            "max_new_per_cycle": 40,
            "request_gap_seconds": 1.5,
            "_watch_urls說明": "已知商品想盯補貨的話，把商品網址貼進來，例如 "
                               "https://www.ehobbyshop.com.tw/product/detail/2621339 。每輪會各查一次整頁。",
            "watch_urls": [],
        },
        "mm.json": {
            "_說明": "M.M小舖（mmtoyshop.com）。規格庫存只有瀏覽器渲染後才看得到，所以這家是"
                     "「config 驅動、瀏覽器執行」：程式啟動時自動開每個目標的商品頁並帶暗號，"
                     "mm_grab.user.js 看到暗號就自動選規格、自動開始監看。分頁要保持開著（可縮到最小）。",
            "enabled": True,
            "auto_open": True,
            "_auto_open說明": "啟動時自動開監看分頁。false = 只在儀表板列出，分頁自己開。",
            "poll_interval_seconds": 120,
            "_間隔警告": "這是「瀏覽器分頁重新載入」的間隔，下限 30 秒。調太快只會增加被鎖 IP 的風險。",
            "_targets說明": '每筆 {"name":"顯示名","url":"商品網址","spec":"要盯的規格文字（可只寫片段，例如 不可搭）"}。'
                            'spec 留空 = 用頁面上目前選中的規格。',
            "targets": [],
        },
        "common.json": {
            "_說明": "四家共用的設定。",
            "server_port": cfg.get("server_port", 8787),
            "popup_alert": bool(fc.get("popup_alert", True)),
            "open_checkout_after_add": bool(fc.get("open_checkout_after_add", True)),
            "push": cfg.get("push", {"enabled": True, "telegram_bot_token": "", "telegram_chat_id": ""}),
            "_push說明": "手機推播（Telegram，可不填）。@BotFather 拿 token，@userinfobot 拿數字 id。",
        },
    }
    for fname, data in files.items():
        path = CONFIG_DIR / fname
        if not path.exists():
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


EHOBBY_SEEN_PATH = HERE / "ehobby_seen.json"


def ehobby_load_seen() -> int:
    """讀「上次看過的最大商品 ID」。沒有檔案回 0 = 還沒建立基準線。"""
    try:
        return int(_read_json(EHOBBY_SEEN_PATH, {}).get("known_max", 0))
    except Exception:
        return 0


def ehobby_save_seen(known_max: int) -> None:
    try:
        EHOBBY_SEEN_PATH.write_text(
            json.dumps({"known_max": int(known_max),
                        "updated": datetime.now().strftime("%Y-%m-%d %H:%M:%S")},
                       ensure_ascii=False),
            encoding="utf-8")
    except Exception:
        pass


def ensure_new_config_files() -> None:
    """後來才加的商店，既有使用者的 config/ 已經存在，split_config_files 不會再跑，
    所以缺的檔案要在這裡補上（不覆蓋既有檔案）。"""
    if not CONFIG_DIR.exists():
        return
    if not (CONFIG_DIR / "ehobby.json").exists():
        split_config_files({})      # 只會寫「不存在」的檔案，其他家不受影響


def load_config() -> dict:
    """優先讀 config/ 資料夾（每家一個檔）；沒有就讀舊的 config.json 並自動拆分。"""
    legacy = _read_json(CONFIG_PATH) if CONFIG_PATH.exists() else {}
    if not (CONFIG_DIR / "funbox.json").exists():
        if legacy:
            split_config_files(legacy)     # 第一次啟動：自動從舊檔拆出來，設定不會不見
        else:
            return legacy
    ensure_new_config_files()

    CONFIG_ERRORS.clear()
    fb = _read_cfg_file("funbox.json")
    es = _read_cfg_file("eslite.json")
    mo = _read_cfg_file("momo.json")
    tc = _read_cfg_file("tcsb.json")
    eh = _read_cfg_file("ehobby.json")
    mm = _read_cfg_file("mm.json")
    cm = _read_cfg_file("common.json")

    # 組回程式內部用的結構（其餘程式碼不用改）
    cfg = {
        "targets": fb.get("targets", []),
        "check_interval_seconds": fb.get("check_interval_seconds", 10),
        "search_groups": fb.get("search_groups", ["UX", "BX", "CX"]),
        "fast_cart": {
            "enabled": fb.get("enabled", True),
            "auto_add": fb.get("auto_add", True),
            "session_cookie": fb.get("session_cookie", ""),
            "cookie_source": fb.get("cookie_source", "manual"),
            "popup_alert": cm.get("popup_alert", True),
            "open_checkout_after_add": cm.get("open_checkout_after_add", True),
            "quantity": 1,
        },
        "eslite": es,
        "momo": mo,
        "tcsb": tc,
        "ehobby": eh,
        "mm": mm,
        "server_port": cm.get("server_port", 8787),
        "push": cm.get("push", {}),
        "notify": legacy.get("notify", {}),
    }
    return cfg


def make_session(cookie: str) -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept-Language": "zh-TW,zh;q=0.9"})
    if cookie:
        s.headers["Cookie"] = cookie.strip()
    return s


_cookie_cache = {"val": None, "ts": 0.0, "src": ""}


def _read_browser_cookie(browser: str) -> str:
    """Read funbox cookies straight from the installed browser (no manual copy)."""
    try:
        import browser_cookie3 as bc
    except ImportError:
        _cookielog("browser_cookie3 not installed")
        return ""
    fn = getattr(bc, browser, None)
    if fn is None:
        return ""
    try:
        cj = fn(domain_name="funbox.com.tw")
        pairs = [f"{c.name}={c.value}" for c in cj if c.value]
        names = [c.name for c in cj]
        _cookielog(f"{browser}: got {len(pairs)} cookies, names={names[:12]}")
        return "; ".join(pairs)
    except Exception as e:
        _cookielog(f"{browser}: ERROR {type(e).__name__}: {e}")
        return ""


def _cookielog(msg: str) -> None:
    try:
        with open(HERE / "cookie.log", "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}\n")
    except Exception:
        pass


def _parse_cookie_input(s: str) -> str:
    """Accept EITHER a raw cookie header value OR a whole 'Copy as cURL' paste,
    and return just the cookie string. Lets the user paste the entire request."""
    s = (s or "").strip()
    if not s:
        return ""
    low = s.lower()
    if low.startswith("curl") or " -h " in low or "--header" in low or "-b " in low:
        m = re.search(r"-H\s+['\"]cookie:\s*([^'\"]+)['\"]", s, re.IGNORECASE)
        if m:
            return m.group(1).strip()
        m = re.search(r"(?:-b|--cookie)\s+['\"]([^'\"]+)['\"]", s)
        if m:
            return m.group(1).strip()
        m = re.search(r"cookie:\s*([^\"'^\r\n]+)", s, re.IGNORECASE)
        if m:
            return m.group(1).strip()
    return s  # already a plain cookie header value


def get_cookie_header(cfg: dict) -> str:
    """Resolve the cookie to use. A manually pasted cookie (raw or a 'Copy as
    cURL' paste) always wins. Only when none is provided do we attempt to read
    it from the browser (which fails on browsers with app-bound encryption)."""
    fc = cfg.get("fast_cart", {})
    source = (fc.get("cookie_source") or "manual").strip().lower()
    manual = _parse_cookie_input(fc.get("session_cookie", ""))

    if manual:
        return manual
    if source == "manual":
        return ""

    now = time.time()
    if _cookie_cache["ts"] and _cookie_cache["src"] == source and now - _cookie_cache["ts"] < 30:
        return _cookie_cache["val"]
    order = [source] if source in ("edge", "chrome", "chromium", "brave", "firefox") else ["edge", "chrome"]
    val = ""
    for b in order:
        val = _read_browser_cookie(b)
        if val:
            break
    _cookie_cache.update(val=val, ts=now, src=source)
    return val


def scrape_variant_id(session: requests.Session, product_url: str):
    try:
        html = session.get(product_url, timeout=15).text
    except requests.RequestException:
        return None
    m = re.search(r'variant_id["\']?\s*[:=]\s*["\']?(\d+)', html)
    return m.group(1) if m else None


def normalize_targets(raw) -> list[dict]:
    """Accept either plain strings or {code, query, match} objects."""
    out = []
    for t in raw:
        if isinstance(t, str):
            code = t.strip()
            if code:
                out.append({"code": code, "query": code, "match": code})
        elif isinstance(t, dict):
            code = str(t.get("code", "")).strip()
            if not code:
                continue
            query = str(t.get("query", "") or code).strip()
            match = str(t.get("match", "") or code).strip()
            out.append({"code": code, "query": query, "match": match})
    return out


def title_matches(title: str, url: str, match: str) -> bool:
    hay = (title + " " + url).upper()
    code = match.upper().strip()
    # tolerant on dashes/spaces ("AL-37" ~ "AL37"/"AL 37"), but require boundaries
    # so "CX-14" does NOT match "CX-404" / "CX-140".
    core = re.escape(code).replace(r"\-", r"[-\s]?").replace(r"\ ", r"\s*")
    pattern = r"(?<![0-9A-Z])" + core + r"(?![0-9A-Z])"
    return re.search(pattern, hay) is not None


def _empty(code: str) -> dict:
    return {"model": code, "listed": False, "buyable": False,
            "title": "", "price": "", "url": "", "variant_id": ""}


def popup_alert(title: str, text: str) -> None:
    """Windows 置頂彈跳視窗，搶到最前面，讓你在做別的事也不會錯過。"""
    import sys
    if not sys.platform.startswith("win"):
        return

    def _show():
        try:
            import ctypes
            # MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND | MB_TOPMOST
            ctypes.windll.user32.MessageBoxW(0, text, title, 0x0 | 0x40 | 0x10000 | 0x40000)
        except Exception:
            pass

    threading.Thread(target=_show, daemon=True).start()


def send_push(cfg: dict, title: str, text: str, url: str = "") -> None:
    """Push a phone notification via Telegram (if configured)."""
    p = cfg.get("push", {})
    if not p.get("enabled"):
        return
    token = str(p.get("telegram_bot_token", "")).strip()
    chat = str(p.get("telegram_chat_id", "")).strip()
    if not token or not chat:
        return
    data = {"chat_id": chat, "text": f"{title}\n{text}"}
    if url:
        data["reply_markup"] = json.dumps(
            {"inline_keyboard": [[{"text": "🛒 開商品頁準備結帳", "url": url}]]})
    try:
        requests.post(f"https://api.telegram.org/bot{token}/sendMessage",
                      data=data, timeout=10)
    except Exception as e:
        _addlog(f"push error: {e}")


def query_for(code: str, own_query: str, groups: list) -> str:
    """Pick which search keyword fetches this target. If the code starts with a
    group keyword (UX-04 -> UX), use the broad group (few requests cover many
    models). Otherwise use the target's own query (free-text items)."""
    c = code.upper().replace("-", "").replace(" ", "")
    for g in groups:
        gg = g.upper().replace("-", "").replace(" ", "")
        if gg and c.startswith(gg):
            return g
    return own_query


def resolve_status(t: dict, products: list, session: requests.Session, variant_cache: dict):
    """Given already-fetched search products, decide THIS target's status.
    Matching is always exact to the target's code/keyword, so a broad 'UX'
    search never causes the wrong model to be added."""
    code = t["code"]
    # EXACT match only — never grab a random search result. This is what stops
    # unrelated items (e.g. a FUNKO titled "CX-404") ending up in the cart.
    matched = [p for p in products if title_matches(p["title"], p["url"], t["match"])]
    match_p = next((p for p in matched if not p["sold_out"]), matched[0]) if matched else None
    if not match_p:
        return _empty(code)
    vid = variant_cache.get(match_p["url"])
    if not vid and not match_p["sold_out"]:
        vid = scrape_variant_id(session, match_p["url"])
        if vid:
            variant_cache[match_p["url"]] = vid
    return {"model": code, "listed": True, "buyable": not match_p["sold_out"],
            "title": match_p["title"], "price": "", "url": match_p["url"],
            "variant_id": vid or ""}


MM_BASE = "https://mmtoyshop.com"
MM_FOUND_PATH = HERE / "mm_found.json"
MM_FOUND_LOCK = threading.Lock()


def mm_load_found() -> dict:
    try:
        d = json.loads(MM_FOUND_PATH.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def mm_save_found(name: str, url: str) -> None:
    with MM_FOUND_LOCK:
        d = mm_load_found()
        d[str(name)] = str(url)
        try:
            MM_FOUND_PATH.write_text(json.dumps(d, ensure_ascii=False, indent=1),
                                     encoding="utf-8")
        except Exception:
            pass


def normalize_mm(raw, default_spec: str = "") -> list:
    """MM 目標：純字串（型號）或 {name, spec, url}。
    有 url = 直接盯商品頁；沒 url = 先開搜尋頁讓腳本找商品在哪（順便當上架偵測）。"""
    out = []
    for t in (raw or []):
        if isinstance(t, str):
            n = t.strip()
            if n:
                out.append({"name": n, "spec": default_spec, "url": ""})
        elif isinstance(t, dict):
            n = str(t.get("name", "")).strip()
            if n:
                out.append({"name": n,
                            "spec": str(t.get("spec", default_spec)).strip(),
                            "url": str(t.get("url", "")).strip()})
    return out


def mm_arm_url(url: str, spec: str, interval: int) -> str:
    """在商品網址上帶暗號給 mm_grab.user.js。spec 含 #（例如「#不補」），
    一定要 percent-encode，否則 # 後面會被瀏覽器當成 fragment 吃掉。"""
    q = f"mmauto=1&mmint={int(interval)}"
    if spec:
        q += "&mmspec=" + quote(spec, safe="")
    return url + ("&" if "?" in url else "?") + q


def mm_open_targets(cfg: dict) -> list:
    """開所有已啟用的 MM 監看分頁。回開了哪些名字。
    有 url 的目標直接開商品頁；只有型號的先開搜尋頁（keyword=型號 + mmfind 暗號），
    由腳本在渲染後的搜尋結果裡找商品、自己跳進商品頁 —— 還沒上架就留在搜尋頁定時重找。"""
    mcfg = cfg.get("mm", {})
    interval = max(30, int(mcfg.get("poll_interval_seconds", 120)))
    search_interval = max(300, int(mcfg.get("search_interval_seconds", 600)))
    targets = normalize_mm(mcfg.get("targets", []), str(mcfg.get("default_spec", "")))
    opened = []
    # 巡邏模式（預設）：只開 1 個分頁，腳本自己依序走訪所有目標。
    # 使用者不想開 17 個分頁 —— 這是對的，一台巡邏車就夠了。
    if str(mcfg.get("mode", "patrol")) == "patrol":
        pending = [t for t in targets if not is_off("mm", t["name"])]
        if not pending:
            return []
        first = pending[0]["name"]
        try:
            webbrowser.open(f"{MM_BASE}/category?keyword=" + quote(first, safe="") +
                            "&mmpatrol=1")
            _addlog(f"MM open-patrol targets={len(pending)}")
            log_event("mm", "巡邏分頁", "已開巡邏分頁（1 個分頁輪流走訪所有目標）",
                      ok=None, detail=f"{len(pending)} 個目標", url=MM_BASE)
            return ["巡邏分頁（" + str(len(pending)) + " 個目標）"]
        except Exception:
            return []
    for t in targets:
        name = t["name"]
        if is_off("mm", name):
            continue
        try:
            if t["url"]:
                u = mm_arm_url(t["url"], t["spec"], interval)
                u += "&mmname=" + quote(name, safe="")
                action = "已開監看分頁（交給腳本盯規格）"
            else:
                u = (f"{MM_BASE}/category?keyword=" + quote(name, safe="") +
                     "&mmfind=" + quote(name, safe="") +
                     f"&mmauto=1&mmint={interval}&mmsint={search_interval}" +
                     ("&mmspec=" + quote(t["spec"], safe="") if t["spec"] else "") +
                     "&mmname=" + quote(name, safe=""))
                action = "已開搜尋分頁（交給腳本找商品頁）"
            webbrowser.open(u)
            time.sleep(1.5)
            opened.append(name)
            _addlog(f"MM open {name} url={'item' if t['url'] else 'search'}")
            log_event("mm", name[:40], action, ok=None,
                      detail=f"規格 {t['spec'] or '（目前選中的）'}",
                      url=t["url"] or f"{MM_BASE}/category?keyword={quote(name, safe='')}")
        except Exception:
            pass
    return opened


def poll_loop(cfg: dict) -> None:
    targets = normalize_targets(cfg.get("targets", []))
    interval = max(5, int(cfg.get("check_interval_seconds", 60)))
    groups = [g.strip() for g in cfg.get("search_groups", []) if g.strip()]
    session = make_session(get_cookie_header(cfg))
    variant_cache: dict[str, str] = {}
    prev_buyable: dict[str, bool] = {}

    # decide each target's fetch query (group keyword or its own), then the set
    # of UNIQUE queries we actually need to hit each cycle (few requests total)
    for t in targets:
        t["_q"] = query_for(t["code"], t["query"], groups)
    uniq_queries = sorted({t["_q"] for t in targets})
    workers = min(10, max(1, len(uniq_queries)))

    # 誠品目標
    escfg = cfg.get("eslite", {})
    eslite_targets = normalize_eslite(escfg.get("targets", [])) if escfg.get("enabled") else []
    prev_esl: dict[str, bool] = {}
    # 誠品限流(429)對策：較慢節奏＋序列查詢＋每筆間隔，避免瞬間爆量被擋
    esl_interval = max(interval, float(escfg.get("poll_interval_seconds", 60)))
    esl_gap = max(0.0, float(escfg.get("request_gap_seconds", 0.7)))

    # momo 目標（跟誠品一樣輪詢＋combo；brand_filter 只挑指定廠商）
    mcfg = cfg.get("momo", {})
    momo_targets = normalize_momo(mcfg.get("targets", [])) if mcfg.get("enabled") else []
    momo_brand = str(mcfg.get("brand_filter", "")).strip()
    prev_momo: dict[str, bool] = {}
    momo_interval = max(interval, float(mcfg.get("poll_interval_seconds", 60)))
    momo_gap = max(0.0, float(mcfg.get("request_gap_seconds", 0.7)))
    momo_armed: set = set()   # 已布署準點搶的官方預售品項（避免重複開頁）
    # 墊腳石（tcsb）：商品頁伺服器渲染，做法同 momo — 鎖定商品網址/條碼
    tcfg = cfg.get("tcsb", {})
    tcsb_targets = normalize_tcsb(tcfg.get("targets", [])) if tcfg.get("enabled") else []
    prev_tcsb: dict[str, bool] = {}
    tcsb_interval = max(interval, float(tcfg.get("poll_interval_seconds", 60)))
    tcsb_skip_books = bool(tcfg.get("skip_books", True))
    tcsb_exclude = [str(x) for x in tcfg.get("exclude", []) if str(x).strip()]

    # 東海模型（ehobby）：沒有目標商品可盯（陀螺還沒上架、站內也搜不到），
    # 改成盯「有沒有新商品上架」—— 讀 sitemap 開頭比對新 ID。
    ehcfg = cfg.get("ehobby", {})
    eh_on = bool(ehcfg.get("enabled", True)) and HAS_EHOBBY
    # targets 兩種形式（跟 MM 一致）：
    #   "UX-21"                          → 盯「新上架」（商品還不存在，掃 sitemap 比對標題）
    #   {"name":"...","url":"...detail/2627680"} 或直接貼商品網址
    #                                    → 商品已上架 → 每輪查那一頁的庫存（盯補貨）
    # 使用者拿已上架的 TOMICA 測試時發現：舊商品 ID 比基準線小，「新上架」路線永遠掃不到 —— 就是這裡修的。
    eh_keywords = []
    eh_url_watch = []          # [(pid, 卡片名)]
    for _t in (ehcfg.get("targets") or ehcfg.get("keywords") or []):
        if isinstance(_t, dict):
            _u = str(_t.get("url", ""))
            _n = str(_t.get("name", "")).strip()
            _m = re.search(r"/product/detail/(\d+)", _u)
            if _m:
                eh_url_watch.append((int(_m.group(1)), _n or f"商品 {_m.group(1)}"))
            elif _n:
                eh_keywords.append(_n)
        else:
            _st = str(_t).strip()
            _m = re.search(r"ehobbyshop\.com\.tw/product/detail/(\d+)", _st)
            if _m:
                eh_url_watch.append((int(_m.group(1)), f"商品 {_m.group(1)}"))
            elif _st:
                eh_keywords.append(_st)
    eh_interval = max(60.0, float(ehcfg.get("poll_interval_seconds", 600)))
    eh_gap = max(0.0, float(ehcfg.get("request_gap_seconds", 1.5)))
    eh_max_new = max(1, int(ehcfg.get("max_new_per_cycle", 40)))
    eh_open = bool(ehcfg.get("open_page", True))
    eh_known_max = ehobby_load_seen()
    eh_session = None
    eh_watch = list(eh_url_watch)
    for u in ehcfg.get("watch_urls", []):
        m = re.search(r"/product/detail/(\d+)", str(u))
        if m:
            eh_watch.append((int(m.group(1)), ""))
    prev_eh_watch: dict = {}
    eh_backfilled = False
    if eh_on:
        eh_session = requests.Session()
        eh_session.headers.update({"User-Agent": ehobby_core.EHOBBY_UA,
                                   "Accept-Language": "zh-TW,zh;q=0.9"})
        with STATE_LOCK:
            STATE["ehobby_meta"] = {
                "last_scan": "", "known_max": eh_known_max, "new_ids": 0, "checked": 0,
                "keywords": eh_keywords, "watch": len(eh_watch),
                "interval": int(eh_interval),
                "note": ("尚未掃描" if eh_known_max else
                         "首次啟動：第一輪只建立基準線，不會通知舊商品")}
            # 每個型號一張卡片（跟其他分頁一樣）：還沒上架也看得到自己在名單上
            for kw in eh_keywords:
                if kw not in STATE["ehobby"]:
                    STATE["ehobby"][kw] = {
                        "name": kw, "kind": "target", "listed": False,
                        "buyable": None, "price": "", "title": "",
                        "matched": [], "foundAt": "", "url": ""}
            # 盯庫存的目標（已上架商品）也一張卡，開機就存在、第一輪就會查到狀態
            for _pid, _wn in eh_watch:
                _k = _wn or ("watch:" + str(_pid))
                if _k not in STATE["ehobby"]:
                    STATE["ehobby"][_k] = {
                        "name": _wn or str(_pid), "kind": "watch", "id": _pid,
                        "listed": True, "buyable": None, "price": "", "title": "",
                        "matched": [], "foundAt": "",
                        "url": ehobby_core.ehobby_product_url(_pid)}

    # M.M小舖：config 驅動、瀏覽器執行。這裡只負責把目標種進 STATE（儀表板先有卡片）
    # 並在啟動時開監看分頁；實際盯規格庫存的是 mm_grab.user.js，它會回報 /api/mm_report。
    mmcfg = cfg.get("mm", {})
    if mmcfg.get("enabled", True) and STORE_ON.get("mm", True):
        mm_targets = normalize_mm(mmcfg.get("targets", []),
                                  str(mmcfg.get("default_spec", "")))
        with STATE_LOCK:
            for t in mm_targets:
                key = t["name"]          # 鍵用型號名稱；腳本回報會帶 cfgName 對回來
                if key not in STATE["mm"]:
                    STATE["mm"][key] = {
                        "name": t["name"], "url": t["url"],
                        "targetSpec": t["spec"], "configured": True,
                        "phase": "watching" if t["url"] else "searching",
                        "buyable": None, "stock": None, "watching": False,
                        "specText": "", "lastSeen": "", "addedAt": ""}
        if mmcfg.get("auto_open", True) and mm_targets:
            threading.Thread(target=mm_open_targets, args=(cfg,), daemon=True).start()

    last_esl = 0.0
    last_momo = 0.0
    last_tcsb = 0.0
    last_eh = 0.0
    forced = True   # 首輪立即查誠品/momo/墊腳石；之後「立刻偵測」也會強制查
    prev_added_fb: dict[str, bool] = {}   # 免 cookie 模式：已開過商品頁的型號

    with STATE_LOCK:
        for t in targets:
            STATE["targets"][t["code"]] = _empty(t["code"])
        for e in eslite_targets:
            STATE["eslite"][e["name"]] = {
                "name": e["name"], "listed": False, "buyable": False, "price": "",
                "url": f"https://www.eslite.com/search?keyword={e['query']}"}
        for m in momo_targets:
            STATE["momo"][m["name"]] = {
                "name": m["name"], "i_code": m["i_code"], "listed": False,
                "buyable": False, "price": "", "sale_time": "",
                "url": f"https://www.momoshop.com.tw/goods/GoodsDetail.jsp?i_code={m['i_code']}"}
        for c in tcsb_targets:
            STATE["tcsb"][c["name"]] = {
                "name": c["name"], "code": c["code"], "listed": False,
                "buyable": False, "price": "", "title": "",
                "url": (f"{TCSB_BASE}/{c['code']}" if c["code"]
                        else f"{TCSB_BASE}/search?query={quote(c['query'])}")}

    def fetch_q(q):
        try:
            return q, monitor.parse_products(monitor.fetch(monitor.build_search_url(q)))
        except Exception:
            return q, None

    with ThreadPoolExecutor(max_workers=workers) as pool_ex:
        while True:
            # 手動按「立刻偵測」：清掉「上一輪就有貨」的記錄，
            # 讓目前已經有貨的品項也會重新自動加入／開頁（不然只有「缺貨→有貨」那一刻才動作）
            if forced:
                prev_esl.clear()
                prev_momo.clear()
                prev_tcsb.clear()
                prev_eh_watch.clear()

            # funbox 偵測（分頁開關關閉就整段跳過）
            results = []
            if STORE_ON.get("funbox", True):
                fetched = dict(pool_ex.map(fetch_q, uniq_queries))
                for t in targets:
                    prods = fetched.get(t["_q"])
                    if prods is None:
                        results.append((t["code"], None))
                    else:
                        results.append((t["code"], resolve_status(t, prods, session, variant_cache)))
            with STATE_LOCK:
                for code, status in results:
                    if status is not None:
                        STATE["targets"][code] = status
                STATE["last_checked"] = datetime.now().strftime("%H:%M:%S")
            # 推播：首次可買才推（避免每輪洗頻）
            for code, status in results:
                if status is None:
                    continue
                b = bool(status.get("buyable") and status.get("variant_id"))
                if b and not prev_buyable.get(code, False):
                    off = is_off("funbox", code)
                    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    send_push(cfg, f"🔔 上架可買：{code}",
                              (status.get("title") or code) +
                              ("（此型號已停用自動加入）" if off else "") +
                              f"\n偵測時間 {now_str}",
                              status.get("url", ""))
                    if cfg.get("fast_cart", {}).get("popup_alert", True):
                        popup_alert(f"🔔 Funbox 上架：{code}",
                                    (status.get("title") or code) +
                                    f"\n\n偵測時間：{now_str}" +
                                    ("\n\n（此型號已停用自動加入，請手動處理）" if off else
                                     "\n\n已在自動加入購物車，購物車頁將開啟，快去結帳！"))
                prev_buyable[code] = b

            # 自動放入：讀一次購物車，裡面「沒有」該商品才放（天然滿足上限 1，
            # 你手動清空購物車後也會重新放）
            fc = cfg.get("fast_cart", {})
            added_any = False
            has_fb_cookie = bool(str(fc.get("session_cookie", "")).strip())
            if fc.get("auto_add"):
                buyables = [(c, s) for c, s in results
                            if s and s.get("buyable") and s.get("variant_id")
                            and not is_off("funbox", c)]   # 跳過被關閉自動加入的型號
                if buyables and not has_fb_cookie:
                    # 免 cookie 模式：開商品頁下暗號，交給 funbox_grab 腳本用你的登入狀態加入
                    for code, status in buyables:
                        if prev_added_fb.get(code):
                            continue
                        url = status.get("url", "")
                        if not url:
                            continue
                        prev_added_fb[code] = True
                        try:
                            webbrowser.open(url + ("&" if "?" in url else "?") + "fbauto=1")
                            time.sleep(1.5)
                        except Exception:
                            pass
                        _addlog(f"FUNBOX open-for-script {code} {url}")
                        log_event("funbox", code, "已開商品頁（交給腳本加入）",
                                  ok=True, detail="免 cookie 模式", url=url)
                elif buyables:
                    cart_html = ""
                    try:
                        cart_html = make_session(get_cookie_header(cfg)).get(
                            f"{BASE}/cart", timeout=15).text
                    except Exception:
                        cart_html = ""
                    for code, status in buyables:
                        url = status.get("url", "")
                        handle = url.rstrip("/").split("/products/")[-1] if "/products/" in url else ""
                        in_cart = bool(handle) and (handle in cart_html)
                        if in_cart:
                            with STATE_LOCK:
                                STATE["targets"][code]["autoAdded"] = True
                            continue
                        r = add_to_cart(cfg, status["variant_id"], 1)   # 數量固定 1
                        ok = bool(r.get("ok"))
                        with STATE_LOCK:
                            STATE["targets"][code]["autoAdded"] = ok
                            STATE["targets"][code]["autoMsg"] = r.get("reason", "")
                        _addlog(f"AUTO-ADD {code} handle={handle} inCart={in_cart} -> ok={ok} reason={r.get('reason')}")
                        log_event("funbox", code,
                                  "已加入購物車" if ok else "加入失敗",
                                  ok=ok, detail=str(r.get("reason", "")), url=url)
                        if ok:
                            added_any = True
                            ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                            with STATE_LOCK:
                                STATE["targets"][code]["autoAddedAt"] = ts
                            send_push(cfg, f"✅ 已自動加入購物車：{code}",
                                      f"加入時間 {ts}\n去結帳付款", f"{BASE}/cart")
                        elif r.get("reason") in ("logged_out", "no_cookie"):
                            # cookie 過期 → 退回「開商品頁交給腳本」，不會整個失效
                            if url and not prev_added_fb.get(code):
                                prev_added_fb[code] = True
                                try:
                                    webbrowser.open(url + ("&" if "?" in url else "?") + "fbauto=1")
                                    time.sleep(1.5)
                                except Exception:
                                    pass
                                _addlog(f"FUNBOX cookie 失效 → 改用腳本模式 {code}")
                                log_event("funbox", code, "cookie 失效，改開商品頁",
                                          ok=None, detail="請重新複製 cookie 或改用免 cookie 模式", url=url)
            # 有任何新放入就開一次購物車結帳頁
            if added_any and fc.get("open_checkout_after_add", True):
                try:
                    webbrowser.open(f"{BASE}/cart")
                except Exception:
                    pass
            # 誠品：序列查詢＋每筆間隔＋較慢節奏（避免 429 被限流）
            now_ts = time.time()
            do_esl = (eslite_targets and STORE_ON.get("eslite", True)
                      and (forced or now_ts - last_esl >= esl_interval))
            if do_esl:
                last_esl = now_ts
                with ThreadPoolExecutor(max_workers=3) as _ep:
                    esl_results = list(_ep.map(
                        lambda e: (e, eslite_status(e)), eslite_targets))
                for e, s in esl_results:
                    name = e["name"]
                    if s is None:
                        continue
                    with STATE_LOCK:
                        STATE["eslite"][name] = {
                            "name": name, "listed": s.get("listed", False),
                            "buyable": s.get("buyable", False),
                            "price": s.get("price", ""),
                            "url": s.get("url", f"https://www.eslite.com/search?keyword={e['query']}"),
                            "title": s.get("name", "")}
                    if s.get("buyable") and not prev_esl.get(name, False):
                        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                        off = is_off("eslite", name)
                        auto_grab = bool(escfg.get("auto_grab")) and not off
                        send_push(cfg, f"🔔 誠品上架可買：{name}",
                                  (s.get("name") or name) + ("（此項已停用自動加入）" if off else "") +
                                  f"\n偵測時間 {now_str}", s["url"])
                        if cfg.get("fast_cart", {}).get("popup_alert", True):
                            popup_alert(f"🔔 誠品上架：{name}",
                                        (s.get("name") or name) + f"\n\n偵測時間：{now_str}\n\n" +
                                        ("開商品頁自動加入中，會跳到 step2 結帳。" if auto_grab
                                         else "此項已停用自動加入，請自己點連結加入結帳。"))
                        # combo：開商品頁並帶「自動加入」暗號，交給 Tampermonkey 腳本執行
                        if auto_grab and s.get("url"):
                            try:
                                webbrowser.open(s["url"] + "?mgauto=1")
                                time.sleep(1.5)   # 多件同時上架時錯開開頁，避免互相干擾
                            except Exception:
                                pass
                        _addlog(f"ESLITE hit {name} off={off} auto_grab={auto_grab} url={s.get('url')}")
                        log_event("eslite", name,
                                  "已開商品頁（交給腳本加入）" if auto_grab else "偵測到有貨（未自動加入）",
                                  ok=True if auto_grab else None,
                                  detail=(s.get("name") or "") + (f"　NT${s.get('price')}" if s.get("price") else ""),
                                  url=s.get("url", ""))
                    prev_esl[name] = s.get("buyable")

            # momo：序列查詢＋每筆間隔＋較慢節奏（同樣避免被限流）
            now_ts = time.time()
            do_momo = (momo_targets and STORE_ON.get("momo", True)
                       and (forced or now_ts - last_momo >= momo_interval))
            if do_momo:
                last_momo = now_ts
                with ThreadPoolExecutor(max_workers=3) as _mp:
                    momo_results = list(_mp.map(
                        lambda m: (m, momo_status(m)), momo_targets))
                momo_to_open = []
                for m, s in momo_results:
                    name = m["name"]
                    if s is None:
                        continue
                    ic = s.get("i_code", "")
                    url = s.get("url") or f"https://www.momoshop.com.tw/goods/GoodsDetail.jsp?i_code={ic}"
                    sale_time = s.get("sale_time", "")
                    sale_epoch, sale_iso = parse_momo_sale(sale_time)
                    with STATE_LOCK:
                        STATE["momo"][name] = {
                            "name": name, "i_code": ic,
                            "listed": s.get("listed", False), "buyable": s.get("buyable", False),
                            "price": s.get("price", ""), "sale_time": sale_time,
                            "title": s.get("name", ""), "url": url}
                    off = is_off("momo", name)
                    auto_grab = bool(mcfg.get("auto_grab")) and not off

                    # A) 官方預售、有明確開賣時間：開賣前約 2 分鐘開頁＋帶開賣時間，
                    #    交給 momo 腳本準點搶（只布署一次）
                    if sale_epoch and auto_grab and name not in momo_armed:
                        lead = sale_epoch - time.time()
                        if 0 < lead <= 120:
                            momo_armed.add(name)
                            now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                            send_push(cfg, f"⏰ momo 即將開賣：{name}",
                                      f"{name}\n開賣 {sale_time}（正價 {s.get('price','?')}）\n已布署準點搶購", url)
                            if cfg.get("fast_cart", {}).get("popup_alert", True):
                                popup_alert(f"⏰ momo 即將開賣：{name}",
                                            f"{name}\n\n開賣時間：{sale_time}\n正價：{s.get('price','?')}\n\n已開商品頁，腳本會準點自動搶。")
                            try:
                                webbrowser.open(f"{url}&mgauto=1&mgcart=1&mgtime={sale_iso}")   # 搶到後自動開購物車
                            except Exception:
                                pass
                            _addlog(f"MOMO arm {name} i_code={ic} sale={sale_iso}")
                        log_event("momo", name, f"已布署準點搶（{sale_time} 開賣）",
                                  ok=True, detail=f"正價 {s.get('price','?')}", url=url)

                    # B) 已直接開賣（無開賣橫幅、有貨）：偵測到可買就立刻開頁搶
                    if s.get("buyable") and ic and not prev_momo.get(name, False):
                        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                        send_push(cfg, f"🔔 momo 上架可買：{name}",
                                  name + ("（此項已停用自動加入）" if off else "") +
                                  f"\n正價 {s.get('price','?')}\n偵測時間 {now_str}", url)
                        if cfg.get("fast_cart", {}).get("popup_alert", True):
                            popup_alert(f"🔔 momo 上架：{name}",
                                        name + f"\n\n正價：{s.get('price','?')}\n偵測時間：{now_str}\n\n" +
                                        ("開商品頁自動搶購中…" if auto_grab
                                         else "此項已停用自動加入，請自己去搶。"))
                        if auto_grab:
                            momo_to_open.append((name, url))
                        _addlog(f"MOMO hit {name} i_code={ic} off={off} auto_grab={auto_grab}")
                        log_event("momo", name,
                                  "已開商品頁（交給腳本加入）" if auto_grab else "偵測到有貨（未自動加入）",
                                  ok=True if auto_grab else None,
                                  detail=f"正價 {s.get('price','?')}", url=url)
                    prev_momo[name] = s.get("buyable")

                # 多本一起：逐一開商品頁加入購物車，最後一件才帶 mgcart=1 開購物車
                for idx, (nm, u) in enumerate(momo_to_open):
                    last = (idx == len(momo_to_open) - 1)
                    try:
                        webbrowser.open(f"{u}&mgauto=1" + ("&mgcart=1" if last else ""))
                        time.sleep(2.0)      # 錯開，讓每頁都有時間把商品加進去
                    except Exception:
                        pass

            # 墊腳石：鎖定商品頁輪詢；有貨→通知＋開商品頁（購物車在伺服器端，
            # 但加入購物車需要登入 cookie，這裡先做「偵測＋開頁」，加入由你在頁面按）
            now_ts = time.time()
            do_tcsb = (tcsb_targets and STORE_ON.get("tcsb", True)
                       and (forced or now_ts - last_tcsb >= tcsb_interval))
            if do_tcsb:
                last_tcsb = now_ts
                with ThreadPoolExecutor(max_workers=3) as _tp:
                    tcsb_results = list(_tp.map(
                        lambda c: (c, tcsb_status(c, tcsb_skip_books, tcsb_exclude)), tcsb_targets))
                # 先收集這一輪「新變成有貨」的品項，統一處理（多商品只開一次結帳頁）
                tcsb_hits = []
                for c, s in tcsb_results:
                    name = c["name"]
                    if s is None:
                        continue
                    with STATE_LOCK:
                        STATE["tcsb"][name] = {
                            "name": name, "code": s.get("code", ""),
                            "listed": s.get("listed", False), "buyable": s.get("buyable", False),
                            "price": s.get("price", ""), "title": s.get("name", ""),
                            "url": s.get("url", "")}
                    if s.get("buyable") and not prev_tcsb.get(name, False):
                        tcsb_hits.append((name, s))
                    prev_tcsb[name] = s.get("buyable")

                # 通知只在「缺貨→有貨」那一刻發（避免洗頻）
                if tcsb_hits:
                    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    for name, st in tcsb_hits:
                        off = is_off("tcsb", name)
                        send_push(cfg, f"🔔 墊腳石有貨：{name}",
                                  (st.get("name") or name) +
                                  ("（此項已停用自動加入）" if off else "") +
                                  f"\n售價 {st.get('price','?')}\n偵測時間 {now_str}", st.get("url", ""))

                # 免 cookie 模式：沒填 session_cookie → 開商品頁下暗號，
                # 交給 tcsb_grab 腳本用你的瀏覽器登入狀態加入購物車。
                if tcfg.get("auto_grab") and not str(tcfg.get("session_cookie", "")).strip():
                    for name, st in tcsb_hits:
                        if is_off("tcsb", name) or not st.get("url"):
                            continue
                        try:
                            webbrowser.open(st["url"] + "?mgauto=1")
                            time.sleep(1.5)
                        except Exception:
                            pass
                        _addlog(f"TCSB open-for-script {name} {st.get('url')}")
                        log_event("tcsb", name, "已開商品頁（交給腳本加入）",
                                  ok=True, detail="免 cookie 模式", url=st.get("url", ""))

                # 有 cookie 時：直接用後端加入（最快），
                # 只要「自動開著＋有貨＋不在購物車」就補加，不必等狀態變化。
                if tcfg.get("auto_grab") and tcfg.get("session_cookie"):
                    wanted = []
                    with STATE_LOCK:
                        snapshot = {k: dict(v) for k, v in STATE["tcsb"].items()}
                    for nm, info in snapshot.items():
                        if info.get("buyable") and info.get("code") and not is_off("tcsb", nm):
                            wanted.append((nm, info))
                    newly = []
                    for nm, info in wanted:                     # 序列加入，避免同時寫購物車互相蓋掉
                        res = tcsb_add_to_cart(cfg, info["code"], 1)
                        with STATE_LOCK:
                            if nm in STATE["tcsb"]:
                                STATE["tcsb"][nm]["autoAdded"] = bool(res.get("ok"))
                                STATE["tcsb"][nm]["autoMsg"] = res.get("reason", "")
                        if res.get("ok") and not res.get("skipped"):
                            newly.append(nm)
                            # autoAddedAt 原本被寫在失敗分支，導致 dashboard 的
                            # 「⚡ 已自動加入購物車」永遠沒有時間戳。移到這裡才對。
                            ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                            with STATE_LOCK:
                                if nm in STATE["tcsb"]:
                                    STATE["tcsb"][nm]["autoAddedAt"] = ts
                            _addlog(f"TCSB add-OK {nm} code={info['code']}")
                            log_event("tcsb", nm, "已加入購物車", ok=True,
                                      detail=f"NT${info.get('price','?')}", url=info.get("url", ""))
                        elif res.get("skipped"):
                            pass                      # 已在購物車，不重複記錄
                        elif not res.get("ok"):
                            # 原本這裡寫 _addlog("TCSB added ...")，失敗卻印 "added"，
                            # 8/18 追 419 時就是被這行誤導。改成明確的失敗訊息＋原因。
                            log_event("tcsb", nm, "加入失敗", ok=False,
                                      detail=str(res.get("reason", "")), url=info.get("url", ""))
                            _addlog(f"TCSB add-FAILED {nm} code={info['code']} "
                                    f"reason={res.get('reason','?')}")

                    # 有新加入的才開一次結帳頁（多商品也只開一次）
                    if newly:
                        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                        if cfg.get("fast_cart", {}).get("popup_alert", True):
                            popup_alert(f"🛒 墊腳石已加入購物車：{len(newly)} 件",
                                        "\n".join("・" + n for n in newly) +
                                        f"\n\n時間：{now_str}\n\n結帳頁將開啟，確認後自己按送出訂單。")
                        try:
                            webbrowser.open(f"{TCSB_BASE}/checkout/onepage")
                        except Exception:
                            pass

            # ---------------- 東海模型（ehobby）：新品上架偵測 ----------------
            # 跟其他四家不同：這裡沒有「目標商品」，因為陀螺類還沒上架、站內也搜不到。
            # 做法是盯 sitemap 的開頭（新品排最前面），比對出新的商品 ID。
            # 穩定狀態每輪只有 1 個請求；只有標題命中關鍵字才會多抓那一頁。
            now_ts = time.time()
            do_eh = (eh_on and STORE_ON.get("ehobby", True)
                     and (forced or now_ts - last_eh >= eh_interval))
            if do_eh:
                last_eh = now_ts
                # ---- 開機補找（只跑一次）：型號目標可能是「已上架」的商品 ----
                # 新上架掃描只看得到比基準線更新的 ID，舊商品永遠掃不到（使用者拿
                # 已上架的 TOMICA 測試時抓到的洞）。所以先用站內搜尋把每個型號找一遍，
                # 找到的轉成「盯庫存」模式；沒找到的維持「盯新上架」。
                if not eh_backfilled:
                    eh_backfilled = True
                    _found_n = 0
                    _bf_total = len(eh_keywords)
                    _bf_started = time.time()
                    _addlog(f"EHOBBY backfill start names={_bf_total}")
                    for _bi, kw in enumerate(list(eh_keywords)):
                        with STATE_LOCK:
                            STATE["ehobby_meta"]["note"] = (
                                f"開機補找中 {_bi + 1}/{_bf_total}：{kw}（已上架的會轉成盯庫存）")
                        time.sleep(eh_gap)
                        try:
                            hit, rep = ehobby_core.find_by_name(eh_session, kw, gap=eh_gap)
                        except Exception as _e:
                            hit, rep = None, []
                            _addlog(f"EHOBBY backfill error {kw}: {type(_e).__name__}: {_e}")
                        if not hit:
                            # 沒中也要留線索：每個格式的 HTTP 狀態與商品數
                            _addlog("EHOBBY backfill miss " + kw + " " + "; ".join(
                                f"{r['url'].split('tw/')[-1][:40]} http={r['http']} items={r['items']}"
                                for r in rep))
                            continue
                        _found_n += 1
                        eh_watch.append((hit["id"], kw))
                        eh_keywords.remove(kw)          # 已上架 → 不用再盯新上架
                        with STATE_LOCK:
                            STATE["ehobby"][kw] = {
                                "name": kw, "kind": "watch", "id": hit["id"],
                                "listed": True, "buyable": None, "price": "",
                                "title": hit["title"], "matched": [], "foundAt":
                                datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                                "url": hit["url"]}
                        _addlog(f"EHOBBY backfill found {kw} -> id={hit['id']} "
                                f"via={[r['url'] for r in rep if r.get('matched')]}")
                        log_event("ehobby", kw, "已在站內找到商品，改盯庫存", ok=True,
                                  detail=hit["title"][:60], url=hit["url"])
                    _addlog(f"EHOBBY backfill done found={_found_n}/{_bf_total} "
                            f"took={int(time.time() - _bf_started)}s")
                    with STATE_LOCK:
                        # 放獨立欄位：note 每輪掃描會被覆寫，補找結果要一直看得到
                        STATE["ehobby_meta"]["backfill"] = (
                            f"開機補找：{_bf_total} 個名稱找到 {_found_n} 個已上架"
                            + ("（其餘盯新上架）" if _found_n < _bf_total else "")
                            + ("" if _found_n else
                               " —— 一個都沒找到？開 /api/ehobby_find?q=名稱 看診斷"))

                bootstrap = (eh_known_max <= 0)     # 第一次跑：只建立基準線，不通知舊品
                hits, rep = ehobby_core.scan_once(
                    eh_session, eh_known_max, eh_keywords,
                    max_new=(0 if bootstrap else eh_max_new), gap=eh_gap)
                if rep.get("new_max", 0) > eh_known_max:
                    eh_known_max = rep["new_max"]
                    ehobby_save_seen(eh_known_max)
                now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                note = ""
                if rep.get("error"):
                    note = "連線失敗：" + str(rep["error"])
                    _addlog(f"EHOBBY scan error {rep['error']}")
                elif bootstrap:
                    note = f"已建立基準線（目前最新商品 ID {eh_known_max}），之後只通知比這更新的商品"
                    _addlog(f"EHOBBY bootstrap known_max={eh_known_max}")
                elif rep.get("capped"):
                    note = (f"這輪新品 {rep['new_ids']} 個，只檢查了前 {rep['checked']} 個"
                            f"（max_new_per_cycle 上限）；剩下的下一輪不會再看到，"
                            f"要調高 config/ehobby.json 的 max_new_per_cycle")
                    _addlog(f"EHOBBY capped new={rep['new_ids']} checked={rep['checked']}")
                elif rep.get("truncated"):
                    note = (f"sitemap 開頭 16KB 內全是新品 —— 可能還有沒看到的，"
                            f"下一輪會再往前追")
                else:
                    note = (f"這輪新上架 {rep['new_ids']} 個商品，命中 {len(hits)} 個"
                            if rep["new_ids"] else "這輪沒有新商品上架")
                with STATE_LOCK:
                    _bf_note = STATE["ehobby_meta"].get("backfill", "")
                    STATE["ehobby_meta"] = {
                        "backfill": _bf_note,
                        "last_scan": now_str, "known_max": eh_known_max,
                        "new_ids": rep.get("new_ids", 0), "checked": rep.get("checked", 0),
                        "keywords": eh_keywords, "watch": len(eh_watch),
                        "interval": int(eh_interval), "note": note,
                        "error": rep.get("error") or ""}

                for h in (hits if not bootstrap else []):
                    key = str(h["id"])
                    matched = h.get("matched", [])
                    with STATE_LOCK:
                        # 新上架命中 → 亮的是「那個型號自己的卡片」（跟其他分頁一致）
                        for kw in matched:
                            STATE["ehobby"][kw] = {
                                "name": kw, "kind": "target", "id": h["id"],
                                "listed": True, "buyable": h.get("buyable"),
                                "price": h.get("price", ""), "title": h["title"],
                                "matched": matched, "foundAt": now_str, "url": h["url"]}
                    buy_txt = ("有貨" if h.get("buyable") is True else
                               "缺貨/可設貨到通知" if h.get("buyable") is False else "庫存判斷不出來")
                    send_push(cfg, f"🆕 東海新上架：{h['title'][:40]}",
                              f"命中關鍵字 {'、'.join(h.get('matched', []))}\n"
                              f"{buy_txt}" + (f"　NT${h['price']}" if h.get("price") else "") +
                              f"\n偵測時間 {now_str}", h["url"])
                    if cfg.get("fast_cart", {}).get("popup_alert", True):
                        popup_alert(f"🆕 東海模型新上架：{'、'.join(h.get('matched', []))}",
                                    h["title"] + f"\n\n{buy_txt}\n偵測時間：{now_str}\n\n"
                                    "（東海沒有自動加入購物車，請自己開頁下單）")
                    if eh_open and any(not is_off("ehobby", kw) for kw in (matched or [key])):
                        try:
                            webbrowser.open(h["url"])
                            time.sleep(1.5)
                        except Exception:
                            pass
                    _addlog(f"EHOBBY hit id={h['id']} matched={h.get('matched')} "
                            f"buyable={h.get('buyable')} {h['title'][:60]}")
                    log_event("ehobby", h["title"][:40] or key,
                              "新上架" + ("・有貨" if h.get("buyable") is True else ""),
                              ok=True if h.get("buyable") is True else None,
                              detail="命中 " + "、".join(h.get("matched", [])) +
                                     (f"　NT${h['price']}" if h.get("price") else ""),
                              url=h["url"])

                # 指定商品的庫存監看（targets 給網址的 + watch_urls）
                for pid, wname in eh_watch:
                    time.sleep(eh_gap)
                    d = ehobby_core.check_watch(eh_session, pid)
                    if not d:
                        continue
                    key = wname or ("watch:" + str(pid))
                    with STATE_LOCK:
                        STATE["ehobby"][key] = {
                            "name": wname or (d.get("title") or str(pid)), "id": pid,
                            "listed": True,
                            "buyable": d.get("buyable"), "price": d.get("price", ""),
                            "title": d.get("title", ""), "matched": [], "kind": "watch",
                            "foundAt": now_str, "url": d["url"]}
                    b = d.get("buyable") is True
                    if b and not prev_eh_watch.get(pid, False):
                        send_push(cfg, f"🔔 東海補貨：{(d.get('title') or '')[:40]}",
                                  f"偵測時間 {now_str}", d["url"])
                        if cfg.get("fast_cart", {}).get("popup_alert", True):
                            popup_alert("🔔 東海模型補貨",
                                        (d.get("title") or "") +
                                        f"\n\n偵測時間：{now_str}\n\n快去下單。")
                        if eh_open and not is_off("ehobby", key):
                            try:
                                webbrowser.open(d["url"])
                            except Exception:
                                pass
                        _addlog(f"EHOBBY restock id={pid} {d.get('title','')[:60]}")
                        log_event("ehobby", (d.get("title") or str(pid))[:40], "補貨・有貨",
                                  ok=True, detail=(f"NT${d['price']}" if d.get("price") else ""),
                                  url=d["url"])
                    prev_eh_watch[pid] = b

            # background login check (once per cycle) so the banner is honest
            try:
                cookie = get_cookie_header(cfg)
                LOGIN_STATE.update(
                    val=session_logged_in(make_session(cookie)) if cookie else None,
                    ts=time.time())
            except Exception:
                pass
            # wait up to `interval`, but wake instantly if "立刻偵測" was pressed；
            # 被手動喚醒(forced=True)時，這一輪也強制查誠品/momo
            forced = REFRESH_EVENT.wait(interval)
            REFRESH_EVENT.clear()


def cart_item_count(session: requests.Session):
    """Return how many line items are in the cart, or None if it can't tell."""
    try:
        html = session.get(f"{BASE}/cart", timeout=15).text
    except requests.RequestException:
        return None
    m = re.search(r"合計有\s*(\d+)\s*項", html)
    if m:
        return int(m.group(1))
    if ("購物車是空的" in html) or ("購物車內沒有商品" in html) or ("尚未加入任何商品" in html):
        return 0
    return None


def session_logged_in(session: requests.Session):
    """Check whether the cookie actually authenticates (True/False/None)."""
    try:
        r = session.get(f"{BASE}/account/index", timeout=10, allow_redirects=False)
    except requests.RequestException:
        return None
    if r.status_code in (301, 302):
        return False  # bounced to login
    body = r.text or ""
    return ("總累計消費金額" in body) or ("近期訂單" in body) or ("會員登出" in body)


def _addlog(msg: str) -> None:
    try:
        with open(HERE / "add.log", "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}\n")
    except Exception:
        pass


def add_to_cart(cfg: dict, variant_id: str, qty: int):
    """Fast path: a single POST. Login validity is tracked in the background
    (LOGIN_STATE), so we don't pay extra round-trips on every add."""
    cookie = get_cookie_header(cfg)
    cart_url = f"{BASE}/cart"
    if not cookie:
        return {"ok": False, "reason": "no_cookie", "cart_url": cart_url}

    # If the background probe already knows the cookie is dead, fail fast.
    if LOGIN_STATE["val"] is False:
        return {"ok": False, "reason": "logged_out", "cart_url": cart_url}

    session = make_session(cookie)
    try:
        r = session.post(
            f"{BASE}/cart/add",
            data={"id": variant_id, "quantity": qty},
            headers={"X-Requested-With": "XMLHttpRequest",
                     "Content-Type": "application/x-www-form-urlencoded"},
            timeout=15, allow_redirects=False,
        )
    except requests.RequestException as e:
        _addlog(f"id={variant_id} NETWORK ERROR {e}")
        return {"ok": False, "reason": "network", "detail": str(e), "cart_url": cart_url}

    loc = r.headers.get("Location", "").lower()
    body = r.text or ""
    is_login = ("account/login" in loc) or ("繼續操作前請" in body) or ("歡迎回來" in body and "密碼" in body)
    ok = (not is_login) and r.status_code in (200, 201, 302)
    reason = "ok" if ok else ("logged_out" if is_login else f"http_{r.status_code}")
    _addlog(f"id={variant_id} status={r.status_code} loc={loc} ok={ok} (fast)")
    return {"ok": ok, "reason": reason, "status": r.status_code, "cart_url": cart_url}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json", extra=None):
        b = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def log_message(self, *a):  # quiet
        pass

    def do_GET(self):
        if self.path.startswith("/api/status"):
            with STATE_LOCK:
                payload = dict(STATE)
            payload["disabled"] = sorted(DISABLED)
            payload["config_errors"] = list(CONFIG_ERRORS)
            payload["stores"] = dict(STORE_ON)
            with EVENTS_LOCK:
                payload["events"] = EVENTS[-120:][::-1]      # 最新的排前面
            self._send(200, json.dumps(payload, ensure_ascii=False))
        elif self.path.startswith("/api/health"):
            cfg = load_config()
            cookie = get_cookie_header(cfg)
            self._send(200, json.dumps({
                "cookie_present": bool(cookie),
                "logged_in": LOGIN_STATE["val"],
                "auto_add": bool(cfg.get("fast_cart", {}).get("auto_add")),
            }))
        elif self.path.startswith("/api/tcsb_test"):
            # 診斷用：在你自己電腦上打開 http://localhost:8787/api/tcsb_test
            # 驗證墊腳石 cookie 是否有效、能不能讀到購物車、product_id 抓不抓得到。
            # 加 ?add=1 會真的把第一個「條碼型」目標放進購物車（測試用；不會結帳）。
            cfg = load_config()
            tcfg = cfg.get("tcsb", {})
            ck = str(tcfg.get("session_cookie", "")).strip()
            out = {"cookie_present": bool(ck), "cookie_len": len(ck)}
            if ck:
                names = [x.split("=")[0].strip() for x in ck.split(";") if "=" in x]
                out["has_xsrf"] = any("XSRF-TOKEN" in n for n in names)
                out["session_keys"] = [n for n in names if "session" in n.lower()]
                out["looks_like_google"] = any(
                    n in ("__Secure-3PSID", "__Secure-3PAPISID", "NID") for n in names)
            try:
                r = _tcsb_get(f"{TCSB_BASE}/api/checkout/cart/mini", ck)
                out["cart_http"] = r.status_code
                try:
                    d = (r.json() or {})
                    d = d.get("data", d)
                    items = d.get("items", []) or []
                    out["cart_items"] = [{"name": (i.get("name") or "")[:30],
                                          "qty": i.get("quantity")} for i in items]
                    out["cart_count"] = len(items)
                except Exception:
                    out["cart_body"] = r.text[:200]
            except Exception as e:
                out["cart_error"] = f"{type(e).__name__}: {str(e)[:120]}"
            # 測 product_id 解析
            tgts = normalize_tcsb(tcfg.get("targets", []))
            coded = [t for t in tgts if t.get("code")]
            if coded:
                first = coded[0]
                out["test_target"] = first["name"]
                pid = tcsb_product_id(first["code"], ck)
                out["product_id"] = pid or "(抓不到)"
                if self.path.find("add=1") >= 0 and pid:
                    out["add_result"] = tcsb_add_to_cart(cfg, first["code"], 1)
            self._send(200, json.dumps(out, ensure_ascii=False, indent=2))
        elif self.path.startswith("/api/mm_targets"):
            # 巡邏分頁的任務清單。腳本用 fetch 讀（跨源 https→http://127.0.0.1），
            # 要帶 CORS 標頭它才讀得到回應。內容只有型號與公開商品網址，無敏感資料。
            cfg = load_config()
            mcfg = cfg.get("mm", {})
            found = mm_load_found()
            tg = normalize_mm(mcfg.get("targets", []), str(mcfg.get("default_spec", "")))
            items = []
            with STATE_LOCK:
                mm_state = {k: dict(v) for k, v in STATE["mm"].items()}
            for t in tg:
                if is_off("mm", t["name"]):
                    continue
                items.append({
                    "name": t["name"], "spec": t["spec"],
                    "url": t["url"] or found.get(t["name"], ""),
                    "addedAt": mm_state.get(t["name"], {}).get("addedAt", ""),
                })
            self._send(200, json.dumps({
                "targets": items,
                "cycle_seconds": max(120, int(mcfg.get("patrol_cycle_seconds", 300))),
                "gap_seconds": max(2, int(mcfg.get("patrol_gap_seconds", 4))),
            }, ensure_ascii=False), extra={"Access-Control-Allow-Origin": "*"})
        elif self.path.startswith("/api/ehobby_find"):
            # 診斷用：http://localhost:8787/api/ehobby_find?q=TOMICA%20...
            # 用站內搜尋實找一次，回報每個候選網址格式的結果 —— 找不到時先開這個看卡在哪。
            from urllib.parse import parse_qs, urlparse as _up
            q = (parse_qs(_up(self.path).query).get("q") or [""])[0]
            if not q:
                self._send(200, json.dumps({"用法": "/api/ehobby_find?q=商品名稱或型號"},
                                           ensure_ascii=False, indent=2))
                return
            se = requests.Session()
            se.headers.update({"User-Agent": ehobby_core.EHOBBY_UA,
                               "Accept-Language": "zh-TW,zh;q=0.9"})
            hit, rep = ehobby_core.find_by_name(se, q)
            self._send(200, json.dumps({
                "查詢": q, "找到": hit, "各格式嘗試結果": rep,
                "說明": ("找到 → config 的 targets 放這個名稱就會自動盯庫存。"
                         if hit else
                         "沒找到：看上面哪個格式 items>0 但 matched=false（名稱片段對不上），"
                         "或全部 items=0（搜尋格式都不對，把你在東海網站搜尋後的網址貼給 Claude）。")},
                ensure_ascii=False, indent=2))
        elif self.path.startswith("/api/ehobby_test"):
            # 診斷用：在你自己電腦上打開 http://localhost:8787/api/ehobby_test
            # 會實際打東海 3 個請求（sitemap 開頭 + 前 2 個商品的標題），確認你的 IP 通不通。
            cfg = load_config()
            ehcfg = cfg.get("ehobby", {})
            kws = ehcfg.get("targets") or ehcfg.get("keywords") or []
            out = {"has_module": HAS_EHOBBY, "known_max_saved": ehobby_load_seen(),
                   "targets": kws,
                   "poll_interval_seconds": ehcfg.get("poll_interval_seconds", 600)}
            if not HAS_EHOBBY:
                out["error"] = "ehobby_core.py 不在或載入失敗"
                self._send(200, json.dumps(out, ensure_ascii=False, indent=2))
                return
            se = requests.Session()
            se.headers.update({"User-Agent": ehobby_core.EHOBBY_UA,
                               "Accept-Language": "zh-TW,zh;q=0.9"})
            try:
                code, text = ehobby_core._stream_head(se, ehobby_core.EHOBBY_SITEMAP, 16384)
                out["sitemap_http"] = code
                out["sitemap_bytes_read"] = len(text)
                ids = ehobby_core.parse_ids(text)
                out["sitemap_ids_in_window"] = len(ids)
                out["newest_ids"] = ids[:5]
                out["descending"] = bool(len(ids) > 1 and ids[0] > ids[-1])
                samples = []
                for pid in ids[:2]:
                    time.sleep(1.5)
                    t = ehobby_core.fetch_title(se, pid)
                    samples.append({"id": pid, "title": t,
                                    "matched": ehobby_core.match_targets(t or "", kws)})
                out["sample_titles"] = samples
                out["verdict"] = ("✅ 你的 IP 打得通，第五分頁可以正常運作"
                                  if code in (200, 206) and ids else
                                  f"⛔ 打不通（HTTP {code}）—— 換手機網路試試")
            except Exception as e:
                out["error"] = f"{type(e).__name__}: {e}"
                out["verdict"] = "⛔ 連線失敗"
            self._send(200, json.dumps(out, ensure_ascii=False, indent=2))
        elif self.path.startswith("/api/eslite_test"):
            # 診斷用：在你自己電腦上打開 http://localhost:8787/api/eslite_test
            # 會實際去誠品查每個目標，回傳原始結果，方便看「為何判成缺貨」。
            cfg = load_config()
            targets = normalize_eslite(cfg.get("eslite", {}).get("targets", []))
            out = [{"_engine": "curl_cffi(impersonate=chrome)" if HAS_CURL
                    else "requests(未裝 curl_cffi，仍可能被 429 擋)"}]
            for e in targets:
                info = {"name": e["name"], "query": e["query"], "match": e["match"]}
                try:
                    # 只打一次 holmes，top3 與 computed 都用同一份結果，避免重複請求造成假 429
                    r = eslite_search(e["query"])
                    info["http_status"] = r.status_code
                    if r.status_code != 200:
                        info["computed"] = None
                    else:
                        results = (r.json() or {}).get("results", [])
                        info["result_count"] = len(results)
                        info["top3"] = [{"name": it.get("name", ""),
                                         "button_status": it.get("button_status", ""),
                                         "matched": title_matches(it.get("name", ""), "", e["match"])}
                                        for it in results[:3]]
                        cand = next((it for it in results
                                     if title_matches(it.get("name", ""), "", e["match"])), None)
                        info["computed"] = (
                            {"listed": False, "buyable": False} if not cand else
                            {"listed": True,
                             "buyable": cand.get("button_status") == "add_to_shopping_cart",
                             "name": cand.get("name", ""), "price": cand.get("final_price", "")})
                    time.sleep(0.4)   # 診斷頁禮貌間隔，避免自己把自己打成 429
                except Exception as ex:
                    info["error"] = f"{type(ex).__name__}: {str(ex)[:200]}"
                out.append(info)
            self._send(200, json.dumps(out, ensure_ascii=False, indent=2))
        elif self.path in ("/", "/index.html", "/dashboard.html"):
            if DASHBOARD.exists():
                self._send(200, DASHBOARD.read_bytes(), "text/html; charset=utf-8")
            else:
                self._send(404, "dashboard.html not found")
        else:
            self._send(404, "not found")

    def _read_json(self) -> dict:
        n = int(self.headers.get("Content-Length", 0))
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return {}

    def do_POST(self):
        if self.path.startswith("/api/mm_report"):
            # M.M小舖（mmtoyshop）的規格庫存只有瀏覽器渲染後才看得到 —— server 抓不到，
            # 所以第六分頁反過來：由 mm_grab.user.js 主動回報，這裡只負責收下、顯示、推播。
            # 腳本用 text/plain + no-cors 送（瀏覽器眼中的「簡單請求」，不會觸發 CORS 預檢）。
            try:
                p = self._read_json()
            except Exception:
                p = {}
            key = str(p.get("cfgName") or p.get("pathname") or p.get("url") or "").strip()
            if not key:
                self._send(200, json.dumps({"ok": False, "reason": "no_key"}))
                return
            name = str(p.get("name") or key)[:120]
            buyable = p.get("buyable")
            event = str(p.get("event") or "check")
            now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            with STATE_LOCK:
                prev = dict(STATE["mm"].get(key, {}))
                STATE["mm"][key] = {
                    "name": (prev.get("name") if prev.get("configured") else name) or name,
                    "configured": prev.get("configured", False),
                    "phase": p.get("phase") or prev.get("phase", "watching"),
                    "url": p.get("url", ""), "prodId": p.get("prodId", ""),
                    "targetSpec": p.get("targetSpec", ""), "specText": p.get("specText", ""),
                    "specId": p.get("specId", ""), "stock": p.get("stock"),
                    "buyable": buyable, "watching": bool(p.get("watching")),
                    "options": p.get("options", []),
                    "lastSeen": now_str, "event": event,
                    "addedAt": p.get("addedAt") or prev.get("addedAt", ""),
                }
            cfg = load_config()
            if event == "added":
                _addlog(f"MM added {name} spec={p.get('specText')} stock={p.get('stock')}")
                log_event("mm", name[:40], "已加入購物車", ok=True,
                          detail=f"規格 {p.get('specText','')}　庫存 {p.get('stock')}",
                          url=p.get("url", ""))
                send_push(cfg, f"🛒 M.M小舖已加入購物車：{name[:40]}",
                          f"規格 {p.get('specText','')}\n庫存 {p.get('stock')}\n"
                          f"時間 {now_str}\n去結帳（預購品請先確認條款）",
                          p.get("url", ""))
                if cfg.get("fast_cart", {}).get("popup_alert", True):
                    popup_alert("🛒 M.M小舖已加入購物車",
                                f"{name}\n\n規格：{p.get('specText','')}\n"
                                f"庫存：{p.get('stock')}\n時間：{now_str}\n\n"
                                "結帳請你自己確認 —— 預購品有砍單／不可搭／不補的條款。")
                try:
                    webbrowser.open(f"{MM_BASE}/cart")
                except Exception:
                    pass
            elif event == "found":
                if p.get("url"):
                    mm_save_found(key, str(p.get("url")).split("?")[0])
                _addlog(f"MM found {key} -> {p.get('url','')}")
                log_event("mm", key[:40], "已在搜尋結果找到商品頁", ok=True,
                          detail=str(p.get("name", ""))[:60], url=p.get("url", ""))
                send_push(cfg, f"🔎 M.M小舖找到商品：{key[:40]}",
                          str(p.get("name", ""))[:80] + f"\n開始盯規格庫存",
                          p.get("url", ""))
            elif event in ("spec_missing", "give_up"):
                _addlog(f"MM {event} {name}")
                log_event("mm", name[:40],
                          "找不到指定規格" if event == "spec_missing" else "已達重載上限，停止監看",
                          ok=False, detail=str(p.get("targetSpec", "")), url=p.get("url", ""))
                send_push(cfg, f"⚠ M.M小舖監看中斷：{name[:40]}",
                          ("頁面上找不到規格「" + str(p.get("targetSpec", "")) + "」"
                           if event == "spec_missing" else "已達重載上限，已自動停止"),
                          p.get("url", ""))
            elif buyable is True and prev.get("buyable") is not True:
                _addlog(f"MM in-stock {name} spec={p.get('specText')} stock={p.get('stock')}")
                log_event("mm", key[:40], "偵測到規格有貨", ok=True,
                          detail=f"規格 {p.get('specText','')}　庫存 {p.get('stock')}",
                          url=p.get("url", ""))
                # 使用者要的：庫存 > 0 當下就通知，不用等加入購物車成功
                send_push(cfg, f"🔔 M.M小舖規格有貨：{key[:40]}",
                          f"規格 {p.get('specText','')}\n庫存 {p.get('stock')}\n"
                          f"偵測時間 {now_str}\n巡邏腳本正在自動加入購物車",
                          p.get("url", ""))
                if cfg.get("fast_cart", {}).get("popup_alert", True):
                    popup_alert(f"🔔 M.M小舖規格有貨：{key[:40]}",
                                f"{name}\n\n規格：{p.get('specText','')}\n"
                                f"庫存：{p.get('stock')}\n偵測時間：{now_str}\n\n"
                                "巡邏腳本正在自動加入購物車，加入成功會再通知並開購物車頁。")
            self._send(200, json.dumps({"ok": True}))
            return
        if self.path.startswith("/api/mm_open"):
            cfg = load_config()
            opened = mm_open_targets(cfg)
            self._send(200, json.dumps({"ok": True, "opened": opened}, ensure_ascii=False))
            return
        if self.path.startswith("/api/refresh"):
            REFRESH_EVENT.set()
            self._send(200, json.dumps({"ok": True}))
            return
        if self.path.startswith("/api/store"):
            p = self._read_json()
            store = str(p.get("store", "")).strip()
            enabled = bool(p.get("enabled", True))
            if store in STORE_ON:
                with STORE_LOCK:
                    STORE_ON[store] = enabled
                    save_stores()
            self._send(200, json.dumps({"ok": True, "stores": dict(STORE_ON)}))
            return
        if self.path.startswith("/api/toggle"):
            p = self._read_json()
            model = str(p.get("model", "")).strip()
            enabled = bool(p.get("enabled", True))
            if model:
                store = str(p.get("store", "")).strip() or "funbox"
                key = dis_key(store, model)
                with DISABLED_LOCK:
                    if enabled:
                        DISABLED.discard(key)
                    else:
                        DISABLED.add(key)
                    save_disabled()
            self._send(200, json.dumps({"ok": True, "disabled": sorted(DISABLED)}))
            return
        # add_batch must be checked before add (it shares the prefix)
        if self.path.startswith("/api/add_batch"):
            payload = self._read_json()
            items = payload.get("items", [])
            cfg = load_config()
            out = []
            for it in items:
                model = it.get("model", "")
                vid = str(it.get("variant_id", "")).strip()
                qty = int(it.get("qty", 1))
                if not vid:
                    out.append({"model": model, "ok": False, "reason": "no_variant"})
                    continue
                try:
                    r = add_to_cart(cfg, vid, qty)
                    out.append({"model": model, "ok": r.get("ok", False),
                                "reason": r.get("reason", "")})
                except Exception as e:
                    out.append({"model": model, "ok": False, "reason": f"error: {e}"})
            self._send(200, json.dumps({"results": out, "cart_url": f"{BASE}/cart"}))
            return

        if self.path.startswith("/api/add"):
            payload = self._read_json()
            vid = str(payload.get("variant_id", "")).strip()
            qty = int(payload.get("qty", 1))
            if not vid:
                self._send(400, json.dumps({"ok": False, "error": "no variant_id"}))
                return
            try:
                self._send(200, json.dumps(add_to_cart(load_config(), vid, qty)))
            except Exception as e:
                self._send(500, json.dumps({"ok": False, "error": str(e)}))
        else:
            self._send(404, "not found")


def _bind(port: int) -> tuple[ThreadingHTTPServer, int]:
    """Bind the server, trying a few ports if the preferred one is busy."""
    last = None
    for p in range(port, port + 6):
        try:
            return ThreadingHTTPServer(("127.0.0.1", p), Handler), p
        except OSError as e:
            last = e
            print(f"  port {p} busy, trying next...")
    raise last


def main() -> None:
    import sys
    print("Python:", sys.version.split()[0], "| cwd:", HERE)
    print("Checking packages...", flush=True)
    import requests as _r  # noqa
    from bs4 import BeautifulSoup as _b  # noqa
    print("  requests + beautifulsoup OK")

    print("Loading config.json...", flush=True)
    cfg = load_config()
    load_disabled()
    load_events()
    load_stores()
    port = int(cfg.get("server_port", 8787))

    print("Starting background poller...", flush=True)
    threading.Thread(target=poll_loop, args=(cfg,), daemon=True).start()

    # one-time push so you can confirm phone notifications work
    send_push(cfg, "✅ Funbox 監控已啟動", "推播設定成功，商品上架會通知你。")

    print(f"Binding server on 127.0.0.1:{port}...", flush=True)
    srv, port = _bind(port)
    dash = f"http://localhost:{port}/"
    print("=" * 44)
    print(f"  Funbox monitor running -> {dash}")
    print("  Keep this window open. Ctrl+C or close to stop.")
    print("=" * 44, flush=True)
    try:
        webbrowser.open(dash)
    except Exception:
        pass
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception:
        import traceback
        err = traceback.format_exc()
        print("\n==================== SERVER ERROR ====================")
        print(err)
        print("=====================================================")
        try:
            (HERE / "server_error.log").write_text(err, encoding="utf-8")
            print(f"(also saved to {HERE / 'server_error.log'})")
        except Exception:
            pass
        try:
            input("\nPress Enter to close this window...")
        except Exception:
            pass
