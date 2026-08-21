/* 戰鬥陀螺上架監控 — 背景偵測
 *
 * 跟 Python 版的差別：
 *  - 外掛發請求會自動帶上你的登入狀態，也沒有跨網域限制 → 不用複製 cookie
 *  - MV3 的背景程式閒置會被回收，所以用 chrome.alarms 定時喚醒（最小 1 分鐘）
 *  - service worker 裡沒有 DOMParser，解析 HTML 一律用正則
 *
 * 安全界線：只做「偵測 / 開商品頁 / 加入購物車」，不碰信用卡、不送出訂單。
 */

const DEFAULTS = {
  funbox: { enabled: true, auto: true, targets: [] },
  eslite: { enabled: true, auto: true, targets: [] },
  momo:   { enabled: true, auto: true, targets: [] },   // 每筆 {name, i_code}
  tcsb:   { enabled: true, auto: true, targets: [] },
  pollMinutes: 1,
  notify: true
};

const UA_LANG = { 'Accept-Language': 'zh-TW,zh;q=0.9' };

async function getCfg() {
  const o = await chrome.storage.local.get('cfg');
  return Object.assign({}, DEFAULTS, o.cfg || {});
}
async function setCfg(cfg) { await chrome.storage.local.set({ cfg }); }

// 上一輪的狀態，用來判斷「缺貨→有貨」的那一刻
async function getPrev() { return (await chrome.storage.local.get('prev')).prev || {}; }
async function setPrev(p) { await chrome.storage.local.set({ prev: p }); }

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon128.png'),
      title, message, priority: 2
    });
  } catch (e) { console.warn('notify failed', e); }
}

/* ---------- 比對：跟 Python 版的 title_matches 同一套規則 ---------- */
function titleMatches(title, want) {
  const hay = (title + ' ').toUpperCase();
  const code = String(want).toUpperCase().trim();
  const core = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                   .replace(/\\-/g, '[-\\s]?')
                   .replace(/ /g, '\\s*');
  try { return new RegExp('(?<![0-9A-Z])' + core + '(?![0-9A-Z])').test(hay); }
  catch (e) { return hay.indexOf(code) >= 0; }
}

/* ---------- 誠品：holmes 搜尋 API ---------- */
async function checkEslite(keyword) {
  const url = 'https://holmes.eslite.com/v1/search?q=' + encodeURIComponent(keyword) +
              '&page_size=20&page_no=1&final_price=0,&visitor_id=bbmon&sort=desc&branch_id=0&facet=false';
  const r = await fetch(url, { headers: UA_LANG });
  if (!r.ok) return null;                       // 429 等 → 保留上次狀態
  const items = (await r.json()).results || [];
  const hit = items.find(it => titleMatches(it.name || '', keyword));
  if (!hit) return { listed: false, buyable: false };
  return {
    listed: true,
    buyable: hit.button_status === 'add_to_shopping_cart',
    name: hit.name, price: hit.final_price,
    url: 'https://www.eslite.com/product/' + hit.id
  };
}

/* ---------- 墊腳石：官方搜尋 API ---------- */
async function checkTcsb(keyword) {
  // 純數字＝條碼，直接鎖定商品；否則走關鍵字搜尋
  if (/^\d{8,14}$/.test(keyword)) {
    const r = await fetch('https://www.tcsb.com.tw/' + keyword, { headers: UA_LANG });
    if (!r.ok) return null;
    const h = await r.text();
    const name = (h.match(/og:title"\s+content="([^"]+)"/) || [])[1] || '';
    if (!name) return { listed: false, buyable: false };
    return {
      listed: true,
      buyable: /"availability":"[^"]*InStock"/.test(h),
      name, price: (h.match(/"price":"?([\d.]+)"?/) || [])[1] || '',
      url: 'https://www.tcsb.com.tw/' + keyword
    };
  }
  const r = await fetch('https://www.tcsb.com.tw/api/products?query=' + encodeURIComponent(keyword),
                        { headers: Object.assign({ Accept: 'application/json' }, UA_LANG) });
  if (!r.ok) return null;
  const items = (await r.json()).data || [];
  const hit = items.find(it => titleMatches(it.name || '', keyword));
  if (!hit) return { listed: false, buyable: false };
  const sku = String(hit.sku || hit.url_key || '');
  return {
    listed: true, buyable: !!hit.is_saleable,
    name: hit.name, price: String(hit.min_price || '').replace('NT$', ''),
    url: 'https://www.tcsb.com.tw/' + sku
  };
}

/* ---------- momo：鎖定 i_code，正則解析商品頁 ---------- */
async function checkMomo(iCode) {
  const url = 'https://www.momoshop.com.tw/goods/GoodsDetail.jsp?i_code=' + iCode;
  const r = await fetch(url, { headers: UA_LANG });
  if (!r.ok) return null;
  const h = await r.text();
  if (h.indexOf('EC404') >= 0 || h.length < 2000) return { listed: false, buyable: false };
  const name = ((h.match(/og:title"\s+content="([^"]+)"/) || [])[1] || '').split(' - momo')[0];
  const price = (h.match(/"price"\s*:\s*"?(\d+)"?/) || [])[1] || '';
  const saleTime = (h.match(/(\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2})\s*開賣/) || [])[1] || '';
  const stock = parseInt((h.match(/goodsStock\D{0,6}(\d+)/) || [])[1] || '1', 10);
  const soldout = /貨到通知|補貨中|已售完|完售/.test(h);
  return {
    listed: true,
    buyable: !saleTime && stock > 0 && !soldout,
    name, price, saleTime, url
  };
}

/* ---------- Funbox：搜尋頁正則解析 ---------- */
async function checkFunbox(code) {
  const url = 'https://shop.funbox.com.tw/search?q=' + encodeURIComponent(code);
  const r = await fetch(url, { headers: UA_LANG });
  if (!r.ok) return null;
  const h = await r.text();
  // 取出每個商品區塊的標題與連結，再精確比對型號
  const re = /<a[^>]+href="(\/products\/[^"]+)"[^>]*>([\s\S]{0,300}?)<\/a>/g;
  let m;
  while ((m = re.exec(h)) !== null) {
    const href = m[1], text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text && titleMatches(text, code)) {
      return { listed: true, buyable: true, name: text.slice(0, 40),
               url: 'https://shop.funbox.com.tw' + href.split('?')[0] };
    }
  }
  return { listed: false, buyable: false };
}

/* ---------- 一輪偵測 ---------- */
async function pollOnce() {
  const cfg = await getCfg();
  const prev = await getPrev();
  const results = {};

  const jobs = [];
  const push = (store, key, fn) => jobs.push(
    fn().then(v => ({ store, key, v })).catch(() => ({ store, key, v: null }))
  );

  if (cfg.eslite.enabled) cfg.eslite.targets.forEach(t => push('eslite', t, () => checkEslite(t)));
  if (cfg.tcsb.enabled)   cfg.tcsb.targets.forEach(t => push('tcsb', t, () => checkTcsb(t)));
  if (cfg.momo.enabled)   cfg.momo.targets.forEach(t => {
    const ic = typeof t === 'string' ? t : t.i_code;
    const nm = typeof t === 'string' ? t : (t.name || t.i_code);
    push('momo', nm, () => checkMomo(ic));
  });
  if (cfg.funbox.enabled) cfg.funbox.targets.forEach(t => push('funbox', t, () => checkFunbox(t)));

  const done = await Promise.all(jobs);
  const toOpen = [];

  for (const { store, key, v } of done) {
    const id = store + ':' + key;
    if (!v) { results[id] = prev[id]; continue; }   // 抓失敗 → 保留上次
    results[id] = { ...v, store, key, at: Date.now() };
    const was = prev[id] && prev[id].buyable;
    if (v.buyable && !was) {
      if (cfg.notify) {
        notify('🔔 有貨：' + key,
               (v.name || key) + (v.price ? '　NT$' + v.price : '') + '\n（' + store + '）');
      }
      if (cfg[store] && cfg[store].auto && v.url) toOpen.push({ store, url: v.url });
    }
  }

  await setPrev(results);
  await chrome.storage.local.set({ lastRun: Date.now() });

  // 有貨就開商品頁，content script 會接手加入購物車
  const SIGNAL = { funbox: 'fbauto=1', eslite: 'mgauto=1', momo: 'mgauto=1', tcsb: 'mgauto=1' };
  for (let i = 0; i < toOpen.length; i++) {
    const { store, url } = toOpen[i];
    const sep = url.indexOf('?') >= 0 ? '&' : '?';
    let full = url + sep + SIGNAL[store];
    if (store === 'momo' && i === toOpen.length - 1) full += '&mgcart=1';  // 最後一件才開購物車
    chrome.tabs.create({ url: full, active: i === 0 });
    await new Promise(res => setTimeout(res, 1500));   // 錯開，避免互相干擾
  }
}

/* ---------- 排程 ---------- */
chrome.runtime.onInstalled.addListener(async () => {
  const cfg = await getCfg();
  await setCfg(cfg);
  chrome.alarms.create('poll', { periodInMinutes: Math.max(1, cfg.pollMinutes) });
  pollOnce();
});

chrome.runtime.onStartup.addListener(() => pollOnce());

chrome.alarms.onAlarm.addListener(a => { if (a.name === 'poll') pollOnce(); });

// 點外掛圖示＝立刻偵測一次
chrome.action.onClicked.addListener(() => pollOnce());

// 設定畫面可以呼叫「立刻偵測」
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg && msg.type === 'pollNow') {
    pollOnce().then(() => sendResponse({ ok: true }));
    return true;      // 非同步回覆
  }
});
