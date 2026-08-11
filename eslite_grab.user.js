// ==UserScript==
// @name         誠品 自動加入購物車（配合 Funbox 儀表板）
// @namespace    funbox-tools.local
// @version      1.8
// @description  儀表板偵測到誠品有貨、開啟商品頁並帶 ?mgauto=1 時，自動點「加入購物車」，等頁首購物車數字確實增加後跳到 step2；在 step2 自動選好「7-ELEVEN 取貨＋超商取貨付款」。最後的「確認結帳／送出訂單」一律由你本人按。
// @match        https://www.eslite.com/product/*
// @match        https://www.eslite.com/cart/step2*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  // ---------- 共用：找可見元素、擬真點擊 ----------
  function visible(el) { return el && el.offsetParent !== null; }
  function clickEl(el) { try { el.click(); } catch (e) {} }

  // ---------- 購物車內容快照（避免同一件重複加入變成數量 2）----------
  // 每次到 step2 就把「車內有哪些商品」記下來；商品頁要加入前先比對。
  var SNAP_KEY = 'esliteCartSnapV1';
  var SNAP_TTL = 6 * 60 * 60 * 1000;   // 6 小時內的快照才採信

  function loadSnap() {
    try {
      var s = JSON.parse(localStorage.getItem(SNAP_KEY) || 'null');
      if (!s || (Date.now() - s.t) > SNAP_TTL) return null;
      return s;
    } catch (e) { return null; }
  }

  /* =========================================================
     A) 結帳頁 step2：自動選好配送與付款（不送出訂單）
     ========================================================= */
  if (/^\/cart\/step2/.test(location.pathname)) {
    console.log('[esliteGrab] step2：自動設定配送／付款');

    // 把目前車內的商品記下來（只取「像購物車列」的連結：附近有數量/小計/移除等字樣，
    // 避免把推薦商品也算進去）
    function snapshotCart() {
      try {
        var ids = {}, links = document.querySelectorAll('a[href*="/product/"]');
        for (var i = 0; i < links.length; i++) {
          var m = (links[i].getAttribute('href') || '').match(/\/product\/(\d+)/);
          if (!m) continue;
          var row = links[i], ok = false;
          for (var up = 0; up < 5 && row; up++) {
            row = row.parentElement;
            if (!row) break;
            var tx = row.textContent || '';
            if (/數量|小計|移除|刪除/.test(tx) || row.querySelector('input[type=number]')) { ok = true; break; }
          }
          if (ok) ids[m[1]] = true;
        }
        var arr = Object.keys(ids);
        if (arr.length) {
          localStorage.setItem(SNAP_KEY, JSON.stringify({ t: Date.now(), ids: arr }));
          console.log('[esliteGrab] 已記錄購物車內容：', arr);
        }
      } catch (e) {}
    }
    setTimeout(snapshotCart, 1500);
    setTimeout(snapshotCart, 4000);   // 頁面慢慢渲染，再記一次

    // 想要的選項；想改成別家超商就改這裡的關鍵字
    var WANT_SHIP = /7-?ELEVEN\s*取貨|台灣7-?ELEVEN/i;   // 台灣7-ELEVEN取貨
    var WANT_PAY  = /7-?ELEVEN.*取貨付款|超商取貨付款/i;   // 7-ELEVEN超商取貨付款

    // 擬真點擊（誠品的選項可能是自訂元件，普通 .click() 不一定有效）
    function realClick(el) {
      try {
        var r = el.getBoundingClientRect();
        var x = r.left + r.width / 2, y = r.top + r.height / 2;
        ['pointerover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
          var Ev = type.indexOf('pointer') === 0 ? PointerEvent : MouseEvent;
          el.dispatchEvent(new Ev(type, { bubbles: true, cancelable: true, view: window,
            clientX: x, clientY: y, button: 0 }));
        });
      } catch (e) { clickEl(el); }
    }

    // 這個選項有沒有被選中？（真 radio / aria / class 三種判斷）
    function isChosen(el) {
      if (!el) return false;
      var r = el.querySelector && el.querySelector('input[type=radio]');
      if (r && r.checked) return true;
      if (el.getAttribute && el.getAttribute('aria-checked') === 'true') return true;
      var inner = el.querySelector && el.querySelector('[aria-checked="true"],input:checked');
      if (inner) return true;
      var cls = (el.className || '').toString();
      if (/selected|active|checked|current/i.test(cls)) return true;
      return false;
    }

    // 找到「文字符合、且是最小的那個可點區塊」
    function findOptionBox(re) {
      var all = document.querySelectorAll('label,div,li,button,span,a');
      var best = null, bestLen = 1e9;
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (!visible(el)) continue;
        var txt = (el.textContent || '').replace(/\s+/g, '');
        if (txt.length > 40 || !re.test(txt)) continue;
        if (txt.length < bestLen) { best = el; bestLen = txt.length; }
      }
      if (!best) return null;
      // 從最小的文字節點往上找「像選項」的容器（含 radio 或可點擊）
      var box = best;
      for (var up = 0; up < 4 && box; up++) {
        if (box.querySelector && box.querySelector('input[type=radio],[role="radio"]')) return box;
        var st = window.getComputedStyle(box);
        if (st && st.cursor === 'pointer') return box;
        box = box.parentElement;
      }
      return best;
    }

    // 依序嘗試多種點法，直到真的選上
    function pickOption(re) {
      var box = findOptionBox(re);
      if (!box) return false;
      if (isChosen(box)) return true;
      var radio = box.querySelector('input[type=radio]');
      var targets = [];
      if (radio) targets.push(radio);
      var lb = box.querySelector('label') || (box.tagName === 'LABEL' ? box : null);
      if (lb) targets.push(lb);
      targets.push(box);
      if (box.firstElementChild) targets.push(box.firstElementChild);
      for (var i = 0; i < targets.length; i++) {
        clickEl(targets[i]);
        if (isChosen(box)) return true;
        realClick(targets[i]);
        if (isChosen(box)) return true;
      }
      return isChosen(box);
    }

    // 診斷：把選項結構印到 Console，方便回報排錯
    function dumpDiag() {
      try {
        var out = [];
        var box = findOptionBox(WANT_SHIP);
        out.push('shipBox=' + (box ? box.tagName + '.' + (box.className || '').toString().slice(0, 60) : 'NOT FOUND'));
        if (box) {
          out.push('  hasRadio=' + !!box.querySelector('input[type=radio]'));
          out.push('  role=' + box.getAttribute('role') + ' aria-checked=' + box.getAttribute('aria-checked'));
          out.push('  html=' + box.outerHTML.slice(0, 400));
        }
        out.push('total radios on page=' + document.querySelectorAll('input[type=radio]').length);
        console.log('[esliteGrab][診斷]\n' + out.join('\n'));
      } catch (e) {}
    }

    // 收件人資料：選「選擇近期寄送地址」（會自動帶出姓名／電話／常用門市）
    var WANT_ADDR = /選擇近期寄送地址/;

    // 想固定用哪一間門市？填店名關鍵字（例如 /南京西門市/）。
    // 留成 null 就沿用彈窗裡原本選中的那筆（通常是最近一次用的）。
    var PREFER_STORE = /南京西門市/;

    // 「選擇已儲存之配送地址」彈窗：挑好地址後自動按「確認」
    function handleAddressModal() {
      // 找到彈窗容器（含標題文字的最小區塊往上兩層）
      var title = null, all = document.querySelectorAll('div,h2,h3,p,span');
      for (var i = 0; i < all.length; i++) {
        var tx = (all[i].textContent || '').trim();
        if (/^選擇已儲存之配送地址$/.test(tx) && visible(all[i])) { title = all[i]; break; }
      }
      if (!title) return false;
      var modal = title;
      for (var up = 0; up < 4 && modal.parentElement; up++) {
        modal = modal.parentElement;
        if (modal.querySelector('input[type=radio]')) break;
      }
      // 有指定偏好門市就先選它
      if (PREFER_STORE) {
        var rows = modal.querySelectorAll('input[type=radio]');
        for (var r = 0; r < rows.length; r++) {
          var row = rows[r], box = row.closest('label') || row.parentElement;
          for (var u = 0; u < 3 && box && (box.textContent || '').length < 10; u++) box = box.parentElement;
          if (box && PREFER_STORE.test(box.textContent || '') && !row.checked) {
            clickEl(row); if (!row.checked) realClick(box);
            break;
          }
        }
      }
      // 按「確認」（只在這個彈窗內找，不會誤按頁面上的結帳鈕）
      var btns = modal.querySelectorAll('button,a');
      for (var b = 0; b < btns.length; b++) {
        var t2 = (btns[b].textContent || '').trim();
        if (t2 === '確認' && visible(btns[b])) {
          realClick(btns[b]);
          console.log('[esliteGrab] 已自動確認配送地址／門市');
          return true;
        }
      }
      return false;
    }

    // 門市有沒有帶出來？（收件人區塊出現「門市」+ 店名文字）
    function storeFilled() {
      var els = document.querySelectorAll('div,td,span,p');
      for (var i = 0; i < els.length; i++) {
        var t = (els[i].textContent || '');
        if (t.length < 120 && /門市/.test(t) && /7-?ELEVEN|統一超商|全家|門市$/i.test(t) && /路|街|號|區/.test(t)) return true;
      }
      return false;
    }

    var shipOK = false, payOK = false, addrOK = false, storeClicked = false, modalDone = false;
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      if (!shipOK) shipOK = pickOption(WANT_SHIP);
      if (!payOK)  payOK  = pickOption(WANT_PAY);   // 付款選項要等配送選好才會出現
      // 配送選好後才會出現收件人區塊，這時選「近期寄送地址」
      if (shipOK && !addrOK) addrOK = pickOption(WANT_ADDR);
      // 若「選擇已儲存之配送地址」彈窗開著 → 選好門市並自動按確認
      if (handleAddressModal()) { modalDone = true; }
      // 地址選了但門市仍空白 → 點一次「選擇已儲存門市」把常用門市帶進來
      if (addrOK && !storeClicked && tries > 6 && !storeFilled()) {
        var sb = null, btns = document.querySelectorAll('a,button');
        for (var bi = 0; bi < btns.length; bi++) {
          if (/選擇已儲存門市/.test(btns[bi].textContent || '') && visible(btns[bi])) { sb = btns[bi]; break; }
        }
        if (sb) { realClick(sb); storeClicked = true; console.log('[esliteGrab] 已點「選擇已儲存門市」'); }
      }
      if ((shipOK && payOK && addrOK) || tries > 40) {   // 最多試 12 秒
        if (!shipOK || !payOK) dumpDiag();
        clearInterval(t);
        console.log('[esliteGrab] step2 完成：取貨=' + shipOK + ' 付款=' + payOK + ' 收件地址=' + addrOK + ' 門市=' + storeFilled());
        // 提示橫幅：告訴你已設定好，最後一步請自己按
        var allOK = shipOK && payOK && addrOK;
        try {
          var bar = document.createElement('div');
          bar.textContent = allOK
            ? '✅ 已選好 7-ELEVEN 取貨 ＋ 超商取貨付款 ＋ 近期寄送地址' +
              (storeFilled() ? '（門市已帶入）' : '（⚠ 門市未帶入，請自己選門市）') +
              ' — 確認後自己按「確認結帳」送出'
            : '⚠️ 有項目沒選到（取貨=' + shipOK + ' 付款=' + payOK + ' 地址=' + addrOK + '）。請按 F12 開 Console，把 [esliteGrab][診斷] 那段貼給 Claude';
          var s = bar.style;
          s.position = 'fixed'; s.left = '0'; s.right = '0'; s.top = '0'; s.zIndex = '2147483647';
          s.background = allOK ? (storeFilled() ? '#16a34a' : '#f59e0b') : '#f59e0b';
          s.color = '#fff'; s.font = 'bold 14px system-ui,sans-serif';
          s.textAlign = 'center'; s.padding = '8px';
          var put = function () { if (!bar.isConnected && document.body) document.body.appendChild(bar); };
          put(); setInterval(put, 1500);
        } catch (e) {}
      }
    }, 300);
    return;   // step2 只做設定，不執行下面的加入購物車流程
  }

  /* =========================================================
     B) 商品頁：自動加入購物車 → 跳 step2
     ========================================================= */
  // 只有帶「自動加入暗號」時才動作，平常瀏覽誠品不受影響
  if (!/[?&]mgauto=1\b/.test(location.search)) return;
  console.log('[esliteGrab] 自動加入模式啟動', location.href);

  var STEP2 = 'https://www.eslite.com/cart/step2';
  // 要不要自動加入由儀表板每張卡的「自動:開/關」控制；
  // 另外會比對購物車快照：這件已經在車內就不再加（每件維持 1，也避免頻繁動作被判定為機器人）。

  // 這件商品已經在購物車裡了嗎？（依據上次在 step2 記下的快照）
  var pid = (location.pathname.match(/\/product\/(\d+)/) || [])[1] || '';
  var snap = loadSnap();
  if (pid && snap && snap.ids.indexOf(pid) !== -1) {
    console.log('[esliteGrab] 這件已在購物車內（' + pid + '），略過加入');
    try {
      var nb = document.createElement('div');
      nb.textContent = '🛒 這件已經在購物車裡了，略過自動加入（要重新加請先在誠品購物車移除）';
      var ns = nb.style;
      ns.position = 'fixed'; ns.left = '0'; ns.right = '0'; ns.top = '0'; ns.zIndex = '2147483647';
      ns.background = '#2563eb'; ns.color = '#fff';
      ns.font = 'bold 14px system-ui,sans-serif'; ns.textAlign = 'center'; ns.padding = '8px';
      var putn = function () { if (!nb.isConnected && document.body) document.body.appendChild(nb); };
      putn(); setInterval(putn, 1500);
    } catch (e) {}
    return;
  }

  // 誠品購物車在「伺服器端」，頁首「購物車(N)」才是真實數量；localStorage.cart 是假的。
  function headerCount() {
    var els = document.querySelectorAll('a,span,div,button');
    for (var i = 0; i < els.length; i++) {
      var m = (els[i].textContent || '').trim().match(/^購物車\s*\((\d+)\)$/);
      if (m) return parseInt(m[1], 10);
    }
    return -1;
  }

  function findBtn(text) {
    var els = document.querySelectorAll('a,button');
    for (var i = 0; i < els.length; i++) {
      if ((els[i].textContent || '').trim() === text && els[i].offsetParent !== null) return els[i];
    }
    for (var j = 0; j < els.length; j++) {
      if ((els[j].textContent || '').trim().indexOf(text) !== -1 && els[j].offsetParent !== null) return els[j];
    }
    return null;
  }

  var done = false;
  var startN = null;
  var deadline = Date.now() + 15000;
  var lastClick = 0;
  var clicks = 0;

  var iv = setInterval(function () {
    if (done) return;
    if (Date.now() > deadline) { clearInterval(iv); console.log('[esliteGrab] 逾時，未確認加入'); return; }

    // 缺貨頁（只有「貨到通知」、沒有「加入購物車」）→ 放棄
    if (findBtn('貨到通知') && !findBtn('加入購物車')) { clearInterval(iv); console.log('[esliteGrab] 缺貨，跳過'); return; }

    var now = headerCount();
    if (startN === null) { if (now < 0) return; startN = now; }

    // 數字確實增加 → 成功加入 1 件，跳 step2
    if (now > startN) {
      done = true; clearInterval(iv);
      console.log('[esliteGrab] 已加入（' + startN + '→' + now + '），前往 step2');
      location.href = STEP2;
      return;
    }

    // 還沒增加：點「加入購物車」（最多 3 次、每次間隔 1.5 秒）
    var btn = findBtn('加入購物車');
    if (btn && clicks < 3 && (Date.now() - lastClick) > 1500) {
      try { btn.click(); } catch (e) {}
      clicks++; lastClick = Date.now();
      console.log('[esliteGrab] 已點加入購物車，第 ' + clicks + ' 次');
    }
  }, 300);

})();
