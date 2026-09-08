// ==UserScript==
// @name         墊腳石 結帳自動設定（配合戰鬥陀螺監控儀表板）
// @namespace    funbox-tools.local
// @version      3.11
// @description  支援墊腳石新版 onepage 結帳（付款/門市/發票攤平在同頁）：自動勾必填的退貨同意、發票用會員載具(免填)。下單模式由儀表板墊腳石分頁的開關控制（預設「手動」＝最後「送出訂單」自己按）；切到「自動」時，門市已帶入且付款確為超商取貨付款(貨到付款)才會自動按「送出訂單」，信用卡等一律不碰、不送出。加入購物車由後端 server.py 用 cookie 完成，不需要本腳本。
// @match        https://www.tcsb.com.tw/checkout/onepage*
// @match        https://www.tcsb.com.tw/*
// @match        https://mfme.map.com.tw/*
// @run-at       document-idle
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function () {
  'use strict';

  var SERVER = 'http://127.0.0.1:8787';   // 儀表板本機伺服器（問下單模式用）

  // 問下單模式：優先用 GM_xmlhttpRequest（不受 tcsb.com.tw 的 CSP 擋），退回一般 fetch。
  // 問不到一律當「手動」(false)，絕不會因為連不到就亂送單。
  function getMode(cb) {
    var done = false;
    function once(v) { if (!done) { done = true; cb(!!v); } }
    if (typeof GM_xmlhttpRequest === 'function') {
      try {
        GM_xmlhttpRequest({
          method: 'GET', url: SERVER + '/api/tcsb_mode', timeout: 5000,
          onload: function (res) { try { once(JSON.parse(res.responseText).auto); } catch (e) { once(false); } },
          onerror: function () { once(false); }, ontimeout: function () { once(false); }
        });
        return;
      } catch (e) {}
    }
    try {
      fetch(SERVER + '/api/tcsb_mode', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) { once(d && d.auto); })
        .catch(function () { once(false); });
    } catch (e) { once(false); }
  }

  // ---------- 登出提醒（不碰密碼、不代登入，只偵測到未登入就通知你）----------
  function topBanner(msg, color, id) {
    id = id || '__tcsb_login_bar';
    var bar = document.getElementById(id);
    if (!bar) {
      bar = document.createElement('div'); bar.id = id;
      var s = bar.style;
      s.position = 'fixed'; s.left = '0'; s.right = '0'; s.top = '0'; s.zIndex = '2147483647';
      s.color = '#fff'; s.font = 'bold 14px system-ui,sans-serif'; s.textAlign = 'center'; s.padding = '8px';
      var put = function () { if (!bar.isConnected && document.body) document.body.appendChild(bar); };
      put(); setInterval(put, 1500);
    }
    bar.textContent = msg; bar.style.background = color;
  }
  // 只認「鐵證」才判定未登入，避免誤報（頁尾/選單常年有「登入/註冊」字樣不算數）：
  //   1) 網址就是登入頁；或 2) 畫面上有「可見的密碼輸入框」（真的跳出登入表單）。
  // 回傳觸發原因字串（給診斷用），沒觸發回空字串。
  function loggedOutReason() {
    if (/\/(login|signin|logon|auth)(\/|$|\?)/i.test(location.pathname)) return 'login-url';
    var pw = document.querySelector('input[type=password]');
    if (pw && pw.offsetParent !== null) {
      var scope = (pw.closest('form') || document.body);
      var near = (scope && scope.innerText) || '';
      if (/登入|登録|sign\s*in/i.test(near)) return 'password-form';
    }
    return '';
  }
  function looksLoggedOut() { return !!loggedOutReason(); }
  var _loginReported = false;
  function reportLoginLost(where) {
    if (_loginReported) return;                 // 每個分頁載入只報一次
    _loginReported = true;
    topBanner('⚠ 墊腳石未登入 — 請先登入（記得勾「記住我」），否則有貨無法自動加入。已通知你的手機／信箱。', '#dc2626');
    try {
      var body = JSON.stringify({ where: where || '' });
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({ method: 'POST', url: SERVER + '/api/tcsb_login_alert',
          data: body, headers: { 'Content-Type': 'text/plain' } });
      } else {
        fetch(SERVER + '/api/tcsb_login_alert', { method: 'POST', mode: 'no-cors',
          headers: { 'Content-Type': 'text/plain' }, body: body });
      }
    } catch (e) {}
  }

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
  // 發票開立方式（會員載具＝免填最省事；要改手機條碼把這行換成 /手機條碼/，但那需要填載具號碼）
  var WANT_INVOICE = /會員載具/;
  // 你的收件資料（結帳彈窗空白時自動填）
  var MY_NAME = '你的姓名';
  var MY_PHONE = '09xxxxxxxx';
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

  // ===== 任何墊腳石(www) 頁面：檢查登入狀態，未登入就提醒（配合定時刷可提早發現）=====
  // 只認鐵證（登入網址 / 可見密碼欄）才提醒，避免誤報。
  function checkLogin(tag) {
    var r = loggedOutReason();
    if (r) { console.log('[tcsbGrab] 判定未登入(' + r + ') @ ' + tag); reportLoginLost(r); }
  }
  setTimeout(function () { checkLogin('t2.5'); }, 2500);
  setTimeout(function () { checkLogin('t6'); }, 6000);

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

  // 下單模式：null=還沒問到、true=自動按「送出訂單」、false=手動（預設）。
  var tcsbAutoMode = null;
  getMode(function (v) { tcsbAutoMode = v; console.log('[tcsbGrab] 下單模式 auto=' + tcsbAutoMode); });
  // 這個分頁 session 是否已自動送出過（避免重整後重複送單）
  var tcsbSubmitted = false;
  try { tcsbSubmitted = (sessionStorage.getItem('tcsbGrab.submitted') === '1'); } catch (e) {}

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

  // ---------- 自動送出訂單（只在儀表板開關為「自動」時執行）----------
  // 找「送出訂單」鈕（精準比對）
  function findSubmitBtn() {
    var els = document.querySelectorAll('button,a,input[type=button],input[type=submit]');
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].textContent || els[i].value || '').replace(/\s+/g, '');
      if (t === '送出訂單' && visible(els[i])) return els[i];
    }
    for (var j = 0; j < els.length; j++) {
      var t2 = (els[j].textContent || els[j].value || '').replace(/\s+/g, '');
      if (/送出訂單/.test(t2) && visible(els[j])) return els[j];
    }
    return null;
  }

  // 目前鎖定的配送/付款方式文字（「變更」鈕附近那一塊）
  function chosenShipText() {
    var chg = findBtn('變更');
    var box = chg ? chg.parentElement : null;
    for (var u = 0; u < 4 && box; u++) {
      var t = (box.textContent || '').replace(/\s+/g, '');
      if (/取貨|宅配|超商|付款|運送/.test(t)) return t;
      box = box.parentElement;
    }
    return (document.body.innerText || '').replace(/\s+/g, '');
  }

  // 送出前最後防線：確認是「取貨付款(貨到付款)」，不是信用卡等先付款方式。
  function shipIsCOD() {
    var t = chosenShipText();
    if (/信用卡|刷卡|線上刷卡/.test(t)) return false;   // 有刷卡字樣一律不自動送
    return /取貨付款/.test(t);                          // 必須是取貨付款才放行
  }

  // ---------- 新版 onepage 專用（付款/門市/發票攤平在同一頁，不是彈窗）----------
  // 判別依據：必勾的「退貨同意」checkbox —— 它只出現在攤平的結帳主頁，任何彈窗裡都沒有。
  function consentCheckbox() {
    var cbs = document.querySelectorAll('input[type=checkbox]');
    for (var i = 0; i < cbs.length; i++) {
      var l = cbs[i].closest('label') || cbs[i].parentElement;
      var t = (l && l.textContent) || '';
      if (/同意/.test(t) && /(退貨|銷貨|退款|代為處理)/.test(t)) return cbs[i];
    }
    return null;
  }
  // 目前「已選中」的付款/配送是取貨付款(貨到付款)，且沒有任何信用卡/刷卡被選 → 才算 COD。
  function payIsCOD() {
    var rs = document.querySelectorAll('input[type=radio]'), t = '';
    for (var i = 0; i < rs.length; i++) if (rs[i].checked) {
      var l = rs[i].closest('label') || rs[i].parentElement; t += ' ' + ((l && l.textContent) || '');
    }
    t = t.replace(/\s+/g, '');
    if (/信用卡|刷卡|線上刷卡/.test(t)) return false;
    return /取貨付款|超商取貨|貨到付款/.test(t);
  }
  // 頁面有沒有「必填未完成」的紅字（例如發票載具沒填、門市沒選）→ 有就不自動送。
  function hasRequiredError() {
    return /為必填|必填欄位|請選擇門市|請輸入.{0,6}條碼|請填寫/.test(document.body.innerText || '');
  }
  // 有沒有把付款「選成」信用卡/刷卡（真的選錯 → 停手；「還沒選」不算）。
  function payIsCreditSelected() {
    var rs = document.querySelectorAll('input[type=radio]');
    for (var i = 0; i < rs.length; i++) if (rs[i].checked) {
      var l = rs[i].closest('label') || rs[i].parentElement;
      if (/信用卡|刷卡|線上刷卡/.test((l && l.textContent) || '')) return true;
    }
    return false;
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

    // ===== A) 新版 onepage（攤平在同頁）：偵測到退貨同意 checkbox 就走這條，
    //          完全繞過下面舊的彈窗流程（舊流程會把常駐的「超商取貨付款」radio 誤判成
    //          運送方式視窗一直開著，害它重複點門市 → 逾時）。=====
    var consent = consentCheckbox();
    if (consent) {
      // A-1) 若發票視窗剛好開著 → 選「會員載具」(免填) → 按確認
      var invA = invoiceRadios();
      if (invA.length) {
        var mem = null;
        for (var mi = 0; mi < invA.length; mi++) if (WANT_INVOICE.test(invA[mi].txt)) { mem = invA[mi]; break; }
        if (mem && !mem.input.checked) return act(function () {
          try { mem.input.click(); } catch (e) {}
          if (!mem.input.checked && mem.box) realClick(mem.box);
        });
        var okc = findBtn('確認');
        if (okc) return act(function () { realClick(okc); });
        return;   // 等視窗關掉
      }
      // A-2) 主頁：先勾必填的「退貨同意」
      if (!consent.checked) return act(function () {
        try { consent.click(); } catch (e) {}
        if (!consent.checked) realClick(consent);
        if (!consent.checked) { var lb = consent.closest('label'); if (lb) realClick(lb); }
      });
      // A-3) 同意已勾。先判斷：現在是不是「正在選運送方式/門市」的階段？
      //      是 → 什麼都不做，落到下面舊的自動選店機制（自動選全家取貨付款＋全家京鋒店）。
      //      否（運送方式已定案，State 1）→ 由這裡負責送出／提示，並擋掉「選好後又重複點」的 bug。
      var pickBtn = findBtn('選擇運送方式');                       // 還沒選運送方式時會有這顆
      var shipModalOpen = shipRadios().length > 0 && !!findBtn('確認'); // 運送方式視窗開著（多選項＋確認）
      var recipientModalOpen = !!fieldByPlaceholder(/姓名/) || !!fieldByPlaceholder(/手機/);
      var selecting = !!pickBtn || shipModalOpen || recipientModalOpen;
      if (!selecting) {
        // 運送方式已定案（State 1）
        var ready = payIsCOD() && storeChosen();
        if (tcsbAutoMode === true && !tcsbSubmitted) {
          if (payIsCreditSelected()) { banner('⛔ 自動送出已停止：付款被選成信用卡/刷卡，本工具只走「超商取貨付款」，請自行確認', '#dc2626'); done = true; clearInterval(iv); return; }
          if (!ready) { banner('⏳ 正在確認運送方式與門市…', '#2563eb'); tries = 0; return; }   // 短暫過渡，等它穩定
          if (hasRequiredError()) { banner('⛔ 自動送出已暫停：頁面有必填欄位未完成，請自行確認', '#dc2626'); done = true; clearInterval(iv); return; }
          var sbN = findSubmitBtn();
          if (!sbN) return;
          tcsbSubmitted = true; try { sessionStorage.setItem('tcsbGrab.submitted', '1'); } catch (e) {}
          banner('🚀 自動送出訂單：已按「送出訂單」（超商取貨付款／貨到付款）— 訂單成立後不取貨即自動取消', '#16a34a');
          console.log('[tcsbGrab] 自動送出訂單：按下「送出訂單」（新版 onepage）');
          realClick(sbN);
          done = true; clearInterval(iv); return;
        }
        // 手動模式
        banner(ready ? '✅ 超商取貨付款＋門市＋退貨同意都 OK — 確認金額後自己按「送出訂單」'
                     : '運送方式/門市確認中…發票已用會員載具、退貨同意已勾', ready ? '#16a34a' : '#f59e0b');
        if (ready) { done = true; clearInterval(iv); }
        else { tries = 0; }
        return;
      }
      // selecting === true → 不 return，往下交給舊的自動選店機制（選全家取貨付款＋全家京鋒店）
    }

    // 1) 沒有彈窗、而且配送已鎖定（按鈕變成「變更」）→ 完成
    if (!modalOpen() && shippingLocked()) {
      // 發票還不是指定方式 → 點開「發票資料」那一列，下一輪由發票視窗分支處理
      var row = invoiceRow();
      if (row && !WANT_INVOICE.test((row.textContent || '').trim()) && invOpenTries < 5) {
        invOpenTries++;
        return act(function () { realClick(row); });
      }
      var okStore = storeChosen();
      var invRow2 = invoiceRow();
      var invOK = invRow2 ? WANT_INVOICE.test((invRow2.textContent || '').trim()) : true;
      var allOK = okStore && invOK;

      // 自動送出：全設定好 + 模式=自動 + 取貨付款 才按「送出訂單」，每個 session 只送一次。
      // 這段每輪都會試（不受 shipBannerShown 擋），直到按到鈕或判定不能送為止。
      if (allOK && tcsbAutoMode === true && !tcsbSubmitted) {
        if (!shipIsCOD()) {
          banner('⛔ 自動送出已暫停：配送不是「取貨付款」(貨到付款)，信用卡等一律不自動送，請自行確認', '#dc2626');
          done = true; clearInterval(iv);
          return;
        }
        var sb = findSubmitBtn();
        if (sb) {
          tcsbSubmitted = true;
          try { sessionStorage.setItem('tcsbGrab.submitted', '1'); } catch (e) {}
          banner('🚀 自動送出訂單：已按「送出訂單」（全家取貨付款／貨到付款）— 訂單成立後不取貨即自動取消', '#16a34a');
          console.log('[tcsbGrab] 自動送出訂單：按下「送出訂單」');
          realClick(sb);
          done = true; clearInterval(iv);
          return;
        }
        return;   // 鈕還沒出現 → 這輪先不提示，下一輪再試
      }

      if (shipBannerShown) return;      // 已提示過就別再做事，但保持監看發票視窗
      shipBannerShown = true;
      banner(allOK
        ? '✅ 已選好「全家取貨付款 ＋ 全家京鋒店 ＋ 手機條碼」— 確認金額後，自己按「送出訂單」'
        : (!okStore ? '⚠️ 門市可能不是你要的，請按「變更」確認'
                    : '⚠️ 發票不是手機條碼，請自己點「發票資料」改一下'),
        allOK ? '#16a34a' : '#f59e0b');
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
