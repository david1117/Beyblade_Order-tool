# -*- coding: utf-8 -*-
"""
偵察腳本 —— 只讀取、不下單、不登入、不帶任何 cookie。
目的：把東海模型與 M.M小舖 的原始 HTML 抓下來，讓解析器可以照著真實結構寫，而不是用猜的。

跑法：  python recon_shops.py
產出：  D:\\Funbox_beyblade\\recon\\*.html  以及螢幕上的摘要

總共只發 4 個請求，每個之間間隔 3 秒。
"""
import os, re, sys, time, io

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recon")
os.makedirs(OUT_DIR, exist_ok=True)

# server.py 用的就是 curl_cffi 的 impersonate，墊腳石能過就是靠它
try:
    from curl_cffi import requests as creq
    HAS_CURL = True
except Exception:
    import requests as creq
    HAS_CURL = False

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")

TARGETS = [
    # (檔名, 網址, 說明)
    ("ehobby_category_141782", "https://www.ehobbyshop.com.tw/category/141782", "東海 現貨專區 列表"),
    ("ehobby_item_soldout",    "https://www.ehobbyshop.com.tw/product/detail/2621339", "東海 缺貨商品（貨到通知）"),
    ("mmtoy_category_p1",      "https://mmtoyshop.com/category", "MM 全商品列表 第1頁"),
    ("mmtoy_item_soldout",     "https://mmtoyshop.com/item/Shopee6a4620509d97a", "MM 缺貨商品（補貨中）"),
]

# 想在 HTML 裡找的關鍵字：判斷有貨/缺貨要靠這些
MARKERS = ["貨到通知", "補貨中", "庫存", "售完", "缺貨", "預購", "現貨",
           "加入購物車", "立即購買", "sold", "stock", "out-of-stock", "disabled"]


def fetch(url):
    kw = dict(headers={"User-Agent": UA,
                       "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                       "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8"},
              timeout=25)
    if HAS_CURL:
        kw["impersonate"] = "chrome"
    return creq.get(url, **kw)


def summarize(name, desc, url, r, html):
    print(f"\n{'='*74}")
    print(f"{desc}")
    print(f"  {url}")
    print(f"{'='*74}")
    print(f"  HTTP {r.status_code}   {len(html):,} 字元")
    ct = ""
    try:
        ct = r.headers.get("content-type", "")
    except Exception:
        pass
    print(f"  content-type: {ct}")
    if r.status_code != 200:
        print("  ⛔ 非 200，後面不用看了")
        return

    # 1) 關鍵字出現次數
    hits = [(m, html.count(m)) for m in MARKERS if html.count(m) > 0]
    print("  關鍵字出現次數：", ", ".join(f"{m}×{n}" for m, n in hits) or "（都沒有）")

    # 2) 商品連結有幾個、格式
    for pat, label in [(r'/product/detail/(\d+)', '東海商品連結'),
                       (r'/item/([A-Za-z0-9]+)', 'MM 商品連結')]:
        ids = re.findall(pat, html)
        if ids:
            uniq = sorted(set(ids))
            print(f"  {label}：{len(uniq)} 個（例：{uniq[:3]}）")

    # 3) 分頁線索
    pg = sorted(set(re.findall(r'[?&](page|p|pageIndex|pageNo)=(\d+)', html)))
    if pg:
        print(f"  分頁參數線索：{pg[:6]}")
    # 4) 是不是 JS 撐起來的（前端渲染）
    print(f"  <script> 數量：{html.count('<script')}　__NUXT__/__NEXT__/vue：",
          any(k in html for k in ('__NUXT__', '__NEXT_DATA__', 'window.__INITIAL', 'Vue')))

    # 5) 把關鍵字周圍的原文切出來，讓我看得到實際標籤長相
    for m in ("貨到通知", "補貨中", "庫存"):
        i = html.find(m)
        if i >= 0:
            seg = html[max(0, i - 260): i + 160]
            seg = re.sub(r'\s+', ' ', seg)
            print(f"\n  ── 「{m}」附近的原文 ──\n  ...{seg}...")


def main():
    print(f"curl_cffi 可用：{HAS_CURL}" + ("" if HAS_CURL else "   ⚠️ 沒有 curl_cffi，東海很可能過不了 403"))
    print(f"輸出目錄：{OUT_DIR}")
    for i, (name, url, desc) in enumerate(TARGETS):
        if i:
            time.sleep(3)          # 客氣一點，不要連發
        try:
            r = fetch(url)
            html = r.text
        except Exception as e:
            print(f"\n{desc}\n  {url}\n  ❌ 連線失敗：{e}")
            continue
        path = os.path.join(OUT_DIR, name + ".html")
        with io.open(path, "w", encoding="utf-8", errors="replace") as f:
            f.write(html)
        summarize(name, desc, url, r, html)
        print(f"\n  已存檔：{path}")
    print(f"\n{'='*74}\n完成。把 recon 資料夾裡的檔案給 Claude 分析即可。")


if __name__ == "__main__":
    main()
