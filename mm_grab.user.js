// ==UserScript==
// @name         M.M小舖 規格監看／自動加入購物車
// @namespace    funbox-beyblade
// @version      1.3
// @description  盯住指定「規格」的庫存（規格庫存只有渲染後才看得到），有貨就自動加入購物車並回報儀表板第六分頁
// @match        https://mmtoyshop.com/item/*
// @match        https://www.mmtoyshop.com/item/*
// @match        https://mmtoyshop.com/category*
// @match        https://www.mmtoyshop.com/category*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * 為什麼這支必須存在（不要再重新推導一次）：
 *
 *   M.M小舖是 BVSHOP 平台，Vue 前端渲染。實測數據：
 *     · 商品頁原始 HTML 242,471 字元，扣掉 CSS/JS 後真正的 DOM 只有 16,367 字元
 *     · 那 16KB 裡：<form> 0 個、product_id 欄位 0 個、規格選項 0 個、庫存標記 0 個
 *     · 分類頁 /category?keyword=... 的原始 HTML 裡 /item/ 連結 0 個
 *   → server.py 用 HTTP 抓頁面，永遠看不到規格與規格庫存。只能在瀏覽器裡做。
 *
 *   而且庫存是「目前選中的那個規格」的庫存，不是商品層級的：
 *     <div class="productInfoSpec">
 *       <input type="hidden" id="specs" value="2437747">
 *       <button value="2437747" class="getClick isChosen"> 預購-1個(不可搭其他預購) #不補 </button>
 *       <button value="2437748" class="getClick"> 預購-1個(限客訂assp0123 </button>
 *     </div>
 *     <p id="quantity" class="instock">商品庫存：<span>0</span></p>
 *   選項按鈕本身沒有售完標記 → 一定要先「選中」目標規格，#quantity 才會顯示那一格的數字。
 *
 *   ⚠️ 陷阱：「補貨中」那顆按鈕自己也帶 addtocart_btn class
 *     <button id="qty" class="soldout-hint productInfoSoldout ... cart_btn addtocart_btn">補貨中</button>
 *   所以「有沒有加入購物車鈕」不能當判斷依據，必須排除 .soldout-hint 且檢查真的可見。
 *
 *   頁面不會自己去跟伺服器要新的庫存 → 監看靠「定時重新載入」，不是靠輪詢 DOM。
 */

(function () {
  'use strict';

  var LS = 'mmGrab.' + location.pathname;          // 每個商品各自的設定
  var SS_RUN = 'mmGrab.run.' + location.pathname;  // 跨重載的監看狀態
  var SERVER = 'http://127.0.0.1:8787';

  var DEF = { on: false, spec: '', interval: 120, maxReload: 300 };
  var MIN_INTERVAL = 30;   // 低於這個沒有意義，只是多打人家伺服器

  function load(k, d) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v && typeof v === 'object' ? v : d; }
    catch (e) { return d; }
  }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function sload(k, d) {
    try { var v = JSON.parse(sessionStorage.getItem(k)); return v && typeof v === 'object' ? v : d; }
    catch (e) { return d; }
  }
  function ssave(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var cfg = load(LS, null) || JSON.parse(JSON.stringify(DEF));
  for (var k in DEF) if (!(k in cfg)) cfg[k] = DEF[k];

  // ---- config 驅動模式：server 開分頁時在網址帶暗號（同 momo 的 mgauto 套路）----
  // ⚠ momo §1-4 的教訓：參數值一定要用 ([^&]+) + decodeURIComponent，
  //   規格文字含「#不補」的 #，server 端已 percent-encode 成 %23，這裡要解回來。
  function urlParam(name) {
    var m = location.search.match(new RegExp('[?&]' + name + '=([^&]+)'));
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }
  var SS_ARMED = 'mmGrab.autoArmed.' + location.pathname;   // 這個分頁已用暗號布署過
  var CFG_NAME = urlParam('mmname') || '';                   // config 裡的型號名（回報鍵）

  function norm(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
  function now() { return new Date().toTimeString().slice(0, 8); }
  function stamp() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
           ' ' + d.toTimeString().slice(0, 8);
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // ---------------------------------------------------------------- 讀頁面

  function specButtons() {
    return Array.prototype.slice.call(
      document.querySelectorAll('.productInfoSpec button.getClick'));
  }

  function chosenButton() {
    return specButtons().filter(function (b) { return b.classList.contains('isChosen'); })[0] || null;
  }

  function findSpec(text) {
    var want = norm(text).toUpperCase();
    if (!want) return null;
    var bs = specButtons();
    // 先找完全相同，再找包含 —— 避免「預購-1個(不可搭...)」誤中「預購-1個(限客訂...)」
    for (var i = 0; i < bs.length; i++) if (norm(bs[i].textContent).toUpperCase() === want) return bs[i];
    for (var j = 0; j < bs.length; j++) if (norm(bs[j].textContent).toUpperCase().indexOf(want) >= 0) return bs[j];
    return null;
  }

  function visible(el) {
    // 不要用 offsetParent：position:fixed 的元素它一律回 null（這頁的規格抽屜就是 fixed），
    // 而且 jsdom 不做排版也永遠回 null，離線測試會全部失真。改成往上走祖先鏈看 display。
    if (!el || (el.isConnected === false)) return false;
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var st = null;
      try { st = window.getComputedStyle ? getComputedStyle(n) : null; } catch (e) {}
      if (!st) st = n.style;
      if (!st) continue;
      if (st.display === 'none' || st.visibility === 'hidden') return false;
    }
    return true;
  }

  function readStock() {
    var p = document.querySelector('#quantity span');
    if (!p) return null;                                  // 讀不到就回 null，不要猜成 0
    var m = norm(p.textContent).match(/-?\d+/);
    return m ? parseInt(m[0], 10) : null;
  }

  function addButton() {
    // 只要「加入購物車」。頁面上還有一顆 .quick_check「直接購買」會跳過購物車直接進結帳，
    // 而且它在 DOM 裡排在前面 —— 早期版本把它一起選進來，結果會按錯那顆。不要放進來。
    // 另外「補貨中」那顆自己也帶 addtocart_btn class，必須排除，而且要真的看得見。
    var all = Array.prototype.slice.call(
      document.querySelectorAll('.productInfoCartbtn .addtocart_btn'));
    return all.filter(function (b) {
      return !b.classList.contains('soldout-hint') &&
             !b.classList.contains('productInfoSoldout') &&
             !b.classList.contains('quick_check') &&
             visible(b);
    })[0] || null;
  }

  function soldoutShown() {
    var s = document.querySelector('.soldout-hint, .productInfoSoldout');
    return visible(s);
  }

  function productName() {
    var el = document.querySelector('.productInfoTitle');
    if (el) return norm(el.textContent);
    var og = document.querySelector('meta[property="og:title"]');
    return og ? norm(og.content) : document.title;
  }

  function productId() {
    var el = document.querySelector('[data-prod-id]');
    return el ? el.getAttribute('data-prod-id') : '';
  }

  /** 目前選中規格的狀態。庫存讀不到時 buyable 一律 null（不猜）。 */
  function state() {
    var ch = chosenButton();
    var stock = readStock();
    var add = addButton();
    var buyable = (stock === null) ? null : (stock > 0 && !!add && !soldoutShown());
    return {
      specText: ch ? norm(ch.textContent) : '',
      specId: ch ? ch.value : '',
      stock: stock,
      buyable: buyable,
      hasAddBtn: !!add,
      soldout: soldoutShown(),
      options: specButtons().map(function (b) { return norm(b.textContent); })
    };
  }

  // ---------------------------------------------------------------- 回報 server

  function report(extra) {
    var s = state();
    var body = {
      url: location.href, pathname: location.pathname,
      name: productName(), prodId: productId(),
      cfgName: CFG_NAME, phase: 'watching',
      targetSpec: cfg.spec, watching: !!cfg.on,
      specText: s.specText, specId: s.specId, stock: s.stock,
      buyable: s.buyable, options: s.options, at: stamp()
    };
    for (var kk in (extra || {})) body[kk] = extra[kk];
    try {
      // text/plain + no-cors = 瀏覽器眼中的「簡單請求」，不會觸發 CORS 預檢。
      // 讀不到回應沒關係，這是單向回報。
      fetch(SERVER + '/api/mm_report', {
        method: 'POST', mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(body)
      }).catch(function () {});
    } catch (e) {}
  }

  // ---------------------------------------------------------------- 面板

  var $panel, $status, $log, $specSel, $interval, $btn;

  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }

  function buildPanel() {
    $panel = el('div', [
      'position:fixed;right:14px;bottom:14px;z-index:2147483647',
      'width:330px;padding:12px 13px;border-radius:11px',
      'background:#12151b;color:#e6e9ef;border:1px solid #2a2f3a',
      'font:13px/1.6 -apple-system,"Noto Sans TC",sans-serif',
      'box-shadow:0 10px 34px rgba(0,0,0,.5)'
    ].join(';'));

    var head = el('div', 'display:flex;align-items:center;gap:8px;margin-bottom:8px');
    head.appendChild(el('b', 'font-size:14px', 'M.M 規格監看'));
    var ver = el('span', 'color:#8b93a1;font-size:11px', 'v1.0');
    head.appendChild(ver);
    var close = el('span', 'margin-left:auto;cursor:pointer;color:#8b93a1;padding:0 4px', '—');
    close.onclick = function () {
      var body = $panel.querySelector('.mmbody');
      body.style.display = body.style.display === 'none' ? '' : 'none';
    };
    head.appendChild(close);
    $panel.appendChild(head);

    var body = el('div', ''); body.className = 'mmbody';

    body.appendChild(el('div', 'color:#8b93a1;font-size:12px;margin-bottom:6px', '要盯的規格'));
    $specSel = document.createElement('select');
    $specSel.style.cssText = 'width:100%;padding:6px;border-radius:7px;background:#1a1d24;' +
                             'color:#e6e9ef;border:1px solid #2a2f3a;margin-bottom:8px';
    body.appendChild($specSel);

    var row = el('div', 'display:flex;gap:8px;align-items:center;margin-bottom:8px');
    row.appendChild(el('span', 'color:#8b93a1;font-size:12px', '每'));
    $interval = document.createElement('input');
    $interval.type = 'number'; $interval.min = String(MIN_INTERVAL); $interval.step = '10';
    $interval.value = String(cfg.interval);
    $interval.style.cssText = 'width:70px;padding:5px;border-radius:7px;background:#1a1d24;' +
                              'color:#e6e9ef;border:1px solid #2a2f3a';
    row.appendChild($interval);
    row.appendChild(el('span', 'color:#8b93a1;font-size:12px', '秒重新載入檢查一次'));
    body.appendChild(row);

    $btn = el('button', [
      'width:100%;padding:9px;border:0;border-radius:8px;cursor:pointer',
      'font-weight:700;font-size:14px'
    ].join(';'));
    $btn.onclick = toggle;
    body.appendChild($btn);

    $status = el('div', 'margin-top:9px;font-size:12px;line-height:1.7');
    body.appendChild($status);
    $log = el('div', 'margin-top:6px;font-size:11px;color:#8b93a1;white-space:pre-wrap');
    body.appendChild($log);

    $panel.appendChild(body);
    document.body.appendChild($panel);
  }

  function fillSpecs() {
    var bs = specButtons();
    $specSel.textContent = '';
    var o0 = document.createElement('option');
    o0.value = ''; o0.textContent = '（目前選中的那個）';
    $specSel.appendChild(o0);
    bs.forEach(function (b) {
      var t = norm(b.textContent);
      var o = document.createElement('option');
      o.value = t; o.textContent = t;
      $specSel.appendChild(o);
    });
    $specSel.value = cfg.spec || '';
    if ($specSel.value !== (cfg.spec || '')) {
      // 設定裡的規格在這頁找不到（商家改名或換商品）→ 明講，不要靜靜地盯錯東西
      var o = document.createElement('option');
      o.value = cfg.spec; o.textContent = '⚠ 找不到：' + cfg.spec;
      $specSel.appendChild(o); $specSel.value = cfg.spec;
    }
  }

  function paint(msg, tone) {
    var s = state();
    var run = sload(SS_RUN, null);
    $btn.textContent = cfg.on ? '⏹ 停止監看' : '▶ 開始監看';
    $btn.style.background = cfg.on ? '#7a2732' : '#1f6feb';
    $btn.style.color = '#fff';

    var lines = [];
    lines.push('目前選中：' + (s.specText || '（讀不到）'));
    lines.push('庫存：' + (s.stock === null ? '讀不到' : s.stock) +
               '　加入鈕：' + (s.hasAddBtn ? '有' : '無') +
               '　補貨中：' + (s.soldout ? '是' : '否'));
    if (run && cfg.on) lines.push('已重新載入 ' + (run.reloads || 0) + ' 次，自 ' + (run.startedAt || '?'));
    $status.textContent = lines.join('\n');
    $status.style.color = tone === 'good' ? '#4ade80' : tone === 'bad' ? '#f87171' : '#e6e9ef';
    if (msg) $log.textContent = '[' + now() + '] ' + msg;
  }

  function toggle() {
    cfg.on = !cfg.on;
    cfg.spec = $specSel.value;
    cfg.interval = Math.max(MIN_INTERVAL, parseInt($interval.value, 10) || DEF.interval);
    save(LS, cfg);
    if (cfg.on) {
      ssave(SS_RUN, { startedAt: stamp(), reloads: 0 });
      paint('開始監看：' + (cfg.spec || '目前選中的規格'), null);
      cycle();
    } else {
      sessionStorage.removeItem(SS_RUN);
      if (timer) { clearTimeout(timer); timer = null; }
      paint('已停止', null);
    }
    report({ event: cfg.on ? 'start' : 'stop' });
  }

  // ---------------------------------------------------------------- 監看主迴圈

  var timer = null;

  function selectTarget(cb) {
    if (!cfg.spec) return cb(true);
    var b = findSpec(cfg.spec);
    if (!b) return cb(false);
    if (b.classList.contains('isChosen')) return cb(true);
    b.click();
    // 等 Vue 把 #quantity 換成這一格的庫存（最多 3 秒）
    var before = readStock(), waited = 0;
    (function wait() {
      if (readStock() !== before || waited >= 3000) return cb(true);
      waited += 100; setTimeout(wait, 100);
    })();
  }

  function scheduleReload() {
    var run = sload(SS_RUN, { startedAt: stamp(), reloads: 0 });
    if ((run.reloads || 0) >= cfg.maxReload) {
      cfg.on = false; save(LS, cfg);
      sessionStorage.removeItem(SS_RUN);
      paint('已達重載上限 ' + cfg.maxReload + ' 次，自動停止（避免無限打人家伺服器）', 'bad');
      report({ event: 'give_up' });
      return;
    }
    var ms = Math.max(MIN_INTERVAL, cfg.interval) * 1000;
    paint('缺貨，' + Math.round(ms / 1000) + ' 秒後重新載入再看', null);
    timer = setTimeout(function () {
      run.reloads = (run.reloads || 0) + 1;
      ssave(SS_RUN, run);
      location.reload();
    }, ms);
  }

  function cycle() {
    if (!cfg.on) return;
    selectTarget(function (ok) {
      if (!ok) {
        cfg.on = false; save(LS, cfg);
        paint('⚠ 這頁找不到規格「' + cfg.spec + '」，已停止。請重選。', 'bad');
        report({ event: 'spec_missing' });
        return;
      }
      var s = state();
      report({ event: 'check' });

      if (s.buyable === true) {
        var btn = addButton();
        if (!btn) { scheduleReload(); return; }
        btn.click();
        cfg.on = false; save(LS, cfg);          // 加到了就停，不要重複加
        sessionStorage.removeItem(SS_RUN);
        var rec = { at: stamp(), spec: s.specText, stock: s.stock, url: location.href };
        save('mmGrab.lastAdd.' + location.pathname, rec);
        paint('✅ ' + s.specText + ' 有貨（庫存 ' + s.stock + '），已按下加入購物車。\n' +
              '結帳請你自己確認 —— 預購品有砍單／不可搭／不補的條款。', 'good');
        report({ event: 'added', addedAt: rec.at });
        try { new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=').play(); } catch (e) {}
        return;
      }
      if (s.buyable === null) {
        paint('讀不到庫存（頁面可能還沒渲染完）—— 照常排下一次重載', 'bad');
      }
      scheduleReload();
    });
  }

  // ---------------------------------------------------------------- 搜尋頁：找商品在哪（config 只放型號時的第一步）
  //
  // 搜尋頁跟商品頁一樣是 Vue 渲染 —— 原始 HTML 裡 0 個商品連結，但「渲染後」就有了。
  // 所以 server 只負責開「/category?keyword=型號&mmfind=型號」，這裡等卡片渲染出來、
  // 用型號比對商品標題，找到就跳進商品頁（把 mmauto/mmspec/mmname 一起帶過去）。
  // 還沒上架＝找不到 → 留在搜尋頁定時重找，等於每個型號自帶「上架偵測」。

  function itemAnchors() {
    return Array.prototype.slice.call(document.querySelectorAll('a[href*="/item/"]'))
      .filter(function (a) { return /\/item\/[A-Za-z0-9_-]+/.test(a.getAttribute('href') || ''); });
  }

  function anchorText(a) {
    var t = a.textContent || '';
    var imgs = a.querySelectorAll('img[alt]');
    for (var i = 0; i < imgs.length; i++) t += ' ' + imgs[i].alt;
    // 卡片的標題有時在 <a> 外面的兄弟節點 → 往上爬，但只爬到
    // 「還只包含這一個商品連結」的最高容器為止 —— 再往上就是別張卡片
    // 或整頁了，把那些文字算進來會讓第一張卡片誤中所有型號（測試抓過這個 bug）。
    var box = a, up = a.parentElement, hops = 0;
    while (up && up.tagName !== 'BODY' && hops < 4) {
      if (up.querySelectorAll('a[href*="/item/"]').length > 1) break;
      box = up; up = up.parentElement; hops++;
    }
    if (box !== a && box.textContent && box.textContent.length < 600) t += ' ' + box.textContent;
    return norm(t).toUpperCase();
  }

  function findItemLink(name) {
    var want = norm(name).toUpperCase();
    if (!want) return null;
    var as = itemAnchors();
    for (var i = 0; i < as.length; i++) {
      if (anchorText(as[i]).indexOf(want) >= 0) return as[i];
    }
    return null;
  }

  function reportFind(event, extra) {
    var body = { cfgName: CFG_NAME, phase: 'searching', event: event,
                 url: location.href, pathname: location.pathname,
                 name: CFG_NAME, targetSpec: urlParam('mmspec') || '',
                 watching: true, buyable: null, stock: null,
                 options: [], at: stamp() };
    for (var kk in (extra || {})) body[kk] = extra[kk];
    try {
      fetch(SERVER + '/api/mm_report', { method: 'POST', mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) }).catch(function(){});
    } catch (e) {}
  }

  function finderMode() {
    var name = urlParam('mmfind');
    if (!name) return false;           // 一般逛街，不干預
    var sint = Math.max(300, parseInt(urlParam('mmsint') || '600', 10) || 600);  // 搜尋重找的間隔，下限 5 分鐘
    var SS_FINDS = 'mmGrab.finds.' + name;
    var MAX_FINDS = 500;

    var box = el('div', [
      'position:fixed;right:14px;bottom:14px;z-index:2147483647;width:300px',
      'padding:11px 13px;border-radius:11px;background:#12151b;color:#e6e9ef',
      'border:1px solid #2a2f3a;font:13px/1.7 -apple-system,"Noto Sans TC",sans-serif',
      'box-shadow:0 10px 34px rgba(0,0,0,.5)'
    ].join(';'));
    box.appendChild(el('b', 'font-size:14px;display:block;margin-bottom:5px', '🔎 M.M 尋找商品頁'));
    var msg = el('div', 'font-size:12px;color:#8b93a1', '等搜尋結果渲染…');
    box.appendChild(msg);
    document.body.appendChild(box);

    var waited = 0;
    (function tick() {
      var hit = findItemLink(name);
      if (hit) {
        var href = hit.getAttribute('href');
        if (href.indexOf('http') !== 0) href = location.origin + href;
        var title = norm((hit.textContent || '').slice(0, 120)) || name;
        msg.textContent = '✅ 找到了，跳進商品頁開始監看：' + title.slice(0, 60);
        msg.style.color = '#4ade80';
        reportFind('found', { name: title, url: href });
        var q = 'mmauto=1&mmint=' + (parseInt(urlParam('mmint') || '120', 10) || 120) +
                '&mmname=' + encodeURIComponent(name);
        var sp = urlParam('mmspec');
        if (sp) q += '&mmspec=' + encodeURIComponent(sp);
        setTimeout(function () {
          location.href = href + (href.indexOf('?') >= 0 ? '&' : '?') + q;
        }, 800);
        return;
      }
      var n = itemAnchors().length;
      if (waited < 20000) {            // 給 Vue 20 秒把結果畫出來
        waited += 500;
        setTimeout(tick, 500);
        return;
      }
      // 渲染完了還是沒有 → 大概還沒上架。定時重找（別太密，這不是秒殺場）。
      var runs = 0;
      try { runs = parseInt(sessionStorage.getItem(SS_FINDS) || '0', 10) || 0; } catch (e) {}
      if (runs >= MAX_FINDS) {
        msg.textContent = '⛔ 已重找 ' + MAX_FINDS + ' 次仍沒找到，停止（避免無限打）。';
        msg.style.color = '#f87171';
        reportFind('give_up');
        return;
      }
      msg.textContent = '還沒找到「' + name + '」（結果 ' + n + ' 筆）。' +
                        Math.round(sint / 60) + ' 分鐘後重找。已找 ' + (runs + 1) + ' 次。';
      reportFind('searching', { foundCount: n });
      setTimeout(function () {
        try { sessionStorage.setItem(SS_FINDS, String(runs + 1)); } catch (e) {}
        location.reload();
      }, sint * 1000);
    })();
    return true;
  }

  // ---------------------------------------------------------------- 巡邏模式（v1.3）
  //
  // 使用者不想開 17 個分頁 —— 只開 1 個，像巡邏車依序走訪 config 的所有目標：
  //   已知商品頁的 → 去讀規格庫存（有貨就加入購物車）
  //   還沒找到的   → 去搜尋頁找（找到就回報 server 記住網址，下一輪直接走商品頁）
  // 任務清單跟 server 要（GET /api/mm_targets，server 已開 CORS 讓這裡讀得到），
  // 所以 config 改了不用動分頁；走完一輪休息到 cycle_seconds 滿再走下一輪。
  // 巡邏狀態放 sessionStorage —— 同一個分頁內換頁會保留，分頁關掉就結束（儀表板會顯示逾時）。

  var PAT = 'mmGrab.patrol';   // {idx, cycleStart, list, cycle, gap}

  function patGet() { return sload(PAT, null); }
  function patSet(v) { ssave(PAT, v); }

  function patrolUrl(t) {
    // 下一站的網址。都帶 mmpatrol=1 讓下一頁繼續巡邏。
    if (t.url) {
      var u = t.url.split('#')[0];
      return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'mmpatrol=1';
    }
    return location.origin + '/category?keyword=' + encodeURIComponent(t.name) + '&mmpatrol=1';
  }

  function patrolBox(text, tone) {
    var b = document.getElementById('mmPatrolBox');
    if (!b) {
      b = el('div', [
        'position:fixed;right:14px;bottom:14px;z-index:2147483647;width:320px',
        'padding:11px 13px;border-radius:11px;background:#12151b;color:#e6e9ef',
        'border:1px solid #2a2f3a;font:13px/1.7 -apple-system,"Noto Sans TC",sans-serif',
        'box-shadow:0 10px 34px rgba(0,0,0,.5)'
      ].join(';'));
      b.id = 'mmPatrolBox';
      b.appendChild(el('b', 'display:block;margin-bottom:5px;font-size:14px', '🚓 M.M 巡邏中（1 分頁顧全部）'));
      var m = el('div', 'font-size:12px;color:#8b93a1'); m.className = 'pmsg';
      b.appendChild(m);
      document.body.appendChild(b);
    }
    var mm = b.querySelector('.pmsg');
    mm.textContent = text;
    mm.style.color = tone === 'good' ? '#4ade80' : tone === 'bad' ? '#f87171' : '#8b93a1';
  }

  function patReport(t, extra) {
    var body = { cfgName: t ? t.name : '', name: t ? t.name : '',
                 targetSpec: t ? t.spec : '', watching: true,
                 url: location.href.split('&mmpatrol=1')[0].split('?mmpatrol=1')[0],
                 pathname: location.pathname, buyable: null, stock: null,
                 options: [], at: stamp() };
    for (var kk in (extra || {})) body[kk] = extra[kk];
    try {
      fetch(SERVER + '/api/mm_report', { method: 'POST', mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) }).catch(function(){});
    } catch (e) {}
  }

  function patrolNext(pat) {
    // 下一站；走完一輪就休息到週期滿。
    var next = pat.idx + 1;
    if (next >= pat.list.length) {
      var elapsed = (Date.now() - pat.cycleStart) / 1000;
      var rest = Math.max(pat.gap, pat.cycle - elapsed);
      patrolBox('這一輪走完（' + pat.list.length + ' 站）。休息 ' +
                Math.round(rest) + ' 秒後走下一輪。', 'good');
      setTimeout(function () {
        // 下一輪重新跟 server 拿清單（config 可能改了、可能有新 found 的網址）
        sessionStorage.removeItem(PAT);
        location.href = location.origin + '/category?keyword=' +
          encodeURIComponent(pat.list[0].name) + '&mmpatrol=1';
      }, rest * 1000);
      return;
    }
    pat.idx = next; patSet(pat);
    var t = pat.list[next];
    patrolBox('下一站（' + (next + 1) + '/' + pat.list.length + '）：' + t.name, null);
    setTimeout(function () { location.href = patrolUrl(t); }, pat.gap * 1000);
  }

  function patrolVisitItem(pat, t) {
    // 商品頁：選目標規格 → 讀庫存 → 有貨就加入購物車
    waitForSpecs(function (ok) {
      if (!ok) {
        patReport(t, { phase: 'watching', event: 'check', buyable: null });
        patrolBox(t.name + '：規格區沒渲染出來，跳過這站', 'bad');
        patrolNext(pat); return;
      }
      var b = t.spec ? findSpec(t.spec) : chosenButton();
      if (!b) {
        var bs = specButtons();
        if (bs.length === 1) { b = bs[0]; }        // 只有一個規格就用它
        else {
          patReport(t, { phase: 'watching', event: 'spec_missing' });
          patrolBox(t.name + '：找不到規格「' + t.spec + '」，跳過', 'bad');
          patrolNext(pat); return;
        }
      }
      if (!b.classList.contains('isChosen')) b.click();
      var before = readStock(), waited = 0;
      (function wait() {
        if (readStock() === before && waited < 3000) { waited += 100; setTimeout(wait, 100); return; }
        var st = state();
        patReport(t, { phase: 'watching', event: 'check', buyable: st.buyable,
                       stock: st.stock, specText: st.specText, specId: st.specId,
                       options: st.options, name: productName() || t.name });
        if (st.buyable === true) {
          var add = addButton();
          if (add) {
            add.click();
            patReport(t, { phase: 'watching', event: 'added', buyable: true,
                           stock: st.stock, specText: st.specText,
                           addedAt: stamp(), name: productName() || t.name });
            patrolBox('✅ ' + t.name + ' 有貨（' + st.stock + '），已加入購物車！繼續巡邏。', 'good');
          }
        } else {
          patrolBox(t.name + '：' + (st.stock === null ? '庫存讀不到' : '庫存 ' + st.stock) +
                    '，繼續巡邏', null);
        }
        patrolNext(pat);
      })();
    });
  }

  function patrolVisitSearch(pat, t) {
    // 搜尋頁：找商品連結；找到回報 server 記住（下一輪直接走商品頁），這輪就繼續下一站
    var waited = 0;
    (function tick() {
      var hit = findItemLink(t.name);
      if (hit) {
        var href = hit.getAttribute('href');
        if (href.indexOf('http') !== 0) href = location.origin + href;
        patReport(t, { phase: 'searching', event: 'found',
                       name: norm((hit.textContent || '').slice(0, 120)) || t.name, url: href });
        t.url = href;                       // 這一輪就直接去讀它
        patrolBox('🔎 找到 ' + t.name + '，馬上去商品頁看庫存', 'good');
        pat.list[pat.idx] = t; patSet(pat);
        setTimeout(function () { location.href = patrolUrl(t); }, pat.gap * 1000);
        return;
      }
      if (waited < 15000) { waited += 500; setTimeout(tick, 500); return; }
      patReport(t, { phase: 'searching', event: 'searching',
                     foundCount: itemAnchors().length });
      patrolBox(t.name + '：搜尋不到（可能還沒上架），下一輪再找', null);
      patrolNext(pat);
    })();
  }

  function patrolMode() {
    if (urlParam('mmpatrol') !== '1') return false;
    var pat = patGet();
    if (pat && pat.list && pat.list.length) {
      step(pat);
      return true;
    }
    patrolBox('跟 server 拿任務清單…', null);
    fetch(SERVER + '/api/mm_targets')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var list = (d.targets || []).filter(function (t) { return !t.addedAt; });
        if (!list.length) {
          patrolBox('清單是空的（都加入購物車了，或都停用了）。', 'good');
          return;
        }
        step({ idx: 0, cycleStart: Date.now(), list: list,
               cycle: d.cycle_seconds || 300, gap: d.gap_seconds || 4 });
      })
      .catch(function (e) {
        patrolBox('❌ 連不到 server（' + e + '）。start_funbox.bat 有開嗎？15 秒後重試。', 'bad');
        setTimeout(function () { location.reload(); }, 15000);
      });

    function step(pat) {
      patSet(pat);
      var t = pat.list[pat.idx];
      if (!t) { sessionStorage.removeItem(PAT); location.reload(); return; }
      var onItem = location.pathname.indexOf('/item/') === 0;
      var atTarget = onItem && t.url && location.pathname === (t.url.split('?')[0].replace(location.origin, ''));
      patrolBox('第 ' + (pat.idx + 1) + '/' + pat.list.length + ' 站：' + t.name +
                (t.spec ? '（規格 ' + t.spec + '）' : ''), null);
      if (onItem && (atTarget || !t.url)) { patrolVisitItem(pat, t); return; }
      if (!onItem && !t.url) { patrolVisitSearch(pat, t); return; }
      // 人在錯的頁 → 開去對的地方
      setTimeout(function () { location.href = patrolUrl(t); }, pat.gap * 1000);
    }
    return true;
  }

  // ---------------------------------------------------------------- 啟動

  function waitForSpecs(cb, waited) {
    waited = waited || 0;
    if (specButtons().length || document.querySelector('#quantity')) return cb(true);
    if (waited >= 15000) return cb(false);
    setTimeout(function () { waitForSpecs(cb, waited + 200); }, 200);
  }

  if (patrolMode()) return;         // 巡邏模式：1 個分頁顧全部（mmpatrol=1）

  if (location.pathname.indexOf('/category') === 0) {
    finderMode();
    return;                         // 搜尋頁不建規格面板
  }

  waitForSpecs(function (ok) {
    buildPanel();
    if (!ok) {
      $status.textContent = '⚠ 15 秒內沒等到規格區渲染出來。\n這頁可能沒有規格選項，或版型改了。';
      $status.style.color = '#f87171';
      $btn.disabled = true; $btn.style.opacity = '.5';
      return;
    }
    // config 驅動：網址帶 mmauto=1 就自動布署。
    // 只在「這個分頁第一次看到暗號」時布署（sessionStorage 記號）——
    // 監看中的自動重載會保留同一條網址，若每次都重新布署，你手動按「停止」後
    // 下一次重載又會被暗號重新啟動，永遠停不下來。
    if (urlParam('mmauto') === '1' && !sload(SS_ARMED, null)) {
      ssave(SS_ARMED, { at: stamp() });
      var usp = urlParam('mmspec');
      var uiv = parseInt(urlParam('mmint') || '', 10);
      if (usp !== null) cfg.spec = norm(usp);
      if (uiv > 0) cfg.interval = Math.max(MIN_INTERVAL, uiv);
      cfg.on = true;
      save(LS, cfg);
      if (!sload(SS_RUN, null)) ssave(SS_RUN, { startedAt: stamp(), reloads: 0 });
    }

    fillSpecs();
    if ($interval) $interval.value = String(cfg.interval);
    paint(null, null);
    report({ event: 'page_open' });
    if (cfg.on) {
      // 監看中（手動啟動、暗號布署、或自動重載回來）—— 直接接著檢查
      paint('監看中，檢查這一輪…', null);
      setTimeout(cycle, 600);
    }
  });
})();
