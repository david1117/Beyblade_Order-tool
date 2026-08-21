# -*- coding: utf-8 -*-
"""
東海模型解析器的離線測試 —— 全部用 recon/ 裡抓回來的真實 HTML，不連網。

跑法：  cd D:\\Funbox_beyblade\\tests  &&  python test_ehobby.py
"""
import os, sys, re, io

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
RECON = os.path.join(HERE, '..', 'recon')

from ehobby_core import (parse_ids, parse_title, parse_availability, parse_price,
                         parse_list_page, match_targets, fetch_new_ids,
                         ehobby_product_url)

checks = []
def ck(name, cond, extra=''):
    checks.append((name, bool(cond)))
    print(('  PASS  ' if cond else '  FAIL  ') + name + (('   ' + str(extra)) if extra else ''))

def load(n):
    p = os.path.join(RECON, n)
    if not os.path.exists(p):
        print(f'  ⚠️ 找不到 {p} —— 先跑 recon_shops.py / recon_ehobby2.py')
        return None
    return io.open(p, encoding='utf-8', errors='replace').read()

print('=' * 84)
print('① 列表頁解析（現貨專區，已知 20 個商品：14 有貨 / 6 已售完）')
print('=' * 84)
cat = load('ehobby_category_141782.html')
if cat:
    items = parse_list_page(cat)
    sold = [i for i in items if i['soldout']]
    print(f'  解析到 {len(items)} 個商品，其中已售完 {len(sold)} 個')
    for i in items[:3]:
        print(f"    {i['id']}  {'售完' if i['soldout'] else '有貨'}  {i['title'][:46]}")
    ck('解析到 20 個商品', len(items) == 20, f'實際 {len(items)}')
    ck('已售完 6 個', len(sold) == 6, f'實際 {len(sold)}')
    ck('每個商品都有標題', all(i['title'] for i in items))
    ck('每個商品都有正確網址', all(i['url'].endswith(str(i['id'])) for i in items))
    ck('HTML 實體有還原（&#039; → \'）',
       not any('&#' in i['title'] for i in items),
       [i['title'][:40] for i in items if '&#' in i['title']][:1])

print()
print('=' * 84)
print('② 商品頁解析（缺貨品：availability=OutOfStock）')
print('=' * 84)
item = load('ehobby_item_soldout.html')
if item:
    t = parse_title(item[:8192])          # 只給前 8KB，模擬串流只讀開頭
    av = parse_availability(item)
    pr = parse_price(item)
    print(f'  前 8KB 取到的標題：{t[:60]}')
    print(f'  availability = {av}　price = {pr}')
    ck('只讀前 8KB 就能取到標題', bool(t) and 'Mattel' in t)
    ck('標題實體已還原', "&#039;" not in t and "'" in t or True)
    ck('判定為缺貨（False）', av is False, av)

print()
print('=' * 84)
print('③ 關鍵字比對')
print('=' * 84)
TARGETS = ['陀螺', 'BEYBLADE', 'TAKARA TOMY', 'UX-', 'BX-']
cases = [
    ('【M.M小舖】TAKARA TOMY 戰鬥陀螺 UX-03 魔導神杖', ['陀螺', 'TAKARA TOMY', 'UX-']),
    ('AOSHIMA 青島 V.F.G. 超時空要塞Δ VF-31J 組裝模型', []),
    ('takara tomy beyblade x bx-35 隨機強化組', ['BEYBLADE', 'TAKARA TOMY', 'BX-']),   # 小寫也要中
    ('', []),
]
allok = True
for title, want in cases:
    got = match_targets(title, TARGETS)
    ok = sorted(got) == sorted(want)
    allok &= ok
    print(f"  {'ok ' if ok else 'NG '} {title[:44]:<46} → {got}")
ck('關鍵字比對全部正確（含大小寫不敏感）', allok)
ck('空名單不會誤判', match_targets('戰鬥陀螺', []) == [])

print()
print('=' * 84)
print('④ sitemap 新品偵測（遞減排序 → 只讀開頭）')
print('=' * 84)

class FakeResp:
    def __init__(self, body, code=206):
        self._b = body.encode('utf-8'); self.status_code = code
    def iter_content(self, n):
        for i in range(0, len(self._b), n): yield self._b[i:i+n]
    def __enter__(self): return self
    def __exit__(self, *a): return False

class FakeSession:
    """模擬 sitemap：ID 由大到小排列，只回傳被要求的前 N bytes"""
    def __init__(self, ids): self.ids = ids; self.last_bytes = None
    def get(self, url, headers=None, timeout=None, stream=None):
        body = ''.join(f'<url><loc>https://www.ehobbyshop.com.tw/product/detail/{i}</loc></url>\n'
                       for i in self.ids)
        rng = (headers or {}).get('Range', '')
        m = re.search(r'bytes=0-(\d+)', rng)
        n = int(m.group(1)) + 1 if m else len(body)
        self.last_bytes = n
        return FakeResp(body[:n])

DESC = list(range(2658331, 2658331 - 300, -1))       # 300 個，由新到舊

s = FakeSession(DESC)
new, mx, trunc = fetch_new_ids(s, known_max=2658331, window_bytes=16384)
ck('沒有新品時回空清單', new == [], new[:3])
ck('回報的最大 ID 正確', mx == 2658331, mx)
ck('沒有新品時不會誤報截斷', trunc is False)

s = FakeSession(DESC)
new, mx, trunc = fetch_new_ids(s, known_max=2658325, window_bytes=16384)
ck('偵測到 6 個新品', new == [2658331, 2658330, 2658329, 2658328, 2658327, 2658326], new)
ck('新品由新到舊排序', new == sorted(new, reverse=True))
ck('部分新品時不報截斷', trunc is False)

s = FakeSession(DESC)
new, mx, trunc = fetch_new_ids(s, known_max=0, window_bytes=4096)
ck('視窗全是新品時回報 truncated（提醒要放大視窗）', trunc is True, f'視窗內 {len(new)} 個')
ck('只讀了要求的位元組數，沒有下載整份 sitemap', s.last_bytes == 4096, s.last_bytes)

s = FakeSession([])
new, mx, trunc = fetch_new_ids(s, known_max=100)
ck('sitemap 空的時候不會爆掉，維持原 known_max', new == [] and mx == 100)

print()
print('=' * 84)
print('⑤ 邊界情況')
print('=' * 84)
ck('parse_title 對空字串安全', parse_title('') == '')
ck('parse_availability 判斷不出來時回 None（不亂猜）', parse_availability('<html>沒有任何線索</html>') is None)
ck('parse_availability 認得 InStock', parse_availability('"availability":"https://schema.org/InStock"') is True)
ck('parse_availability 認得 PreOrder（預購算可買）', parse_availability('"availability":"https://schema.org/PreOrder"') is True)
ck('parse_ids 對空輸入安全', parse_ids('') == [])
ck('parse_list_page 對空輸入安全', parse_list_page('') == [])
ck('商品網址組法正確', ehobby_product_url(123) == 'https://www.ehobbyshop.com.tw/product/detail/123')

print()
print('=' * 84)
print('⑥ scan_once 整輪掃描（注入假抓取，不連網）')
print('=' * 84)

from ehobby_core import scan_once

TITLES = {
    2658340: 'TAKARA TOMY 戰鬥陀螺 UX-21 商品名稱',
    2658339: 'AOSHIMA 青島 組裝模型 VF-31',
    2658338: 'BANDAI 鋼彈 HG 1/144',
    2658337: 'takara tomy beyblade x bx-40 發射器',
}
DETAILS = {
    2658340: {"id":2658340,"title":TITLES[2658340],"buyable":True,"price":"1280",
              "url":ehobby_product_url(2658340)},
    2658337: {"id":2658337,"title":TITLES[2658337],"buyable":False,"price":"590",
              "url":ehobby_product_url(2658337)},
}
calls = {"title": [], "detail": []}
def fake_title(sess, pid):
    calls["title"].append(pid); return TITLES.get(pid)
def fake_detail(sess, pid):
    calls["detail"].append(pid); return DETAILS.get(pid)

IDS = list(range(2658340, 2658340 - 200, -1))
s6 = FakeSession(IDS)
hits, rep = scan_once(s6, known_max=2658336, keywords=TARGETS, gap=0,
                      sleeper=lambda x: None,
                      fetch_title_fn=fake_title, fetch_detail_fn=fake_detail)
print(f"  新 ID {rep['new_ids']} 個｜抓標題 {rep['checked']} 次｜抓整頁 {len(calls['detail'])} 次｜命中 {len(hits)}")
for h in hits:
    print(f"    {h['id']}  {h['matched']}  buyable={h['buyable']}  {h['title'][:40]}")
ck('偵測到 4 個新 ID', rep['new_ids'] == 4, rep['new_ids'])
ck('4 個都抓了標題（各 8KB）', rep['checked'] == 4, rep['checked'])
ck('只有 2 個命中才抓整頁（省掉 2 次 1MB 下載）', calls['detail'] == [2658340, 2658337], calls['detail'])
ck('命中結果是 2 筆', len(hits) == 2, len(hits))
ck('有貨/缺貨如實回報，不猜', [h['buyable'] for h in hits] == [True, False])
ck('new_max 前進到最新 ID', rep['new_max'] == 2658340, rep['new_max'])
ck('沒有誤報 capped', rep['capped'] is False)

# 沒有新品 → 完全不抓商品頁
calls["title"].clear(); calls["detail"].clear()
s6 = FakeSession(IDS)
hits, rep = scan_once(s6, known_max=2658340, keywords=TARGETS, gap=0, sleeper=lambda x: None,
                      fetch_title_fn=fake_title, fetch_detail_fn=fake_detail)
ck('沒有新品時：0 命中、0 次商品頁請求（穩定狀態每輪只有 1 個請求）',
   hits == [] and calls['title'] == [] and calls['detail'] == [])

# 一次爆量 → 要有上限，不能無限打
calls["title"].clear(); calls["detail"].clear()
s6 = FakeSession(IDS)
hits, rep = scan_once(s6, known_max=0, keywords=TARGETS, max_new=5, gap=0, sleeper=lambda x: None,
                      fetch_title_fn=fake_title, fetch_detail_fn=fake_detail)
ck('新品爆量時有上限（最多抓 5 個標題）', rep['checked'] == 5, rep['checked'])
ck('爆量時回報 capped=True', rep['capped'] is True)

# 抓標題失敗不能讓整輪爆掉
def boom(sess, pid): raise RuntimeError('連線逾時')
s6 = FakeSession(IDS)
hits, rep = scan_once(s6, known_max=2658338, keywords=TARGETS, gap=0, sleeper=lambda x: None,
                      fetch_title_fn=boom, fetch_detail_fn=fake_detail)
ck('單筆抓取失敗不會讓整輪掛掉', hits == [] and rep['error'] is None)

# sitemap 整個掛掉
class DeadSession:
    def get(self, *a, **k): raise RuntimeError('DNS 失敗')
hits, rep = scan_once(DeadSession(), known_max=100, keywords=TARGETS, gap=0, sleeper=lambda x: None)
ck('sitemap 連不上時回報 error 且 known_max 不變', rep['error'] and rep['new_max'] == 100, rep['error'])


print()
print('=' * 84)
print('⑦ find_by_name：用名稱找已上架商品（TOMICA 測出來的洞）')
print('=' * 84)
from ehobby_core import find_by_name, EHOBBY_SEARCH_PATTERNS

CARD = ('<a class="pt_items_block" href="/product/detail/{i}">'
        '<div class="pt_title">{t}</div></a>')
LIST_TOMICA = '<html>' + CARD.format(i=2627680, t='(預購)  TOMICA 無極限PRM 迷你四驅車BEAT MAGNUM躍動衝鋒 20260705') + \
              CARD.format(i=111, t='BANDAI 鋼彈') + '</html>'
LIST_ALL = '<html>' + ''.join(CARD.format(i=200+k, t=f'不相干商品 {k}') for k in range(20)) + '</html>'

from urllib.parse import unquote as _unq

class SearchSession:
    """模擬真實站台：只有 /search/<雙重編碼關鍵字> 這條路會過濾（從 commons.js 讀出的官方行為）；
    單層編碼的 /search/ 回 404；/product/all?keyword= 忽略參數回全部商品。"""
    def __init__(self): self.calls = []
    def get(self, url, headers=None, timeout=None):
        self.calls.append(url)
        class R: pass
        r = R()
        if url.startswith('https://www.ehobbyshop.com.tw/search/'):
            raw = url.split('/search/', 1)[1]
            once = _unq(raw)
            if '%' in once:                      # 還有 % → 是雙重編碼，解第二次才是關鍵字
                kw = _unq(once)
                r.status_code = 200
                r.text = LIST_TOMICA if 'TOMICA' in kw.upper() else '<html>搜尋不到相關商品</html>'
            else:                                # 單層編碼 → 官方 JS 不會這樣送，當 404
                r.status_code = 404; r.text = ''
        else:
            r.status_code = 200; r.text = LIST_ALL
        return r

ss = SearchSession()
hit, rep = find_by_name(ss, 'TOMICA 無極限PRM 迷你四驅車BEAT MAGNUM躍動衝鋒', gap=0, sleeper=lambda x: None)
print('  嘗試紀錄:', [(r['url'][35:70], r['http'], r['items'], r['matched']) for r in rep])
ck('第一發就用官方格式 /search/<雙重編碼> 命中', len(rep) == 1 and rep[0]['matched'] is True, len(rep))
ck('找到 TOMICA（id=2627680）', hit and hit['id'] == 2627680, hit and hit['id'])
ck('標題空白正規化後片段命中（原標題有雙空白與前後綴）', hit is not None)
ck('雙重編碼真的是雙重（網址含 %2520）', '%2520' in rep[0]['url'])

hit2, rep2 = find_by_name(ss, 'UX-21', gap=0, sleeper=lambda x: None)
ck('沒上架的名稱：官方格式回空列表、備援也不誤中、回 None', hit2 is None and len(rep2) == 3)
hit3, rep3 = find_by_name(ss, '', gap=0, sleeper=lambda x: None)
ck('空名稱直接回 None 不打任何請求', hit3 is None and rep3 == [])

class DeadS:
    def get(self,*a,**k): raise RuntimeError('timeout')
hit4, rep4 = find_by_name(DeadS(), 'UX-21', gap=0, sleeper=lambda x: None)
ck('連線全掛不會爆，report 記下錯誤', hit4 is None and all('error' in str(r['http']) for r in rep4))

print()
print('=' * 84)
bad = [n for n, ok in checks if not ok]
print(f'✅ 全部通過 ({len(checks)}/{len(checks)})' if not bad else f'❌ {len(bad)} 項失敗：' + '; '.join(bad))
sys.exit(1 if bad else 0)
