/* 由 funbox_grab.user.js 移植成 Chrome 外掛的 content script。
   注入範圍改由 manifest.json 的 content_scripts 決定。
   安全界線不變：不碰信用卡卡號，不會替你送出訂單。 */


(function () {
  'use strict';

  // ====== 你的偏好設定（要換就改這裡）======
  var WANT_SHIP_TAB = '超商';              // 超商 或 宅配
  var WANT_SHIP     = /^7-11\s*取貨/;      // 7-11 取貨(先付款) ／ 全家取貨(先付款)
  var WANT_PAY      = /^信用卡/;           // 信用卡 ／ Google Pay
  var WANT_INVOICE  = /^手機載具/;         // 會員載具(個人)／公司用(統編)／手機載具／自然人憑證／捐贈碼
  var WANT_STORE    = /南京西門市/;        // 常用門市（只用來確認，不會自動改門市）
  var USE_SAVED_CARD = true;               // 帳號裡有已存卡片時，自動選第一張（只是點選，不碰卡號）
  var AUTO_NEXT     = true;                // 在購物車頁自動按「立即結帳」進到配送步驟
  // =========================================

  console.log('[funboxGrab] 啟動', location.pathname);

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
      setTimeout(function () { location.href = 'https://shop.funbox.com.tw/cart'; }, 1500);
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

    // F) 全部就緒 → 提示（信用卡卡號與最後送出一律你本人操作）
    if (!doneMsg) {
      doneMsg = true;
      var bodyTxt = (document.body.innerText || '').replace(/\s+/g, '');
      var storeOK = WANT_STORE.test(bodyTxt);
      var cardPicked = savedCardOptions().some(function (c) { return c.active; });
      banner(!storeOK
        ? '⚠️ 配送與付款已選好，但門市不是南京西門市，請自己確認門市後再送出'
        : (cardPicked
            ? '✅ 已選好 7-11 取貨 ＋ 已存卡片 ＋ 手機載具（南京西門市）— 確認金額後自己按送出訂單'
            : '✅ 已選好 7-11 取貨 ＋ 信用卡 ＋ 手機載具（南京西門市）— 點卡號欄選你存的卡，再自己按送出訂單'),
        storeOK ? '#16a34a' : '#f59e0b');
      console.log('[funboxGrab] 完成，門市正確=' + storeOK);
    }
  }, 250);

})();
