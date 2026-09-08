// ==UserScript==
// @name         誠品 自動加入購物車（配合 Funbox 儀表板）
// @namespace    funbox-tools.local
// @version      1.9
// @description  儀表板偵測到誠品有貨、開啟商品頁並帶 ?mgauto=1 時，自動點「加入購物車」，等頁首購物車數字確實增加後跳到 step2；在 step2 自動選好「7-ELEVEN 取貨＋超商取貨付款＋近期地址」。下單模式由儀表板誠品分頁的開關控制（預設「手動」＝最後確認結帳自己按）；切到「自動」時，門市已帶入且付款確為超商取貨付款才會自動勾同意條款並按「確認結帳」送出，信用卡等先付款方式一律不碰、不送出。
// @match        https://www.eslite.com/product/*
// @match        https://www.eslite.com/cart/step2*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function () {
  'use strict';

  var SERVER = 'http://127.0.0.1:8787';   // 儀表板本機伺服器（問下單模式用）

  // 問下單模式：優先用 GM_xmlhttpRequest（不受 eslite.com 的 CSP 擋），退回一般 fetch。
  // 問不到一律當「手動」(false)，絕不會因為連不到就亂送單。
  function getMode(cb) {
    var done = false;
    function once(v) { if (!done) { done = true; cb(!!v); } }
    if (typeof GM_xmlhttpRequest === 'function') {
      try {
        GM_xmlhttpRequest({
          method: 'GET', url: SERVER + '/api/eslite_mode', timeout: 5000,
          onload: function (res) { try { once(JSON.parse(res.responseText).auto); } catch (e) { once(false); } },
          onerror: function () { once(false); }, ontimeout: function () { once(false); }
        });
        return;
      } catch (e) {}
    }
    try {
      fetch(SERVER + '/api/eslite_mode', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) { once(d && d.auto); })
        .catch(function () { once(false); });
    } catch (e) { once(false); }
  }

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

    // 下單模式：null=還沒問到、true=自動按「確認結帳」、false=手動（預設）。
    // 直接問儀表板伺服器，儀表板開關一按、這頁重新整理就生效。
    var esAutoMode = null;
    getMode(function (v) { esAutoMode = v; console.log('[esliteGrab] 下單模式 auto=' + esAutoMode); });

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

    // ---------- 自動確認結帳（只在儀表板開關為「自動」時執行）----------
    // 共用橫幅
    function showBar(text, color) {
      try {
        var bar = document.createElement('div');
        bar.textContent = text;
        var s = bar.style;
        s.position = 'fixed'; s.left = '0'; s.right = '0'; s.top = '0'; s.zIndex = '2147483647';
        s.background = color; s.color = '#fff';
        s.font = 'bold 14px system-ui,sans-serif'; s.textAlign = 'center'; s.padding = '8px';
        var put = function () { if (!bar.isConnected && document.body) document.body.appendChild(bar); };
        put(); setInterval(put, 1500);
      } catch (e) {}
    }

    // 送出前最後防線：確認選中的付款「真的是超商取貨付款」，不是信用卡等先付款方式。
    function payIsCOD() {
      var box = findOptionBox(WANT_PAY);
      if (!(box && isChosen(box))) return false;
      // 再保險：整個選中的付款區塊文字不得出現信用卡／先付款字樣
      var tx = (box.textContent || '');
      if (/信用卡|一次付清|先付款|ATM|LINE\s*Pay|街口|悠遊付|Apple\s*Pay|Google\s*Pay/i.test(tx)) return false;
      return true;
    }

    // 勾「我同意並已詳細閱讀誠品線上網路服務約定事項」
    function agreeCheckbox() {
      var boxes = document.querySelectorAll('input[type=checkbox]');
      for (var i = 0; i < boxes.length; i++) {
        var cb = boxes[i];
        if (!visible(cb)) continue;
        var lbl = (cb.closest && cb.closest('label')) || cb.parentElement;
        var tx = (lbl && lbl.textContent) || '';
        if (/同意/.test(tx) && /(約定|服務條款|條款)/.test(tx)) {
          if (!cb.checked) { clickEl(cb); if (!cb.checked && lbl) realClick(lbl); }
          return cb.checked;
        }
      }
      return true;   // 找不到明確的同意框就不擋（誠品可能已預設勾好）
    }

    // 找「確認結帳」鈕（精準比對，避免誤按「返回前頁」）
    function findConfirmBtn() {
      var btns = document.querySelectorAll('button,a');
      for (var i = 0; i < btns.length; i++) {
        var tx = (btns[i].textContent || '').replace(/\s+/g, '');
        if (tx === '確認結帳' && visible(btns[i])) return btns[i];
      }
      for (var j = 0; j < btns.length; j++) {
        var t2 = (btns[j].textContent || '').replace(/\s+/g, '');
        if (/確認結帳/.test(t2) && !/返回/.test(t2) && visible(btns[j])) return btns[j];
      }
      return null;
    }

    // 全設定好後，若模式=自動 → 勾同意、驗證付款、按「確認結帳」（每個分頁 session 只送一次）
    function maybeAutoCheckout() {
      var alreadySent = false;
      try { alreadySent = (sessionStorage.getItem('esGrab.submitted') === '1'); } catch (e) {}
      if (alreadySent) { console.log('[esliteGrab] 這個分頁已自動送出過，不再重送'); return; }
      var submitted = false, waits = 0;
      var w = setInterval(function () {
        waits++;
        if (esAutoMode === null) { if (waits > 24) clearInterval(w); return; }  // 等模式回來（最多約 8 秒）
        if (esAutoMode !== true) { clearInterval(w); return; }                  // 手動模式 → 絕不送出
        if (submitted) { clearInterval(w); return; }
        // 門市沒帶入 → 不自動送，交回給你（避免送出沒有取貨門市的壞單）
        if (!storeFilled()) {
          if (waits > 24) { clearInterval(w);
            showBar('⛔ 自動確認結帳已暫停：門市未帶入，請自己選門市後手動按「確認結帳」', '#dc2626'); }
          return;
        }
        // 付款不是超商取貨付款 → 絕不送出（信用卡等一律不碰）
        if (!payIsCOD()) { clearInterval(w);
          showBar('⛔ 自動確認結帳已中止：付款方式不是「超商取貨付款」，請自行確認', '#dc2626'); return; }
        agreeCheckbox();
        var btn = findConfirmBtn();
        if (!btn) { if (waits > 30) { clearInterval(w);
          showBar('⚠️ 找不到「確認結帳」鈕，請手動按送出', '#f59e0b'); } return; }
        submitted = true; clearInterval(w);
        try { sessionStorage.setItem('esGrab.submitted', '1'); } catch (e) {}
        console.log('[esliteGrab] 自動確認結帳：按下「確認結帳」送出（超商取貨付款）');
        showBar('🚀 自動確認結帳：已按下「確認結帳」送出（7-ELEVEN 超商取貨付款）— 訂單成立後不取貨即自動取消', '#16a34a');
        realClick(btn);
      }, 300);
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
        var allOK = shipOK && payOK && addrOK;
        // 提示橫幅：手動模式告訴你「最後一步自己按」；自動模式下面 maybeAutoCheckout 會再蓋上自己的橫幅
        showBar(
          allOK
            ? '✅ 已選好 7-ELEVEN 取貨 ＋ 超商取貨付款 ＋ 近期寄送地址' +
              (storeFilled() ? '（門市已帶入）' : '（⚠ 門市未帶入，請自己選門市）') +
              ' — 手動模式：確認後自己按「確認結帳」送出'
            : '⚠️ 有項目沒選到（取貨=' + shipOK + ' 付款=' + payOK + ' 地址=' + addrOK + '）。請按 F12 開 Console，把 [esliteGrab][診斷] 那段貼給 Claude',
          allOK ? (storeFilled() ? '#16a34a' : '#f59e0b') : '#f59e0b');
        // 全部設定好才可能自動送出；模式是否為「自動」由 maybeAutoCheckout 內部把關
        if (allOK) maybeAutoCheckout();
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
