# -*- coding: utf-8 -*-
"""
東海模型 第二次偵察 —— 兩個目的：
  A) 釐清 403 的性質：用「普通 requests（不偽裝）」打，看你的 IP 會不會被擋
     → 200 = 之前的 403 是機房 IP 信譽問題，跟自動化無關
     → 403 = 真的在擋非瀏覽器客戶端
  B) 看 /product/all 的排序與分頁，決定新品偵測要抓哪一頁

只讀取、不登入、不下單。共 3 個請求，間隔 4 秒。
"""
import os, re, io, time, sys

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recon")
os.makedirs(OUT, exist_ok=True)

import requests as plain
try:
    from curl_cffi import requests as creq
    HAS_CURL = True
except Exception:
    creq, HAS_CURL = None, False

UA_PLAIN = "python-requests"                       # 完全不偽裝，坦白說自己是程式
UA_BROWSER = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
BASE = "https://www.ehobbyshop.com.tw"


def show(label, r):
    code = getattr(r, "status_code", "?")
    n = len(getattr(r, "text", "") or "")
    print(f"  {label:<46} HTTP {code}   {n:,} 字元")
    return code == 200


def parse_list(html, tag):
    """用 pt_title / pt_forsale / pt_soldout 解析商品卡片"""
    ids = re.findall(r'/product/detail/(\d+)', html)
    uniq = list(dict.fromkeys(ids))
    titles = re.findall(r'class="pt_title[^"]*"[^>]*>\s*([^<]+?)\s*<', html)
    sold = len(re.findall(r'class="pt_soldout', html))
    sale = len(re.findall(r'class="pt_forsale', html))
    pg = sorted(set(re.findall(r'[?&](page|p)=(\d+)', html)))
    print(f"    商品 {len(uniq)} 個｜標題解析到 {len(titles)} 個｜有貨 {sale}｜已售完 {sold}")
    print(f"    分頁參數：{pg[:6] or '（頁面上沒有）'}")
    if uniq:
        print(f"    前 5 個 ID：{uniq[:5]}")
        print(f"    ID 最大/最小：{max(int(i) for i in uniq)} / {min(int(i) for i in uniq)}")
    for t in titles[:3]:
        print(f"      · {t[:56]}")
    return uniq


def main():
    print("=" * 78)
    print("A) 釐清 403 的性質")
    print("=" * 78)
    print(f"  curl_cffi 可用：{HAS_CURL}")

    print("\n  ① 完全不偽裝（User-Agent: python-requests）")
    ok_plain = False
    try:
        r = plain.get(BASE + "/product/all", headers={"User-Agent": UA_PLAIN}, timeout=20)
        ok_plain = show("plain requests, UA=python-requests", r)
    except Exception as e:
        print(f"    連線失敗：{e}")

    time.sleep(4)
    print("\n  ② 只換一般瀏覽器 UA（仍是 requests，沒有 TLS 偽裝）")
    ok_ua = False
    html_ua = ""
    try:
        r = plain.get(BASE + "/product/all", headers={"User-Agent": UA_BROWSER}, timeout=20)
        ok_ua = show("plain requests, UA=Chrome", r)
        html_ua = r.text
    except Exception as e:
        print(f"    連線失敗：{e}")

    print("\n  ── 判讀 ──")
    if ok_plain:
        print("  ✅ 連完全不偽裝都通 → 之前的 403 是機房 IP 信譽問題，東海並沒有在擋自動化。")
    elif ok_ua:
        print("  ⚠️ 不偽裝被擋、換 UA 就通 → 只是簡單的 UA 過濾，不是嚴格的反自動化。")
    else:
        print("  ⛔ 兩種都被擋 → 它真的在擋非瀏覽器客戶端。這種情況我們再討論要不要做。")

    print("\n" + "=" * 78)
    print("B) /product/all 的結構（新品偵測要用的頁面）")
    print("=" * 78)
    html = html_ua
    if not html and HAS_CURL:
        time.sleep(4)
        print("  （前面被擋，改用 curl_cffi 取得結構資料）")
        try:
            r = creq.get(BASE + "/product/all", headers={"User-Agent": UA_BROWSER},
                         impersonate="chrome", timeout=25)
            show("curl_cffi impersonate", r)
            html = r.text
        except Exception as e:
            print(f"    連線失敗：{e}")
    if html:
        parse_list(html, "product/all")
        with io.open(os.path.join(OUT, "ehobby_product_all.html"), "w",
                     encoding="utf-8", errors="replace") as f:
            f.write(html)
        print(f"    已存檔：{os.path.join(OUT, 'ehobby_product_all.html')}")

    print("\n完成。把上面的輸出給 Claude。")


if __name__ == "__main__":
    main()
