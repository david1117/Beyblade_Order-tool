/* 由 funbox_grab.user.js 移植成 Chrome 外掛的 content script。
   v1.5：模式直接問 server（/api/fb_mode），不再靠網址暗號；自動模式=按最後的「立即結帳」（限貨到付款）。 */

(function () {
  'use strict';

  // ====== 你的偏好設定（要換就改這裡）======
  var WANT_SHIP_TAB = '超商';              // 超商 或 宅配
  var WANT_SHIP     = /^7-11\s*貨到付款/;  // 7-11 貨到付款（取貨時才付錢，結帳少掉整個付款步驟，更快）
  var WANT_PAY      = /^信用卡/;           // 信用卡 ／ Google Pay
  var WANT_INVOICE  = /^手機載具/;         // 會員載具(個人)／公司用(統編)／手機載具／自然人憑證／捐贈碼
  var WANT_STORE    = /南京西門市/;        // 常用門市（只用來確認，不會自動改門市）
  var USE_SAVED_CARD = true;               // 帳號裡有已存卡片時，自動選第一張（只是點選，不碰卡號）
  var AUTO_NEXT     = true;                // 在購物車頁自動按「立即結帳」進到配送步驟
  // =========================================

  console.log('[funboxGrab] 啟動', location.pathname);

  // ====== 自動下單模式（v1.4）======
  // 由 config/funbox.json 的 auto_checkout 控制：server 開頁時帶 ?fborder=1 暗號。
  // 鐵律：配送一定要是「貨到付款」才會自動送出（下單當下不動錢、取貨才付、
  //       不去取貨訂單自動取消，下錯單零損失）。先付款/信用卡 → 絕不自動送出。
  var COD = /貨到付款/;
  var PREPAY = /先付款|信用卡|GooglePay|ApplePay/i;
  var ORDERED_KEY = 'fbGrab.ordered';           // { "UX-21": "2026-08-25 10:00", ... }
  var SERVER = 'http://127.0.0.1:8787';

  // v1.5：模式不再靠網址暗號傳遞（太脆弱：儀表板沒重整、手動開頁都會斷鏈）。
  // 每次載入直接問 server（儀表板的開關即問即答）；問不到（程式沒開）→ 安全預設：手動。
  var AUTO_ORDER = /[?&]fborder=1\b/.test(location.search);   // 暗號仍可當初值
  var MODE_KNOWN = false;
  try {
    fetch(SERVER + '/api/fb_mode')
      .then(function (r) { return r.json(); })
      .then(function (d) { AUTO_ORDER = !!d.auto; MODE_KNOWN = true;
                           console.log('[funboxGrab] 模式（來自儀表板）=', AUTO_ORDER ? '自動立即結帳' : '手動確認'); })
      .catch(function () { MODE_KNOWN = true; });
  } catch (e) { MODE_KNOWN = true; }
  setTimeout(function () { MODE_KNOWN = true; }, 8000);   // server 沒回應就照初值走

  function orderedMap() {
    try { var v = JSON.parse(localStorage.getItem(ORDERED_KEY)); return v && typeof v === 'object' ? v : {}; }
    catch (e) { return {}; }
  }
  function extractModelCodes(text) {
    // 從訂單文字抽型號（UX-21/BX-35/BXG-57/CX-14…），\b 邊界避免 CX-140 誤中 CX-14
    var out = [], seen = {};
    var re = /\b(UX|BX|BXG|CX)\s*-\s*(\d{1,3})\b/gi, m;
    while ((m = re.exec(text || ''))) {
      var code = (m[1] + '-' + m[2]).toUpperCase();
      if (!seen[code]) { seen[code] = 1; out.push(code); }
    }
    return out;
  }
  function reportOrder(models, note, ok) {
    try {
      fetch(SERVER + '/api/order_report', { method: 'POST', mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ store: 'funbox', models: models, note: note, ok: ok }) }).catch(function(){});
    } catch (e) {}
  }
  // =================================

  /* ===== 商品頁：儀表板帶 ?fbauto=1 來 → 用你的登入狀態自動加入購物車 =====
     （這是「免 cookie 模式」：不用在 config 填 cookie，只要瀏覽器有登入 funbox）*/
  if (/^\/products\//.test(location.pathname)) {
    if (!/[?&]fbauto=1\b/.test(location.search)) return;   // 平常逛街不受影響
    console.log('[funboxGrab] 商品頁自動加入模式');
    var pTries = 0, added = false;
    var pIv = setInterval(function () {
      if (added || ++pTries > 40) { if (pTries > 40) clearInterval(pIv); return; }
      var btn = [].slice.call(document.querySelectorAll('button,a')).filter(function (b) {
        var t = (b.textContent || '').trim();
        var r = b.getBoundingClientRect();
        return t === '加入購物車' && r.width > 0 && r.height > 0;
      })[0];
      if (!btn) return;                       // 缺貨或還沒載完
      added = true;
      clearInterval(pIv);
      try { btn.click(); } catch (e) {}
      // 給它一點時間送出，再去購物車（後續配送/付款由本腳本的購物車段接手）
      var m = location.search.match(/[?&]fborder=([01])\b/);
      var carry = m ? ('?fborder=' + m[1]) : '';
      setTimeout(function () { location.href = 'https://shop.funbox.com.tw/cart' + carry; }, 1500);
    }, 300);
    return;
  }

  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden';
  }

  // 擬真點擊（funbox 是 Cyberbiz 平台，部分按鈕吃不到單純的 .click()）
  function realClick(el) {
    try {
      var r = el.getBoundingClientRect();
      var x = r.left + r.width / 2, y = r.top + r.height / 2;
      ['pointerover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (t) {
        var E = t.indexOf('pointer') === 0 ? PointerEvent : MouseEvent;
        el.dispatchEvent(new E(t, { bubbles: true, cancelable: true, view: window,
          clientX: x, clientY: y, button: 0 }));
      });
    } catch (e) { try { el.click(); } catch (e2) {} }
  }

  function findBtn(text) {
    var els = document.querySelectorAll('button,a');
    for (var i = 0; i < els.length; i++) {
      if ((els[i].textContent || '').trim() === text && visible(els[i])) return els[i];
    }
    return null;
  }

  // 選項格（配送/付款）：div.grid-button，選中的會多一個 active class
  function gridOptions() {
    return [].slice.call(document.querySelectorAll('div.grid-button')).map(function (g) {
      return { box: g, txt: (g.textContent || '').replace(/\s+/g, ''),
               active: /\bactive\b/.test(String(g.className || '')),
               btn: g.querySelector('button') || g };
    }).filter(function (o) { return o.txt && visible(o.box); });
  }

  // 發票選項：div.checkable-radio，選中的同樣是 active class（沒有真的 input）
  // 注意：超商/宅配 分頁也用同一個 class，所以這裡只留發票類的字樣。
  function invoiceOptions() {
    return [].slice.call(document.querySelectorAll('div.checkable-radio')).map(function (g) {
      return { box: g, txt: (g.textContent || '').replace(/\s+/g, ''),
               active: /\bactive\b/.test(String(g.className || '')),
               btn: g.querySelector('span,button') || g };
    }).filter(function (o) {
      return o.txt && visible(o.box) && /載具|統編|憑證|捐贈/.test(o.txt);
    });
  }

  // 已存卡片：卡號在 CYBERBIZ 的獨立 iframe 裡，腳本碰不到也不該碰；
  // 但「選擇已存的哪一張卡」是一般選項，可以幫你點。存卡後結帳頁才會出現。
  function savedCardOptions() {
    var out = [];
    var nodes = document.querySelectorAll('div.grid-button,div.checkable-radio,label,li');
    for (var i = 0; i < nodes.length; i++) {
      var t = (nodes[i].textContent || '').replace(/\s+/g, '');
      if (!t || t.length > 40 || !visible(nodes[i])) continue;
      // 已存卡片通常長這樣：**** 1234 / 末四碼1234 / VISA…1234
      if (/[*•]{2,}\s*\d{4}|末四碼\s*\d{4}|(VISA|MASTER|MasterCard|JCB)\D{0,6}\d{4}/i.test(t)) {
        var inp = nodes[i].querySelector('input[type=radio]');
        out.push({ box: nodes[i], txt: t,
                   active: (inp ? inp.checked : /\bactive\b|\bchecked\b/.test(String(nodes[i].className || ''))),
                   input: inp, btn: nodes[i].querySelector('button,span') || nodes[i] });
      }
    }
    return out;
  }

  // 超商/宅配 分頁（li）
  function shipTab(name) {
    var lis = document.querySelectorAll('li');
    for (var i = 0; i < lis.length; i++) {
      var t = (lis[i].textContent || '').trim();
      if (t === name && visible(lis[i])) return lis[i];
    }
    return null;
  }

  function banner(msg, color) {
    var bar = document.getElementById('__fb_bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = '__fb_bar';
      var s = bar.style;
      s.position = 'fixed'; s.left = '0'; s.right = '0'; s.top = '0'; s.zIndex = '2147483647';
      s.color = '#fff'; s.font = 'bold 14px system-ui,sans-serif';
      s.textAlign = 'center'; s.padding = '8px';
      document.body.appendChild(bar);
      setInterval(function () { if (!bar.isConnected && document.body) document.body.appendChild(bar); }, 1500);
    }
    bar.textContent = msg;
    bar.style.background = color;
  }

  var tries = 0, lastAct = 0, GAP = 700, nextClicked = 0, doneMsg = false;

  var iv = setInterval(function () {
    if (++tries > 150) { clearInterval(iv); return; }
    if (Date.now() - lastAct < GAP) return;
    function act(fn) { fn(); lastAct = Date.now(); }

    var grids = gridOptions();

    // A) 還在購物車步驟（沒有配送/付款選項）→ 按「立即結帳」進下一步
    if (!grids.length) {
      if (!AUTO_NEXT) return;
      var next = findBtn('立即結帳');
      if (next && nextClicked < 3) {
        nextClicked++;
        return act(function () { realClick(next); });
      }
      return;
    }

    // B) 超商/宅配 分頁
    var tab = shipTab(WANT_SHIP_TAB);
    if (tab && !/\bactive\b/.test(String(tab.className || ''))) {
      return act(function () { realClick(tab.querySelector('a') || tab); });
    }

    // C) 配送方式（7-11 / 全家）
    var ship = grids.filter(function (o) { return WANT_SHIP.test(o.txt); })[0];
    if (ship && !ship.active) return act(function () { realClick(ship.btn); });

    // D) 付款方式（信用卡 / Google Pay）
    var pay = grids.filter(function (o) { return WANT_PAY.test(o.txt); })[0];
    if (pay && !pay.active) return act(function () { realClick(pay.btn); });

    // D2) 已存卡片：有的話自動選第一張（沒有就跳過，等你存卡後自動生效）
    if (USE_SAVED_CARD) {
      var cards = savedCardOptions();
      if (cards.length && !cards.some(function (c) { return c.active; })) {
        var card = cards[0];
        return act(function () {
          if (card.input) { try { card.input.click(); } catch (e) {} }
          if (!card.input || !card.input.checked) realClick(card.btn);
        });
      }
    }

    // E) 電子發票（手機載具…）
    var invs = invoiceOptions();
    var inv = invs.filter(function (o) { return WANT_INVOICE.test(o.txt); })[0];
    if (inv && !inv.active) {
      return act(function () { realClick(inv.btn); if (!/\bactive\b/.test(String(inv.box.className||''))) realClick(inv.box); });
    }

    if (!doneMsg && !MODE_KNOWN) return;   // 模式還沒問到手 → 先不下結論

    // F-auto) 自動下單：鎖定「貨到付款」→ 同商品 1 單守衛 → 按最後的「立即結帳」
    if (AUTO_ORDER && !doneMsg) {
      var activeShip = grids.filter(function (o) { return o.active; });
      var codOn = activeShip.some(function (o) { return COD.test(o.txt); });
      var prepayOn = activeShip.some(function (o) { return PREPAY.test(o.txt) && !COD.test(o.txt); });
      if (!codOn || prepayOn) {
        if (!grids.some(function (o) { return COD.test(o.txt); })) {
          doneMsg = true;
          banner('⛔ 這頁沒有「貨到付款」選項 —— 自動下單取消，請自己選付款並送出', '#dc2626');
          reportOrder([], '沒有貨到付款選項，未送出', false);
          return;
        }
        return;   // 貨到付款選項在但還沒選中 → 等 C) 把它點起來
      }
      var codes = extractModelCodes(document.body.innerText || '');
      var done = orderedMap();
      var dup = codes.filter(function (c) { return done[c]; });
      if (dup.length) {
        doneMsg = true;
        banner('⚠️ 訂單含已自動下過的 ' + dup.join('、') + '（同商品只自動下 1 單）— 請自己確認後送出', '#f59e0b');
        reportOrder(codes, '含已下過的 ' + dup.join('、') + '，未自動送出', false);
        return;
      }
      var submitted = false;
      try { submitted = sessionStorage.getItem('fbGrab.submitted') === '1'; } catch (e) {}
      if (submitted) { doneMsg = true; return; }        // 同分頁防重複下單
      // 實證（2026-08-25 使用者截圖）：funbox 結帳頁最後那顆紅色大鈕的文字就是「立即結帳」
      // —— 跟購物車步驟的按鈕同名，但這裡 grids 已存在（配送/付款都渲染了），
      // 所以走到這行時頁面一定是結帳頁，這顆就是送出訂單。
      var go = findBtn('立即結帳') || findBtn('送出訂單') || findBtn('提交訂單') || findBtn('確認結帳');
      if (!go) {
        doneMsg = true;
        banner('⛔ 找不到「立即結帳/送出訂單」按鈕 —— 未自動送出，請自己按（並告訴 Claude 按鈕的實際文字）', '#dc2626');
        reportOrder(codes, '找不到送出按鈕，未送出', false);
        return;
      }
      doneMsg = true;
      try { sessionStorage.setItem('fbGrab.submitted', '1'); } catch (e) {}
      var now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      codes.forEach(function (c) { done[c] = now; });
      try { localStorage.setItem(ORDERED_KEY, JSON.stringify(done)); } catch (e) {}
      banner('🚀 自動送出訂單（7-11 貨到付款）：' + (codes.join('、') || '訂單') + ' — 到貨後記得去取！', '#16a34a');
      reportOrder(codes, '7-11 貨到付款，已自動送出', true);
      return act(function () { realClick(go); });
    }

    // F) 一般模式：全部就緒 → 提示（最後送出你本人按）
    if (!doneMsg) {
      doneMsg = true;
      var bodyTxt = (document.body.innerText || '').replace(/\s+/g, '');
      var storeOK = WANT_STORE.test(bodyTxt);
      var cardPicked = savedCardOptions().some(function (c) { return c.active; });
      var codShip = grids.some(function (o) { return o.active && /貨到付款/.test(o.txt); });
      banner(!storeOK
        ? '⚠️ 配送已選好，但門市不是南京西門市，請自己確認門市後再送出'
        : (codShip
            ? '✅ 已選好 7-11 貨到付款 ＋ 手機載具 — 模式：手動確認，最後「立即結帳」你自己按（要全自動：儀表板打開「自動立即結帳」後重整此頁）'
            : (cardPicked
                ? '✅ 已選好配送 ＋ 已存卡片 ＋ 手機載具 — 確認金額後自己按送出訂單'
                : '✅ 已選好配送 ＋ 手機載具 — 確認付款後自己按送出訂單')),
        storeOK ? '#16a34a' : '#f59e0b');
      console.log('[funboxGrab] 完成，門市正確=' + storeOK);
    }
  }, 250);

})();
