# -*- coding: utf-8 -*-
"""
東海模型（ehobbyshop.com.tw）新品偵測 —— 純抓取／解析層，不依賴 server.py 的任何全域狀態，
所以可以用離線 HTML 單獨測試（tests/test_ehobby.py）。

設計依據（都是從實際抓回來的 HTML 量出來的，不是猜的）：
  · sitemap.xml 是「新品在最前面」的遞減排序 → 只讀開頭幾 KB 就能拿到最新一批商品
  · 商品頁 <title> 結束於第 193 byte，但整頁近 1 MB → 用串流只讀前 8KB 取標題
  · schema.org 的 availability 在第 972,601 byte（尾端）→ 只有關鍵字命中才值得抓整頁
  · 列表頁的卡片 class 很語意化：pt_title / pt_forsale / pt_soldout
"""
import re
import html as _html

EHOBBY_BASE = "https://www.ehobbyshop.com.tw"
EHOBBY_SITEMAP = EHOBBY_BASE + "/sitemap.xml"
EHOBBY_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")

_ID_RE = re.compile(r'/product/detail/(\d+)')
_TITLE_RE = re.compile(r'<title>\s*(.*?)\s*</title>', re.S | re.I)
_AVAIL_RE = re.compile(r'"availability"\s*:\s*"([^"]+)"')
_PRICE_RE = re.compile(r'"price"\s*:\s*"?([\d.]+)"?')
_CARD_TITLE_RE = re.compile(r'class="pt_title[^"]*"[^>]*>\s*([^<]+?)\s*<')


def _clean(s: str) -> str:
    """把 &#039; &amp; 這類實體還原，並壓掉多餘空白"""
    return re.sub(r'\s+', ' ', _html.unescape(s or '')).strip()


def ehobby_product_url(pid) -> str:
    return f"{EHOBBY_BASE}/product/detail/{pid}"


# ---------------------------------------------------------------- 解析

def parse_ids(text: str) -> list:
    """從 sitemap 或列表頁抽出商品 ID（保持出現順序、去重）"""
    return list(dict.fromkeys(int(x) for x in _ID_RE.findall(text or '')))


def parse_title(head_html: str) -> str:
    """從商品頁前段抽 <title>。抓不到回空字串（呼叫端要當成失敗處理）"""
    m = _TITLE_RE.search(head_html or '')
    return _clean(m.group(1)) if m else ''


def parse_availability(full_html: str):
    """
    從 schema.org ld+json 取庫存狀態。
    回 True=有貨 / False=缺貨 / None=判斷不出來（不要猜）
    """
    m = _AVAIL_RE.search(full_html or '')
    if m:
        v = m.group(1).lower()
        if 'outofstock' in v or 'soldout' in v:
            return False
        if 'instock' in v or 'preorder' in v or 'backorder' in v:
            return True
    # 退路：頁面上的售完標記
    if full_html:
        if 'js_soldout_notify' in full_html or '已售完' in full_html:
            return False
    return None


def parse_price(full_html: str) -> str:
    m = _PRICE_RE.search(full_html or '')
    return m.group(1) if m else ''


def parse_list_page(html: str) -> list:
    """
    解析分類／列表頁的商品卡片。
    回 [{id, title, soldout, url}]；soldout 用卡片上的 pt_soldout 判斷。
    """
    out = []
    # 以卡片的 <a class="pt_items_block"> 當邊界切塊，每塊只取到 </a> 為止。
    # 不能用固定字元視窗：實測 href→pt_title 的距離在 2,149~6,411 之間浮動
    # （中間夾著一大段 onclick 的 gtag 追蹤碼），寫死視窗一定會漏。
    for part in re.split(r'(?=<a\s+class="pt_items_block)', html or '')[1:]:
        end = part.find('</a>')
        blk = part[:end] if end > 0 else part
        pm = re.search(r'/product/detail/(\d+)', blk)
        t = _CARD_TITLE_RE.search(blk)
        if not pm or not t:
            continue
        pid = int(pm.group(1))
        out.append({
            "id": pid,
            "title": _clean(t.group(1)),
            "soldout": 'pt_soldout' in blk,
            "url": ehobby_product_url(pid),
        })
    # 去重（同一商品可能出現兩次連結）
    seen, uniq = set(), []
    for o in out:
        if o["id"] in seen:
            continue
        seen.add(o["id"])
        uniq.append(o)
    return uniq


def match_targets(title: str, targets) -> list:
    """關鍵字比對，大小寫不敏感。回命中的關鍵字清單。"""
    t = (title or '').upper()
    return [k for k in (targets or []) if k and k.strip().upper() in t]


# ---------------------------------------------------------------- 抓取

def _stream_head(session, url, max_bytes, timeout=20, headers=None):
    """
    只讀前 max_bytes 就中斷連線 —— 商品頁近 1MB，我們只要開頭的 <title>。
    同時送 Range 標頭當提示；伺服器不支援也沒關係，stream 一樣不會下載整頁。
    """
    h = {"User-Agent": EHOBBY_UA, "Accept-Language": "zh-TW,zh;q=0.9"}
    if headers:
        h.update(headers)
    h["Range"] = f"bytes=0-{max_bytes - 1}"
    buf = bytearray()
    with session.get(url, headers=h, timeout=timeout, stream=True) as r:
        if r.status_code not in (200, 206):
            return r.status_code, ''
        for chunk in r.iter_content(4096):
            buf.extend(chunk)
            if len(buf) >= max_bytes:
                break
        return r.status_code, buf.decode('utf-8', errors='replace')


def fetch_new_ids(session, known_max: int, window_bytes: int = 16384, timeout=20):
    """
    抓 sitemap 開頭，回 (新 ID 由新到舊的清單, 這次看到的最大 ID, 是否可能被截斷)。

    sitemap 是遞減排序，所以「開頭那一批」就是最新的。
    truncated=True 代表視窗裡每一個 ID 都比 known_max 大 —— 可能還有更多沒看到，
    呼叫端應該放大視窗再抓一次，否則會漏掉新品。
    """
    code, text = _stream_head(session, EHOBBY_SITEMAP, window_bytes, timeout)
    if code not in (200, 206) or not text:
        return [], known_max, False
    ids = parse_ids(text)
    if not ids:
        return [], known_max, False
    new = [i for i in ids if i > known_max]
    truncated = bool(new) and len(new) == len(ids)      # 整個視窗都是新的 → 可能還有
    return new, max(ids), truncated


def fetch_title(session, pid, timeout=20):
    """抓商品頁前 8KB 取標題（<title> 在第 193 byte，8KB 綽綽有餘）"""
    code, head = _stream_head(session, ehobby_product_url(pid), 8192, timeout)
    if code not in (200, 206):
        return None
    return parse_title(head)


def fetch_detail(session, pid, timeout=25):
    """關鍵字命中才呼叫：抓整頁，取庫存與價格。整頁近 1MB，所以不要常用。"""
    r = session.get(ehobby_product_url(pid),
                    headers={"User-Agent": EHOBBY_UA, "Accept-Language": "zh-TW,zh;q=0.9"},
                    timeout=timeout)
    if r.status_code != 200:
        return None
    h = r.text
    return {
        "id": pid,
        "title": parse_title(h),
        "buyable": parse_availability(h),
        "price": parse_price(h),
        "url": ehobby_product_url(pid),
    }


# ---------------------------------------------------------------- 一次掃描

def scan_once(session, known_max: int, keywords, max_new: int = 40,
              gap: float = 1.0, sleeper=None, window_bytes: int = 16384,
              fetch_title_fn=None, fetch_detail_fn=None):
    """
    跑一輪新品偵測。回 (hits, report)。

      hits   = [{id,title,matched,buyable,price,url}]  只有關鍵字命中的才在裡面
      report = {"new_ids":n, "checked":n, "new_max":int, "truncated":bool,
                "capped":bool, "error":str|None}

    設計重點：
      · 穩定狀態下只有 1 個請求（sitemap 前 16KB）
      · 每個新 ID 只抓前 8KB 拿標題 —— 不命中就到此為止，不去碰那 1MB 的整頁
      · 只有關鍵字命中才抓整頁判斷庫存
      · 兩次請求之間留 gap 秒，不要打人家伺服器

    sleeper / fetch_*_fn 是給測試注入用的，正式跑不用傳。
    """
    import time as _t
    sleeper = sleeper or _t.sleep
    ft = fetch_title_fn or fetch_title
    fd = fetch_detail_fn or fetch_detail

    report = {"new_ids": 0, "checked": 0, "new_max": known_max,
              "truncated": False, "capped": False, "error": None}
    try:
        new_ids, seen_max, truncated = fetch_new_ids(session, known_max, window_bytes)
    except Exception as e:
        report["error"] = f"{type(e).__name__}: {e}"
        return [], report

    report["new_max"] = max(known_max, seen_max)
    report["truncated"] = truncated
    report["new_ids"] = len(new_ids)
    if not new_ids:
        return [], report

    todo = new_ids[:max_new] if max_new > 0 else []
    report["capped"] = len(new_ids) > max_new

    hits = []
    for idx, pid in enumerate(todo):
        if idx:
            sleeper(gap)
        try:
            title = ft(session, pid)
        except Exception:
            title = None
        report["checked"] += 1
        if not title:
            continue
        matched = match_targets(title, keywords)
        if not matched:
            continue
        # 命中才值得抓整頁（近 1MB）
        sleeper(gap)
        try:
            d = fd(session, pid) or {}
        except Exception:
            d = {}
        hits.append({
            "id": pid,
            "title": d.get("title") or title,
            "matched": matched,
            "buyable": d.get("buyable"),
            "price": d.get("price", ""),
            "url": ehobby_product_url(pid),
        })
    return hits, report


def check_watch(session, pid, fetch_detail_fn=None):
    """盯著某個已知商品頁看它有沒有補貨。回 detail dict 或 None。"""
    fd = fetch_detail_fn or fetch_detail
    try:
        return fd(session, pid)
    except Exception:
        return None


# ---------------------------------------------------------------- 用名稱找已上架商品

# 站內搜尋格式已從它的 commons.js 讀出來（2026-08-19，非猜測）：
#   location.href = locale + "/search/" + encodeURIComponent(encodeURIComponent(keyword))
# → 路徑式 /search/{關鍵字}，而且是「雙重」URL 編碼（空格變 %2520、中文變 %25E7...）。
# {qq}=雙重編碼（官方行為，排第一）；{q}=單層編碼當備援。
EHOBBY_SEARCH_PATTERNS = [
    EHOBBY_BASE + "/search/{qq}",
    EHOBBY_BASE + "/search/{q}",
    EHOBBY_BASE + "/product/all?keyword={q}",
]


def _norm_title(s: str) -> str:
    return re.sub(r'\s+', ' ', (s or '')).strip().upper()


def find_by_name(session, name, patterns=None, timeout=25, gap=1.5, sleeper=None):
    """
    用商品名稱（或夠長的片段）在站內搜尋找『已上架』的商品。
    回 (hit, report)：hit = {id,title,soldout,url} 或 None；
    report = [{url, http, items, matched}] 每個候選格式試了什麼、結果如何。
    """
    import time as _t
    from urllib.parse import quote as _q
    sleeper = sleeper or _t.sleep
    want = _norm_title(name)
    report = []
    if not want:
        return None, report
    for i, pat in enumerate(patterns or EHOBBY_SEARCH_PATTERNS):
        if i:
            sleeper(gap)
        _sq = _q(name, safe="")
        url = pat.format(q=_sq, qq=_q(_sq, safe=""))
        try:
            r = session.get(url, headers={"User-Agent": EHOBBY_UA,
                                          "Accept-Language": "zh-TW,zh;q=0.9"},
                            timeout=timeout)
            code = r.status_code
            items = parse_list_page(r.text) if code == 200 else []
        except Exception as e:
            report.append({"url": url, "http": f"error:{type(e).__name__}",
                           "items": 0, "matched": False})
            continue
        hit = None
        for it in items:
            if want in _norm_title(it["title"]):
                hit = it
                break
        report.append({"url": url, "http": code, "items": len(items),
                       "matched": bool(hit)})
        if hit:
            return hit, report
    return None, report
