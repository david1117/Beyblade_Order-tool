// ==UserScript==
// @name         墊腳石 結帳自動設定（配合戰鬥陀螺監控儀表板）
// @namespace    funbox-tools.local
// @version      3.5
// @description  在墊腳石結帳頁自動選好「全家取貨付款」與你的常用門市（全家京鋒店），把流程推到只剩最後一顆「送出訂單」由你本人按。加入購物車由後端 server.py 用 cookie 完成，不需要本腳本。
// @match        https://www.tcsb.com.tw/checkout/onepage*
// @match        https://www.tcsb.com.tw/*
// @match        https://mfme.map.com.tw/*
// @run-at       document-idle
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  // ====== 你的偏好設定（要換超商/門市改這裡）======
  // 運送方式關鍵字：例如 /^全家取貨付款/、/^7-ELEVEN取貨付款/、/^萊爾富取貨付款/
  var WANT_SHIP = /^全家取貨付款/;
  // 門市名稱關鍵字（用來確認有沒有帶到正確門市）
  var WANT_STORE = /全家京鋒店/;
  // 門市搜尋關鍵字（在全家地圖用「店名查詢」找店）
  var STORE_SEARCH = '京鋒';
  // 門市店號（最可靠）：填了就直接用網址開店鋪頁，不用搜尋也不用點清單。
  // 查法：在全家地圖選一次該門市，網址列的 pkey=xxxxx 就是店號。
  var STORE_PKEY = '025922';        // 全家京鋒店
  // 發票開立方式（預設用手機條碼；載具號碼沿用會員資料，不會去改它）
  var WANT_INVOICE = /手機條碼/;
  // 你的收件資料（結帳彈窗空白時自動填）
  var MY_NAME = '李承';
  var MY_PHONE = '0903646800';
  // ==============================================

  /* ===== 全家門市地圖（mfme.map.com.tw）自動選店 ===== */
  if (location.host === 'mfme.map.com.tw') {
    // 用目前網址上的參數，組出「指定店號」的店鋪頁網址
    function buildStoreUrl(pkey) {
      var q = new URLSearchParams(location.search);
      var out = new URLSearchParams();
      ['cvsname', 'cvsid', 'cvstemp', 'exchange', 'cvslink'].forEach(function (k) {
        out.set(k, q.get(k) || '');
      });
      out.set('city', ''); out.set('area', '');
      out.set('pkey', pkey);
      out.set('searchType', '1');
      out.set('searchWord', STORE_SEARCH);
      return location.origin + '/store.aspx?' + out.toString();
    }

    // 捷徑：一進地圖首頁就直接跳到指定店號的店鋪頁（不用搜尋、不用點清單）
    if (STORE_PKEY && /default\.aspx/i.test(location.pathname)) {
      location.href = buildStoreUrl(STORE_PKEY);
      return;
    }

    var mapTries = 0;
    var mapIv = setInterval(function () {
      if (++mapTries > 40) { clearInterval(mapIv); return; }
      var txt = (document.body ? document.body.innerText : '') || '';

      // 第三步：店鋪資訊頁 → 按「確定店舖」回傳給墊腳石
      var okStore = [].slice.call(document.querySelectorAll('a,button,input[type=button],input[type=submit]'))
        .filter(function (b) { var r = b.getBoundingClientRect();
          return (b.textContent || b.value || '').trim() === '確定店舖' && r.width > 0 && r.height > 0; })[0];
      if (okStore) { clearInterval(mapIv); okStore.click(); return; }

      // 第二步：搜尋結果清單 → 直接用店號跳到店鋪頁（清單項目吃不到程式點擊）
      if (/請選擇店舖/.test(txt)) {
        if (STORE_PKEY && location.pathname.indexOf('store.aspx') === -1) {
          clearInterval(mapIv);
          location.href = buildStoreUrl(STORE_PKEY);
          return;
        }
        // 沒設店號才退回「嘗試點清單」
        var row = [].slice.call(document.querySelectorAll('tr,li,div,a,td')).filter(function (e) {
          var rr = e.getBoundingClientRect();
          return WANT_STORE.test(e.textContent || '') && rr.width > 0 && rr.height > 0 &&
                 (e.textContent || '').length < 80;
        }).pop();                       // 取最內層那個（文字最貼近店名）
        if (row) {
          var node = row;
          for (var lv = 0; lv < 4 && node; lv++) {   // 自己 → 往上幾層都試點看看
            try { node.click(); } catch (e) {}
            var rc = node.getBoundingClientRect();
            ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (t) {
              var E = t.indexOf('pointer') === 0 ? PointerEvent : MouseEvent;
              node.dispatchEvent(new E(t, { bubbles: true, cancelable: true, view: window,
                clientX: rc.left + rc.width / 2, clientY: rc.top + rc.height / 2, button: 0 }));
            });
            try {   // 這站是 ASP.NET，多半有 jQuery，用它觸發事件最準
              if (unsafeWindow.jQuery) unsafeWindow.jQuery(node).trigger('click');
            } catch (e) {}
            node = node.parentElement;
          }
        }
        return;
      }

      // 第一步：首頁 → 開「店名查詢」、填關鍵字、送出
      var inp = document.getElementById('storenum');
      if (!inp || inp.getBoundingClientRect().width <= 0) {
        try { if (typeof unsafeWindow.openLightBox === 'function') unsafeWindow.openLightBox(1); } catch (e) {}
        var nameTab = document.getElementById('storeNameSearch');
        if (nameTab) nameTab.click();
        return;
      }
      if (!inp.value) {
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, STORE_SEARCH);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        var go = [].slice.call(document.querySelectorAll('input[type=button],button,a'))
          .filter(function (b) { var r2 = b.getBoundingClientRect();
            return (b.textContent || b.value || '').trim() === '確定' && r2.width > 0 && r2.height > 0; })[0];
        if (go) go.click();
      }
    }, 500);
    return;
  }

  /* ===== 商品頁：儀表板帶 ?mgauto=1 來 → 用你的登入狀態自動加入購物車 =====
     （免 cookie 模式：config 沒填 session_cookie 時走這條）*/
  if (/^\/\d{8,14}$/.test(location.pathname)) {
    if (!/[?&]mgauto=1\b/.test(location.search)) return;   // 平常逛街不受影響
    console.log('[tcsbGrab] 商品頁自動加入模式');
    var pTries = 0, pDone = false;
    var pIv = setInterval(function () {
      if (pDone) return;
      if (++pTries > 40) { clearInterval(pIv); return; }
      var btn = [].slice.call(document.querySelectorAll('button,a')).filter(function (b) {
        var t = (b.textContent || '').trim();
        var r = b.getBoundingClientRect();
        return t === '加入購物車' && r.width > 0 && r.height > 0;
      })[0];
      if (!btn) return;                        // 缺貨或還沒載完
      pDone = true; clearInterval(pIv);
      try { btn.click(); } catch (e) {}
      setTimeout(function () { location.href = 'https://www.tcsb.com.tw/checkout/onepage'; }, 1500);
    }, 300);
    return;
  }

  // 其他非結帳頁不動作
  if (!/^\/checkout\/onepage/.test(location.pathname)) return;

  console.log('[tcsbGrab] 結帳頁自動設定啟動');

  // 可見性判斷：不能用 offsetParent！彈窗常是 position:fixed，
  // 這種元素的 offsetParent 永遠是 null，會害我們找不到「確認」按鈕。
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var st = window.getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
  }

  // 擬真點擊：墊腳石的按鈕多為 Vue 元件，普通 click 有時不生效
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
    var els = document.querySelectorAll('button,a,input[type=button],input[type=submit]');
    // 先找完全相符
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].textContent || els[i].value || '').trim();
      if (t === text && visible(els[i])) return els[i];
    }
    // 後備：文字包含（避開會真的送出訂單的按鈕）
    for (var j = 0; j < els.length; j++) {
      var t2 = (els[j].textContent || els[j].value || '').trim();
      if (t2.length <= 8 && t2.indexOf(text) !== -1 && !/送出|結帳/.test(t2) && visible(els[j])) return els[j];
    }
    return null;
  }

  // 依「欄位」找：姓名 / 手機 輸入框（收件資料視窗的特徵）
  function fieldByPlaceholder(re) {
    var els = document.querySelectorAll('input');
    for (var i = 0; i < els.length; i++) {
      if (visible(els[i]) && re.test(els[i].placeholder || '')) return els[i];
    }
    return null;
  }

  // 門市選好了沒？只看「選擇門市」按鈕所在的那一小塊，不掃整頁（快很多）
  function storeChosen() {
    var btn = findBtn('選擇門市');
    if (!btn) return WANT_STORE.test((document.body.innerText || '').replace(/\s+/g, ''));
    var box = btn.parentElement;
    for (var u = 0; u < 3 && box; u++) {
      if (WANT_STORE.test((box.textContent || '').replace(/\s+/g, ''))) return true;
      box = box.parentElement;
    }
    return false;
  }

  // 已經設定完成？（配送鎖定後按鈕會從「選擇運送方式」變成「變更」）
  function shippingLocked() {
    return !findBtn('選擇運送方式') && !!findBtn('變更');
  }

  function banner(msg, color) {
    var bar = document.getElementById('__tcsb_bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = '__tcsb_bar';
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

  var tries = 0;
  var done = false;
  var shipBannerShown = false;
  var invOpenTries = 0;         // 點開發票視窗的次數上限，避免無限重點
  var lastAct = 0;          // 上次動作時間：一次只做一個動作，每步間隔 GAP 毫秒
  var GAP = 700;

  // 目前是不是有彈窗開著（用欄位/選項判定，不看畫面）
  function modalOpen() {
    return !!fieldByPlaceholder(/姓名/) || !!fieldByPlaceholder(/手機/) ||
           shipRadios().length > 0 || invoiceRadios().length > 0;
  }

  // 取得運送方式的選項。注意：墊腳石用自訂樣式的圓圈，真正的 input[type=radio]
  // 常常是 0 尺寸／透明的隱藏元素，所以這裡「不做可見性過濾」，只靠文字比對，
  // 點擊時改點它外層那個看得到的區塊。
  // 發票開立方式的選項（會員載具／手機條碼／自然人憑證／公司用發票／捐贈發票）
  function invoiceRadios() {
    return [].slice.call(document.querySelectorAll('input[type=radio]')).map(function (r) {
      var box = r.closest('label') || r.parentElement;
      for (var u = 0; u < 4 && box && (box.textContent || '').trim().length < 3; u++) box = box.parentElement;
      return { input: r, box: box, txt: (box && box.textContent || '').replace(/\s+/g, '') };
    }).filter(function (o) { return /會員載具|手機條碼|自然人憑證|公司用發票|捐贈發票/.test(o.txt); });
  }

  // 結帳頁「發票資料」那一列（顯示目前開立方式，例如「會員載具」；點它會開設定視窗）
  function invoiceRow() {
    var els = document.querySelectorAll('button,a,div,span');
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].textContent || '').trim();
      if (!/^(會員載具|手機條碼|自然人憑證|公司用發票|捐贈發票)$/.test(t)) continue;
      if (!visible(els[i])) continue;
      if (els[i].querySelector('input[type=radio]')) continue;   // 那是視窗裡的選項，不是這一列
      return els[i];
    }
    return null;
  }

  function shipRadios() {
    return [].slice.call(document.querySelectorAll('input[type=radio]')).map(function (r) {
      var box = r.closest('label') || r.parentElement;
      for (var u = 0; u < 4 && box && (box.textContent || '').trim().length < 3; u++) box = box.parentElement;
      return { input: r, box: box, txt: (box && box.textContent || '').replace(/\s+/g, '') };
    }).filter(function (o) { return /取貨|宅配|寄送|超商/.test(o.txt); });
  }

  var iv = setInterval(function () {
    if (done) return;
    if (++tries > 150) {           // 最多試約 45 秒
      clearInterval(iv);
      banner('⚠️ 自動設定逾時，請手動確認配送方式與門市', '#f59e0b');
      return;
    }
    if (Date.now() - lastAct < GAP) return;     // 給頁面反應時間，避免搶快按空
    function act(fn) { fn(); lastAct = Date.now(); }

    // 1) 沒有彈窗、而且配送已鎖定（按鈕變成「變更」）→ 完成
    if (!modalOpen() && shippingLocked()) {
      // 發票還不是指定方式 → 點開「發票資料」那一列，下一輪由發票視窗分支處理
      var row = invoiceRow();
      if (row && !WANT_INVOICE.test((row.textContent || '').trim()) && invOpenTries < 5) {
        invOpenTries++;
        return act(function () { realClick(row); });
      }
      if (shipBannerShown) return;      // 已提示過就別再做事，但保持監看發票視窗
      shipBannerShown = true;
      var okStore = storeChosen();
      var invRow = invoiceRow();
      var invOK = invRow ? WANT_INVOICE.test((invRow.textContent || '').trim()) : true;
      banner((okStore && invOK)
        ? '✅ 已選好「全家取貨付款 ＋ 全家京鋒店 ＋ 手機條碼」— 確認金額後，自己按「送出訂單」'
        : (!okStore ? '⚠️ 門市可能不是你要的，請按「變更」確認'
                    : '⚠️ 發票不是手機條碼，請自己點「發票資料」改一下'),
        (okStore && invOK) ? '#16a34a' : '#f59e0b');
      return;
    }

    // 1.5) 發票開立方式視窗：選「手機條碼」（載具沿用預設）→ 確認
    var inv = invoiceRadios();
    if (inv.length) {
      var want = null;
      for (var k = 0; k < inv.length; k++) {
        if (WANT_INVOICE.test(inv[k].txt)) { want = inv[k]; break; }
      }
      if (want && !want.input.checked) {
        return act(function () {
          try { want.input.click(); } catch (e) {}
          if (!want.input.checked && want.box) realClick(want.box);
        });
      }
      var invOk = findBtn('確認');
      if (invOk) return act(function () {
        realClick(invOk);
        banner('✅ 配送、門市、發票都設定好了 — 確認金額後，自己按「送出訂單」', '#16a34a');
      });
      return;
    }

    // 2) 收件資料視窗（有姓名/手機欄位）：填資料 → 選門市 → 確認
    var nameInput = fieldByPlaceholder(/姓名/);
    var phoneInput = fieldByPlaceholder(/手機/);
    if (nameInput || phoneInput) {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      if (nameInput && !nameInput.value) {
        return act(function () {
          setter.call(nameInput, MY_NAME);
          nameInput.dispatchEvent(new Event('input', { bubbles: true }));
          nameInput.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }
      if (phoneInput && !phoneInput.value) {
        return act(function () {
          setter.call(phoneInput, MY_PHONE);
          phoneInput.dispatchEvent(new Event('input', { bubbles: true }));
          phoneInput.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }
      if (!storeChosen()) {
        var pick = findBtn('選擇門市') || findBtn('新增取貨門市');
        if (pick) return act(function () { realClick(pick); });
        return;                                   // 等地圖回來
      }
      var okBtn = findBtn('確認');
      if (okBtn) return act(function () { realClick(okBtn); });
      return;
    }

    // 3) 運送方式視窗：先選超商，下一輪才按確認
    var rows = shipRadios();
    if (rows.length) {
      var target = null;
      for (var i = 0; i < rows.length; i++) {
        if (WANT_SHIP.test(rows[i].txt)) { target = rows[i]; break; }
      }
      if (target && !target.input.checked) {
        return act(function () {
          try { target.input.click(); } catch (e) {}
          if (!target.input.checked && target.box) realClick(target.box);
          if (!target.input.checked) {          // 再退一步：點外框裡那個自訂圓圈
            var dot = target.box && target.box.querySelector('span,i,div');
            if (dot) realClick(dot);
          }
        });
      }
      var next = findBtn('確認') || findBtn('新增取貨門市');
      if (next) return act(function () { realClick(next); });
      return;
    }

    // 4) 還沒開視窗 → 打開「選擇運送方式」（或已設定過的「變更」不動它）
    var openBtn = findBtn('選擇運送方式');
    if (openBtn) return act(function () { realClick(openBtn); });
  }, 250);

})();
