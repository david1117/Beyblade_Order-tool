/* 由 momo_grab.user.js 移植成 Chrome 外掛的 content script。
   注入範圍改由 manifest.json 的 content_scripts 決定。
   安全界線不變：不碰信用卡卡號，不會替你送出訂單。 */


(function () {
  'use strict';
  console.log('[momoGrab] 腳本已載入', location.href);

  // 除錯指示燈：若看到頁面最上方橘色橫幅，代表腳本有執行（確認 OK 後可移除這段）
  try {
    var dbg = document.createElement('div');
    dbg.id = 'mg-debug-bar';
    dbg.textContent = '✓ momoGrab 已載入（搶購面板在右下角）';
    var s = dbg.style;
    s.position = 'fixed'; s.top = '0'; s.left = '0'; s.right = '0'; s.zIndex = '2147483647';
    s.background = '#f59e0b'; s.color = '#000'; s.font = 'bold 13px system-ui,sans-serif';
    s.textAlign = 'center'; s.padding = '4px';
    var put = function () { if (!dbg.isConnected && document.documentElement) document.documentElement.appendChild(dbg); };
    put(); setInterval(put, 1000);
  } catch (e) { console.log('[momoGrab] debug bar error', e); }

  var LS = 'momoGrab.' + location.pathname;   // 每個商品頁各自記憶設定
  var SS = 'momoGrab.firing';                 // 跨重新整理的「開火中」旗標

  function load() { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) { return {}; } }
  function save(o) { try { localStorage.setItem(LS, JSON.stringify(o)); } catch (e) {} }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // ---- 用 createElement 建 UI（避開 Trusted Types 對 innerHTML 的封鎖）----
  function mk(tag, style, text) {
    var e = document.createElement(tag);
    if (style) for (var k in style) e.style[k] = style[k];
    if (text != null) e.textContent = text;
    return e;
  }

  var panel = mk('div', {
    position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647',
    background: '#111827', color: '#e6e9ef', font: '13px/1.5 system-ui,sans-serif',
    border: '1px solid #2a2f3a', borderRadius: '12px', padding: '12px 14px',
    width: '260px', boxShadow: '0 6px 24px rgba(0,0,0,.45)'
  });
  panel.id = 'mg-panel';

  panel.appendChild(mk('div', { fontWeight: '700', marginBottom: '8px' }, '🚀 momo 準點搶購'));

  panel.appendChild(mk('div', { marginBottom: '4px', color: '#8b93a1' }, '開賣時間（24 小時制）'));
  var timeRow = mk('div', { display: 'flex', gap: '6px', marginBottom: '8px' });
  var $date = mk('input', { flex: '1', padding: '4px', borderRadius: '6px', border: '1px solid #2a2f3a', background: '#0f1115', color: '#fff' });
  $date.type = 'date';
  var $time24 = mk('input', { width: '95px', padding: '4px', borderRadius: '6px', border: '1px solid #2a2f3a', background: '#0f1115', color: '#fff', textAlign: 'center' });
  $time24.type = 'text'; $time24.placeholder = 'HH:MM:SS';
  timeRow.appendChild($date); timeRow.appendChild($time24);
  panel.appendChild(timeRow);

  var modeRow = mk('div', { marginBottom: '8px' });
  modeRow.appendChild(document.createTextNode('模式 '));
  var $mode = mk('select', { marginLeft: '6px', padding: '3px', borderRadius: '6px', background: '#0f1115', color: '#fff', border: '1px solid #2a2f3a' });
  var oCart = mk('option', null, '放入購物車（可累積、較穩）'); oCart.value = 'cart';
  var oBuy = mk('option', null, '直接購買（最快）'); oBuy.value = 'buy';
  $mode.appendChild(oCart); $mode.appendChild(oBuy);
  modeRow.appendChild($mode);
  panel.appendChild(modeRow);

  panel.appendChild(mk('div', { marginBottom: '4px', color: '#8b93a1' }, '款式（可留空＝自動選第一個）'));
  var $spec = mk('input', { width: '100%', marginBottom: '8px', padding: '4px', borderRadius: '6px', border: '1px solid #2a2f3a', background: '#0f1115', color: '#fff' });
  $spec.placeholder = '例如：食人花（無規格商品免填）';
  panel.appendChild($spec);

  var reloadRow = mk('label', { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px', cursor: 'pointer' });
  var $reload = mk('input'); $reload.type = 'checkbox'; $reload.checked = true;
  reloadRow.appendChild($reload);
  reloadRow.appendChild(document.createTextNode(' 開賣前自動刷新'));
  panel.appendChild(reloadRow);

  // 預刷提前秒數：開賣前 N 秒先重載頁面（繞開 CDN 舊快取），
  // 載回來後停在原地等，到整點才開火 → 第一次點擊落在開賣瞬間。
  var preRow = mk('div', { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' });
  preRow.appendChild(document.createTextNode('預刷提前'));
  var $pre = mk('input', { width: '52px', padding: '3px', borderRadius: '6px', border: '1px solid #2a2f3a', background: '#0f1115', color: '#fff', textAlign: 'right' });
  $pre.type = 'number'; $pre.step = '0.5'; $pre.min = '0'; $pre.max = '30'; $pre.value = '3';
  preRow.appendChild($pre);
  preRow.appendChild(document.createTextNode('秒（0＝不預刷）'));
  panel.appendChild(preRow);

  function preLeadMs() {
    var v = parseFloat(($pre.value || '').trim());
    if (!isFinite(v) || v < 0) v = 3;
    if (v > 30) v = 30;
    return Math.round(v * 1000);
  }

  // 開火窗口：從開賣時刻起算，最多持續嘗試（重載＋點擊）多久。
  // 原本硬寫 60 秒。8/15 UX-20 那場就是最後一次重載的頁面在 T+73.6s 才載回來，
  // 超過 60 秒的 deadline → 交接判定失敗 → fireLoop 從未啟動 → 靜默放棄 68 秒。
  var winRow = mk('div', { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' });
  winRow.appendChild(document.createTextNode('開火窗口'));
  var $win = mk('input', { width: '58px', padding: '3px', borderRadius: '6px', border: '1px solid #2a2f3a', background: '#0f1115', color: '#fff', textAlign: 'right' });
  $win.type = 'number'; $win.step = '10'; $win.min = '10'; $win.max = '600'; $win.value = '180';
  winRow.appendChild($win);
  winRow.appendChild(document.createTextNode('秒'));
  panel.appendChild(winRow);

  function fireWindowMs() {
    var v = parseFloat(($win.value || '').trim());
    if (!isFinite(v) || v < 10) v = 180;
    if (v > 600) v = 600;
    return Math.round(v * 1000);
  }

  var RESUME_GRACE_MS = 30000;    // 頁面晚於 hardStop 才載回來時的續命寬限
  var MIN_RELOAD_ROOM_MS = 3500;  // 剩餘不足這麼多就別再發重載（載回來必死）

  // 配送偏好順序：逗號分隔關鍵字，越前面越優先。留空＝照 momo 頁面上的順序挑第一個。
  panel.appendChild(mk('div', { marginBottom: '4px', color: '#8b93a1' }, '配送偏好（逗號分隔，留空＝頁面順序）'));
  var $ship = mk('input', { width: '100%', marginBottom: '8px', padding: '4px', borderRadius: '6px', border: '1px solid #2a2f3a', background: '#0f1115', color: '#fff' });
  $ship.placeholder = '例如：i郵箱,超商,門市取貨';
  panel.appendChild($ship);

  // 上次開火的稽核紀錄（跨頁面保留，讓 buy 模式跳走後還能回查配送方式）
  var $audit = mk('div', { marginTop: '2px', marginBottom: '6px', fontSize: '12px', color: '#8b93a1', lineHeight: '1.4' });
  panel.appendChild($audit);

  var btnRow = mk('div', { display: 'flex', gap: '6px' });
  var $arm = mk('button', { flex: '1', border: '0', borderRadius: '8px', padding: '8px', fontWeight: '700', cursor: 'pointer', background: '#22c55e', color: '#04210f' }, '啟動');
  var $now = mk('button', { border: '0', borderRadius: '8px', padding: '8px', cursor: 'pointer', background: '#3b82f6', color: '#fff' }, '立即搶');
  btnRow.appendChild($arm); btnRow.appendChild($now);
  panel.appendChild(btnRow);

  var $status = mk('div', { marginTop: '8px', color: '#8b93a1' }, '未啟動');
  panel.appendChild($status);

  // 掛在最外層 <html>；被移除就自動補回
  function attachPanel() {
    if (!panel.isConnected && document.documentElement) document.documentElement.appendChild(panel);
  }
  attachPanel();
  setInterval(attachPanel, 1000);

  // ---- 還原/儲存設定 ----
  var st = load();
  if (st.mode) $mode.value = st.mode;
  if (typeof st.reload === 'boolean') $reload.checked = st.reload;
  if (st.pre !== undefined && st.pre !== null && st.pre !== '') $pre.value = st.pre;
  if (st.spec) $spec.value = st.spec;
  if (st.ship) $ship.value = st.ship;
  if (st.win !== undefined && st.win !== null && st.win !== '') $win.value = st.win;
  var d0 = new Date();
  $date.value = st.date || (d0.getFullYear() + '-' + pad(d0.getMonth() + 1) + '-' + pad(d0.getDate()));
  $time24.value = st.time24 || '12:00:00';
  function persist() { save({ date: $date.value, time24: $time24.value, mode: $mode.value, reload: $reload.checked, spec: $spec.value, pre: $pre.value, ship: $ship.value, win: $win.value }); }
  $date.onchange = persist; $time24.onchange = persist; $mode.onchange = persist; $reload.onchange = persist; $spec.onchange = persist; $pre.onchange = persist; $ship.onchange = persist; $win.onchange = persist;

  // ---- 開火稽核：把「實際點下去時選到的配送方式」寫進 localStorage ----
  // buy 模式會跳轉到結帳頁、腳本隨頁面卸載，沒有這筆紀錄就完全無從回查。
  // 昨天那份稽核只在「要點下去」時才寫，所以「重載了 N 次、始終沒出現按鈕」
  // 這個失敗模式完全不留痕跡，跟「根本沒啟動」在紀錄上長得一模一樣。
  // runLog 補這個洞：記錄每一場開火的開始、重載次數、有沒有看到按鈕、以及結束原因。
  var RUN = 'momoGrab.lastRun';
  function runLog(patch) {
    try {
      var cur = {};
      try { cur = JSON.parse(localStorage.getItem(RUN) || '{}'); } catch (e) {}
      for (var k in patch) cur[k] = patch[k];
      localStorage.setItem(RUN, JSON.stringify(cur));
      console.log('[momoGrab] runLog', cur);
    } catch (e) {}
  }
  function runEnd(outcome) {
    runLog({ outcome: outcome, endedAt: new Date().toISOString() });
  }

  var AUDIT = 'momoGrab.lastFire';
  function auditFire(rec) {
    try { localStorage.setItem(AUDIT, JSON.stringify(rec)); } catch (e) {}
    try { console.log('[momoGrab] 開火紀錄', rec); } catch (e) {}
  }
  (function showAudit() {
    var lines = [];
    var run = null; try { run = JSON.parse(localStorage.getItem(RUN) || 'null'); } catch (e) {}
    if (run && run.startedAt) {
      lines.push('🕘 上次開火場次 ' + String(run.startedAt).replace('T', ' ').slice(0, 19) +
                 '｜重載 ' + (run['重載次數'] || 0) + ' 次｜看到按鈕：' + (run['有看到按鈕'] ? '有' : '沒有') +
                 '｜結果：' + (run.outcome || '未知'));
    }
    var r = null; try { r = JSON.parse(localStorage.getItem(AUDIT) || 'null'); } catch (e) {}
    if (r) {
      lines.push(((r.cvsOK === true) ? '✅' : '⚠️') + ' 上次點擊 ' + (r.at || '').replace('T', ' ').slice(0, 19) +
                 '｜模式 ' + (r.mode === 'buy' ? '直接購買' : '放入購物車') +
                 '｜配送 ' + (r.delivery || '（未選到）'));
    }
    $audit.textContent = lines.join('\n');
    $audit.style.whiteSpace = 'pre-line';
    if (run && run['有看到按鈕'] === false && run.outcome && run.outcome !== 'running') {
      $audit.style.color = '#f59e0b';
    }
  })();

  // ---- 伺服器時間校準（區間交集法）----
  // 舊版：clockOffset = new Date(date標頭).getTime() - Date.now()
  //   兩個誤差同方向疊加，serverNow() 系統性「偏慢」0.5～1.0 秒：
  //   (a) HTTP Date 標頭只有「秒」精度 → 真實時間的小數部分（平均 500ms）被截掉
  //   (b) Date.now() 取在「收到回應」的瞬間，沒有扣掉回程延遲
  //   結果 left = targetTs - serverNow() 偏大 → 每次都比開賣晚 0.5～1 秒才開火。
  //
  // 新版：每個樣本推導出 offset 的一個「可能區間」，多個樣本取交集。
  //   請求發出 t0、收到回應 t1、標頭秒數 S（真實時間落在 [S, S+1000)）
  //   標頭必然產生於 [t0, t1] 之間，因此
  //       offset = 真實伺服器時間 - 本機時間 ∈ [S - t1, S + 1000 - t0)
  //   連續取樣、跨過一次「跳秒」之後，交集寬度會收斂到約等於 RTT。
  var clockLo = -Infinity, clockHi = Infinity;
  var clockOffset = 0;
  var clockErrMs = null;            // 目前對時精度（區間半寬）；null = 還沒對時

  function clockAddSample(t0, t1, headerMs) {
    var lo = headerMs - t1;
    var hi = headerMs + 1000 - t0;
    if (lo > clockLo) clockLo = lo;
    if (hi < clockHi) clockHi = hi;
    // 交集矛盾（本機時鐘被調整、或 NTP 跳動）→ 丟掉舊區間，以最新樣本重新開始
    if (clockLo >= clockHi) { clockLo = lo; clockHi = hi; }
    clockOffset = (clockLo + clockHi) / 2;
    clockErrMs = (clockHi - clockLo) / 2;
  }

  function clockProbe() {
    var t0 = Date.now();
    return fetch(location.href, { method: 'HEAD', cache: 'no-store' })
      .then(function (r) {
        var t1 = Date.now();
        var dd = r.headers.get('date');
        if (dd) { var ms = new Date(dd).getTime(); if (isFinite(ms)) clockAddSample(t0, t1, ms); }
      })
      .catch(function () {});
  }

  // 連續取樣，直到精度達標或用完次數（gap 要小於 1 秒才抓得到跳秒）
  function syncClockPrecise(maxProbes, gapMs, targetErrMs) {
    maxProbes = maxProbes || 18; gapMs = gapMs || 110; targetErrMs = targetErrMs || 60;
    var n = 0;
    function step() {
      if (n >= maxProbes) return Promise.resolve();
      n++;
      return clockProbe().then(function () {
        if (clockErrMs !== null && clockErrMs <= targetErrMs) return;
        return new Promise(function (res) { setTimeout(res, gapMs); }).then(step);
      });
    }
    return step();
  }
  function syncClock() { return syncClockPrecise(); }   // 舊呼叫點的相容別名
  function serverNow() { return Date.now() + clockOffset; }
  function clockLabel() {
    return clockErrMs === null ? '未對時' : ('已對時 ±' + Math.round(clockErrMs) + 'ms');
  }

  // 精確排程：以 serverNow() 為基準逼近目標時刻。
  // 遠距離用長 setTimeout（省電），最後 400ms 改用 15ms／4ms 短步進收尾。
  // 舊版靠 200ms 的 setInterval 觸發，平白多出 0～200ms 的抖動。
  // getTarget 傳函式而不是數值，這樣中途重新對時（offset 變動）會自動跟上。
  function scheduleAt(getTarget, fn) {
    var cancelled = false;
    function step() {
      if (cancelled) return;
      var left = getTarget() - serverNow();
      // 目標無效（NaN）時所有比較都是 false，會掉到最短的 4ms 分支無限空轉燒 CPU
      if (!isFinite(left)) { cancelled = true; return; }
      if (left <= 0) { fn(); return; }
      var delay = left > 2000 ? Math.min(left - 1000, 30000)
                : left > 400  ? left - 300
                : left > 60   ? 15
                : 4;
      setTimeout(step, delay);
    }
    step();
    return function () { cancelled = true; };
  }

  function findBtn(text) {
    var els = document.querySelectorAll('a,button');
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].textContent || '').trim();
      if (t.indexOf(text) !== -1 && els[i].offsetParent !== null) return els[i];
    }
    return null;
  }

  // 擬真點擊：momo 的「直接購買」對普通 .click() 可能沒反應，
  // 用完整的 pointer/mouse 事件序列模擬真實滑鼠點擊。
  function realClick(el) {
    try {
      var r = el.getBoundingClientRect();
      var x = r.left + r.width / 2, y = r.top + r.height / 2;
      ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
        var Ev = type.indexOf('pointer') === 0 ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ev(type, { bubbles: true, cancelable: true, view: window,
          clientX: x, clientY: y, button: 0, buttons: type === 'pointerdown' || type === 'mousedown' ? 1 : 0 }));
      });
    } catch (e) { try { el.click(); } catch (e2) {} }
  }

  // momo 會員登入視窗有沒有跳出來（直接購買需要登入；session 過期就會卡在這）
  function loginModalVisible() {
    var els = document.querySelectorAll('div,section,h2,img[alt]');
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].textContent || els[i].alt || '');
      if (t.indexOf('會員登入') !== -1 && els[i].offsetParent !== null) return true;
    }
    return false;
  }
  function cartCount() {
    var el = document.querySelector('#TopCart');
    var m = el ? (el.textContent || '').match(/\((\d+)\)/) : null;
    return m ? parseInt(m[1], 10) : 0;
  }
  function setStatus(s) { $status.textContent = s; }

  // momo 規格按鈕（款式）：box-border + cursor-pointer + border-[#...]
  function specButtons() {
    return [].slice.call(document.querySelectorAll('button')).filter(function (b) {
      var c = (b.className || '').toString();
      return /box-border/.test(c) && /cursor-pointer/.test(c) && /border-\[#/.test(c) &&
             b.offsetParent !== null && (b.textContent || '').trim().length > 0;
    });
  }
  // 這個規格看起來被選中了嗎？（momo 選中的規格外框會變色/加粗）
  function specChosen() {
    var btns = specButtons();
    for (var i = 0; i < btns.length; i++) {
      var c = (btns[i].className || '').toString();
      if (/border-\[#(d|e|f)?[0-9a-f]*\]/i.test(c) && /font-bold|border-2|text-\[#d/i.test(c)) return true;
      if (btns[i].getAttribute('aria-selected') === 'true') return true;
    }
    return false;
  }

  // 買之前選規格。
  // 有填款式名 → 選那一個；沒填 → 自動選第一個可選規格。
  // （舊版在款式留空時完全不動，遇到多款式商品就會一直跳「請先選擇商品規格」而失敗。）
  function selectSpec() {
    var btns = specButtons();
    if (!btns.length) return true;              // 無規格商品，免選
    var want = ($spec.value || '').trim();
    var pick = want
      ? btns.filter(function (b) { return (b.textContent || '').trim().indexOf(want) !== -1; })[0]
      : btns[0];                                 // 沒填就選第一個
    if (pick) { realClick(pick); }
    return true;
  }

  // 關掉會擋住操作的提示視窗（「請先選擇商品規格」「直接購買失敗」等）
  function dismissModal() {
    var texts = ['請先選擇商品規格', '直接購買失敗', '加入購物車失敗'];
    var hit = [].slice.call(document.querySelectorAll('div,p,span')).filter(function (e) {
      var t = (e.textContent || '').trim();
      return texts.indexOf(t) !== -1 && e.offsetParent !== null;
    })[0];
    if (!hit) return false;
    var ok = findBtn('確定');
    if (ok) { realClick(ok); return true; }
    return false;
  }

  // 配送方式鎖定「超商/i郵箱/myfone 門市取貨」，避免預設的「快速到貨」。
  // （門市/取貨店家仍需你在結帳頁自己挑選並付款。）
  // momo 的購物車是「依配送方式分開」的：快速到貨和超商取貨是兩台不同的車。
  // 選錯就會進錯車，所以這裡點完會再確認一次真的選中。
  var CVS_RE = /超商|門市取貨|i郵箱/;

  // 讀出頁面上所有配送選項；還沒渲染出來回 null（跟「有選項但都不是取貨」區分開）
  function deliveryOptions() {
    var radios = document.querySelectorAll('input[type=radio][name="delivery"]');
    if (!radios.length) return null;              // 還沒渲染出來
    var out = [];
    for (var i = 0; i < radios.length; i++) {
      var box = radios[i].closest('label') || radios[i].parentElement || radios[i];
      out.push({ radio: radios[i], box: box, text: (box.textContent || '').replace(/\s+/g, ' ').trim() });
    }
    return out;
  }

  function shipPrefs() {
    return ($ship.value || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  }

  // 目前實際勾選的配送方式文字（沒選到／還沒渲染回 null）
  function currentDeliveryText() {
    var opts = deliveryOptions();
    if (!opts) return null;
    var on = opts.filter(function (o) { return o.radio.checked; })[0];
    return on ? on.text : null;
  }

  function selectDelivery() {
    var opts = deliveryOptions();
    if (opts === null) return null;               // 還沒渲染出來 → 呼叫端要當成「還不能開火」
    var cvs = opts.filter(function (o) { return CVS_RE.test(o.text); });
    if (!cvs.length) return false;                // 這個商品沒有超商／i郵箱／門市取貨
    // 依「配送偏好」由前往後找第一個命中的；偏好都沒命中就用頁面上的第一個取貨選項
    var pick = null, prefs = shipPrefs();
    for (var p = 0; p < prefs.length && !pick; p++) {
      var kw = prefs[p];
      pick = cvs.filter(function (o) { return o.text.indexOf(kw) !== -1; })[0] || null;
    }
    if (!pick) pick = cvs[0];
    if (!pick.radio.checked) {
      try { pick.radio.click(); } catch (e) {}
      if (!pick.radio.checked) realClick(pick.box);       // 備援：擬真點擊外框
      if (!pick.radio.checked) realClick(pick.radio);     // 再備援：點 radio 本身
    }
    return pick.radio.checked;                    // true=確定選到取貨，false=點了還是沒中
  }

  // 目前選的是不是超商取貨？（給結束時的提示用）
  function deliveryIsCvs() {
    var t = currentDeliveryText();
    if (t === null) return null;
    return CVS_RE.test(t);
  }

  function clickTarget() {
    selectSpec();       // 先選規格，避免「請先選擇商品規格」
    selectDelivery();   // 鎖定超商取貨（不要快速到貨）
    var btn = ($mode.value === 'buy') ? (findBtn('直接購買') || findBtn('立即購買')) : findBtn('放入購物車');
    if (btn) { realClick(btn); return true; }
    return false;
  }

  // 重載時強制不吃快取：在網址加上一個會變動的 _r 參數再導頁。
  // （熱門開賣時 momo/CDN 常回舊的「開賣通知」快取頁，是搶不到的主因。）
  function cacheBustReload() {
    try {
      var u = new URL(location.href);
      u.searchParams.set('_r', Date.now().toString());
      location.href = u.toString();
    } catch (e) { location.reload(); }
  }

  function fireLoop() {
    var info = {}; try { info = JSON.parse(sessionStorage.getItem(SS) || '{}'); } catch (e) {}
    // hardStop＝整場嘗試的絕對截止時刻。重載會沿用同一個值（不會每次重刷就重新計時），
    // 並且可由面板「開火窗口」設定，不再硬寫 60 秒。info.deadline 是舊格式，保留相容。
    var hardStop = info.hardStop || info.deadline || (Date.now() + fireWindowMs());
    var holdUntil = info.holdUntil || 0;   // 預刷後要等到這個時間點才開火（0＝立刻）
    var startN = cartCount();
    var lastReload = Date.now();
    var fireStart = Date.now();
    var lastBuy = 0;       // 上次點「直接購買」的時間（點一下等 1.8 秒，不狂點）
    var buyFails = 0;      // 「直接購買失敗」次數（自動關窗重試，最多 3 次）
    setStatus('🔥 開火中…');
    runLog({
      startedAt: (info.runStartedAt || new Date().toISOString()),
      url: location.href, mode: $mode.value,
      窗口剩餘秒: Math.round((hardStop - Date.now()) / 1000),
      重載次數: (info.reloads || 0), 有看到按鈕: false, outcome: 'running', endedAt: null
    });
    var reloads = info.reloads || 0;
    var runStartedAt = info.runStartedAt || new Date().toISOString();
    var iv = setInterval(function () {
      if (Date.now() > hardStop) {
        clearInterval(iv); sessionStorage.removeItem(SS);
        runEnd('窗口用盡（' + Math.round(fireWindowMs() / 1000) + ' 秒內始終沒出現可買按鈕）');
        setStatus('結束（開火窗口 ' + Math.round(fireWindowMs() / 1000) + ' 秒用盡），可手動再按「立即搶」。');
        $status.style.color = '#f59e0b'; $status.style.fontWeight = '700';
        return;
      }
      // 預刷完成、還沒到開賣時間 → 頁面已是最新，原地待命，不要提早點下去
      if (holdUntil && Date.now() < holdUntil) {
        setStatus('⚡ 已預刷完成，待命中… ' + ((holdUntil - Date.now()) / 1000).toFixed(1) + ' 秒後開火');
        return;
      }
      // 已加入購物車：momo 會跳「已加入購物車!」提示視窗，看到就算成功
      var addedModal = [].slice.call(document.querySelectorAll('div,p,span')).filter(function (e) {
        var t = (e.textContent || '').trim();
        return t.length < 24 && /已加入購物車/.test(t) && e.getBoundingClientRect().width > 0;
      })[0];
      if (cartCount() > startN || addedModal) {
        clearInterval(iv); sessionStorage.removeItem(SS);
        var cvs = deliveryIsCvs();
        if (cvs === false) {
          setStatus('⚠️ 已加入，但配送是「快速到貨」！請到購物車改成超商取貨');
          $status.style.color = '#ef4444'; $status.style.fontWeight = '700';
        } else {
          runEnd('成功加入購物車');
          setStatus('✅ 已加入購物車（超商取貨）');
        }
        var ok = findBtn('確定');
        if (ok) realClick(ok);                       // 關掉提示視窗
        // 只有最後一件才開購物車（儀表板會在最後一件帶 mgcart=1）
        if (/[?&]mgcart=1\b/.test(location.search)) {
          setTimeout(function () {
            var top = document.querySelector('#TopCart');
            if (top) realClick(top);
            setStatus('🛒 已開啟購物車，請確認後結帳');
          }, 1200);
        }
        return;
      }
      // 跳出「會員登入」＝session 過期／未登入 → 直接購買會卡死，大聲提醒
      if (loginModalVisible()) {
        setStatus('❌ momo 未登入！請立刻在此視窗登入，登入後再按「立即搶」');
        $status.style.color = '#ef4444'; $status.style.fontWeight = '700';
        return;
      }
      // 先關掉擋住操作的提示視窗（請先選擇商品規格 等）
      dismissModal();
      // 「直接購買失敗」視窗：自動關掉→短暫等待→重試（最多 3 次）
      var failEl = [].slice.call(document.querySelectorAll('div,p,span')).filter(function (e) {
        return (e.textContent || '').trim() === '直接購買失敗' && e.offsetParent !== null;
      })[0];
      if (failEl) {
        buyFails++;
        var okBtn = findBtn('確定'); if (okBtn) realClick(okBtn);
        if (buyFails >= 3) {
          clearInterval(iv); sessionStorage.removeItem(SS);
          runEnd('直接購買失敗×3');
          setStatus('❌ 直接購買失敗×3。最可能：商品已在購物車 或 已下單過（每人限購1組僅限1次）。請開購物車直接結帳／查訂單確認。');
          $status.style.color = '#ef4444'; $status.style.fontWeight = '700';
          return;
        }
        lastBuy = Date.now() - 1200;   // 關窗後稍等 0.6 秒再重試
        setStatus('⚠️ 直接購買失敗（第 ' + buyFails + ' 次），關閉視窗重試…');
        return;
      }
      var buyBtn = ($mode.value === 'buy') ? (findBtn('直接購買') || findBtn('立即購買')) : findBtn('放入購物車');
      if (buyBtn) {
        runLog({ 有看到按鈕: true, 按鈕出現時間: new Date().toISOString() });
        // 先把配送鎖成超商取貨（momo 快速到貨/超商取貨是兩台不同的購物車）。
        // 最多等 2 秒；真的選不到就還是照搶，但會標紅＋寫稽核紀錄提醒你自己改。
        // 注意用 !== true：selectDelivery() 在配送區塊還沒渲染時回 null，
        // 舊版寫 === false 會漏掉這個情況 → 配送一個都沒選就把「直接購買」點下去。
        var cvsOK = selectDelivery();
        if (cvsOK !== true && Date.now() - fireStart < 2000) return;
        // 點一下→等 1.8 秒看結果，不狂點（連環點會觸發「直接購買失敗」）
        if (Date.now() - lastBuy > 1800) {
          selectSpec();
          cvsOK = selectDelivery();          // 選規格後再確認一次取貨（規格會重繪配送區塊）
          var dText = currentDeliveryText();
          auditFire({ at: new Date().toISOString(), url: location.href, mode: $mode.value,
                      cvsOK: cvsOK, delivery: dText, attempt: buyFails + 1 });
          realClick(buyBtn);                 // 擬真點擊（普通 .click() 對直接購買可能無效）
          lastBuy = Date.now();
          if (cvsOK !== true) {
            setStatus('🚨 已按下購買，但配送不是取貨（' + (dText || '未選到') + '）！結帳頁務必自己改');
            $status.style.color = '#ef4444'; $status.style.fontWeight = '700';
          } else {
            setStatus('✅ 已按下購買（第 ' + (buyFails + 1) + ' 次）｜配送 ' + dText + '，等待結果…');
          }
        }
      } else if ($reload.checked && (Date.now() - lastReload) > 2000) {
        // 還沒開賣（只有「開賣通知/貨到通知」）→ 每 2 秒重刷。
        // 關鍵：用時間戳強制不吃快取，否則 momo/CDN 會一直餵舊的「開賣通知」頁。
        // 剩餘時間不夠讓頁面載回來就別發了 —— 否則載回來時已過期，交接失敗＝靜默放棄。
        if (hardStop - Date.now() < MIN_RELOAD_ROOM_MS) {
          clearInterval(iv); sessionStorage.removeItem(SS);
          runEnd('剩餘時間不足，停止重載（始終沒出現可買按鈕）');
          setStatus('結束（剩餘時間不足，不再重載），可手動再按「立即搶」。');
          $status.style.color = '#f59e0b'; $status.style.fontWeight = '700';
          return;
        }
        lastReload = Date.now();
        reloads++;
        runLog({ 重載次數: reloads });
        sessionStorage.setItem(SS, JSON.stringify({
          hardStop: hardStop, mode: $mode.value, reloads: reloads, runStartedAt: runStartedAt
        }));
        setStatus('🔄 重新整理搶最新狀態…');
        cacheBustReload();
      }
    }, 150);
  }

  function fireNow() {
    if ($reload.checked) {
      sessionStorage.setItem(SS, JSON.stringify({ hardStop: Date.now() + fireWindowMs(), mode: $mode.value }));
      cacheBustReload();
    } else { fireLoop(); }
  }

  var armed = false, timer = null, cancelPre = null, cancelFire = null;
  // 開賣時間正規化：接受 "7"、"07"、"7:0"、"07:00"、"07:00:00"，一律補成 HH:MM:SS。
  // 無法解析回 null（呼叫端要當成錯誤處理，不要讓它變成 NaN 在系統裡流竄）。
  function normTime(tv) {
    tv = (tv || '').trim();
    var m = tv.match(/^(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?$/);
    if (!m) return null;
    var h = +m[1], mi = +(m[2] || 0), s = +(m[3] || 0);
    if (h > 23 || mi > 59 || s > 59) return null;
    return pad(h) + ':' + pad(mi) + ':' + pad(s);
  }
  function targetTs() {
    var dv = ($date.value || '').trim();
    var tv = normTime($time24.value);
    if (!dv || !tv) return NaN;
    var ts = new Date(dv.replace(/-/g, '/') + ' ' + tv).getTime();
    return isFinite(ts) ? ts : NaN;
  }
  // 開火目標刻意往後推一點點：太早送出會拿到預售頁（賠掉一整次重載），
  // 太晚只賠這幾十毫秒。對時精度收斂到 ±50ms 之後，這個餘裕才有意義。
  var FIRE_SAFETY_MS = 80;
  function fireTargetTs() { return targetTs() + FIRE_SAFETY_MS; }

  function armCancelAll() {
    if (timer) { clearInterval(timer); timer = null; }
    if (cancelPre) { cancelPre(); cancelPre = null; }
    if (cancelFire) { cancelFire(); cancelFire = null; }
  }

  function arm() {
    armed = true; persist(); $arm.textContent = '停止'; $arm.style.background = '#ef4444'; $arm.style.color = '#fff';
    // 布署時先檢查登入：頁面右上有「登入」連結＝還沒登入 → 開賣時直接購買會被登入牆擋下
    try {
      var notLogged = [].slice.call(document.querySelectorAll('a')).some(function (a) {
        return (a.textContent || '').trim() === '登入' && a.offsetParent !== null;
      });
      if (notLogged) {
        setStatus('⚠️ 看起來尚未登入 momo！請先登入再等開賣，否則直接購買會被登入牆擋住');
        $status.style.color = '#f59e0b'; $status.style.fontWeight = '700';
      }
    } catch (e) {}

    // 時間無效就別假裝啟動了 —— 舊版會一路算出 NaN，面板顯示「倒數 NaN:NaN:NaN」
    // 而且因為 NaN 的比較永遠是 false，它會安靜地永遠不開火。
    if (!isFinite(targetTs())) {
      armed = false; $arm.textContent = '啟動';
      $arm.style.background = '#22c55e'; $arm.style.color = '#04210f';
      setStatus('⛔ 開賣時間無效：日期「' + $date.value + '」時間「' + $time24.value +
                '」無法解析。請填成 HH:MM:SS（例如 07:00:00）再按啟動。');
      $status.style.color = '#ef4444'; $status.style.fontWeight = '700';
      return;
    }

    armCancelAll();
    var acted = false, resynced = false;
    function resetBtn() {
      armed = false; $arm.textContent = '啟動';
      $arm.style.background = '#22c55e'; $arm.style.color = '#04210f';
    }
    function actPre() {
      if (acted) return;
      var preMs = preLeadMs();
      if (!$reload.checked || preMs <= 0) return;    // 不預刷 → 由 actFire 在整點處理
      acted = true;
      var left = fireTargetTs() - serverNow();
      armCancelAll(); resetBtn();
      sessionStorage.setItem(SS, JSON.stringify({
        hardStop: Date.now() + left + fireWindowMs(),   // 從開賣時刻起算整個窗口
        holdUntil: Date.now() + left,
        mode: $mode.value
      }));
      setStatus('⚡ 預刷中（開賣前 ' + (left / 1000).toFixed(1) + ' 秒｜' + clockLabel() + '）…');
      cacheBustReload();
    }
    function actFire() {
      if (acted) return;
      acted = true; armCancelAll(); resetBtn();
      fireNow();
    }

    // 先把時鐘校準好再排程（取樣約 1～2 秒），否則排程本身就是錯的
    setStatus('對時中…');
    syncClockPrecise().then(function () {
      if (!armed || acted) {
        // 對時期間就已經過了開賣時刻（或使用者按了停止）
        if (armed && !acted && fireTargetTs() - serverNow() <= 0) actFire();
        return;
      }
      // 精確排程：這兩個才是真正的觸發者
      cancelPre = scheduleAt(function () { return fireTargetTs() - preLeadMs(); }, actPre);
      cancelFire = scheduleAt(fireTargetTs, actFire);
      // 200ms interval 只負責顯示倒數＋中途重新對時；
      // 同時保留為保險：萬一 setTimeout 鏈被瀏覽器殺掉，它還能補觸發（acted 會擋重複）
      timer = setInterval(function () {
        var left = fireTargetTs() - serverNow();
        if (!isFinite(left)) {
          armCancelAll(); resetBtn();
          setStatus('⛔ 開賣時間變成無效，已停止。請修正時間欄位後重新按啟動。');
          $status.style.color = '#ef4444'; $status.style.fontWeight = '700';
          return;
        }
        if (left <= 0) { actFire(); return; }
        var preMs = preLeadMs();
        if ($reload.checked && preMs > 0 && left <= preMs) { actPre(); return; }
        if (!resynced && left < 20000 && left > 15000) { resynced = true; syncClockPrecise(10, 90, 40); }
        var s = Math.floor(left / 1000);
        setStatus('倒數 ' + pad(Math.floor(s / 3600)) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60) + '（' + clockLabel() + '）');
      }, 200);
    });
  }
  function disarm() { armCancelAll(); armed = false; $arm.textContent = '啟動'; $arm.style.background = '#22c55e'; $arm.style.color = '#04210f'; setStatus('已停止'); }

  $arm.onclick = function () { armed ? disarm() : arm(); };
  // 立即搶＝用當下畫面的選擇直接下手，不刷新（刷新只給排程開賣用，避免清掉你選好的款式/取貨）
  $now.onclick = function () { persist(); fireLoop(); };

  // 若剛才「開火中」被刷新回來，接手狂點（此時就別再跑下面的 combo 重新 arm）
  var firingResumed = false;
  (function () {
    var info = null; try { info = JSON.parse(sessionStorage.getItem(SS) || 'null'); } catch (e) {}
    var stop = info ? (info.hardStop || info.deadline || 0) : 0;
    // 寬限期：重載「發出時」還在窗口內，但頁面「載回來時」已超過 hardStop。
    // 舊版在這裡直接判 false → fireLoop() 從未啟動 → 畫面上明明有「直接購買」卻沒人點；
    // 而逾時訊息寫在 fireLoop 裡面，所以連一句提示都沒有。8/15 UX-20 就是這樣掉的。
    if (info && Date.now() < stop + RESUME_GRACE_MS) {
      firingResumed = true;
      if (info.mode) $mode.value = info.mode;
      if (Date.now() >= stop) {
        info.hardStop = Date.now() + RESUME_GRACE_MS;   // 續命，至少讓它點得到一次
        delete info.deadline;
        try { sessionStorage.setItem(SS, JSON.stringify(info)); } catch (e) {}
        setStatus('⚠️ 頁面載回來時窗口已過期 → 啟用寬限期續命 ' + (RESUME_GRACE_MS / 1000) + ' 秒');
      }
      fireLoop();
    }
  })();

  // combo：儀表板開啟本頁並帶暗號（開火中被重載回來時跳過，避免無限重載）
  //   ?mgauto=1&mgtime=2026-07-31T11:00:00 → 官方預售，準點搶
  //   ?mgauto=1（無 mgtime）           → 已開賣，立即搶
  //   &mgmode=buy   → 準點用「直接購買（最快）」
  //   &mgmode=cart  → 準點用「放入購物車（較穩）」；未指定時沿用 cart
  //   &mgpre=3      → 開賣前 3 秒先預刷頁面，到整點才開火（0＝不預刷）
  //   &mgship=i郵箱,超商 → 配送偏好順序（逗號分隔，需 URL encode）
  //   &mgwin=180    → 開火窗口秒數（從開賣起算最多嘗試多久）
  if (!firingResumed && /[?&]mgauto=1\b/.test(location.search)) {
    // 預設「放入購物車」：可以累積多件、最後一起結帳，也比直接購買穩定。
    // 用 &mgmode=buy 可在網址層改成搶最快的「直接購買」，或在面板手動切換。
    var mm = (location.search.match(/[?&]mgmode=(buy|cart)\b/) || [])[1];
    $mode.value = (mm === 'buy') ? 'buy' : 'cart';
    var mp = (location.search.match(/[?&]mgpre=([0-9.]+)/) || [])[1];
    if (mp) { $pre.value = mp; if (parseFloat(mp) > 0) $reload.checked = true; }
    var ms = (location.search.match(/[?&]mgship=([^&]+)/) || [])[1];
    if (ms) { try { $ship.value = decodeURIComponent(ms); } catch (e) { $ship.value = ms; } }
    var mw = (location.search.match(/[?&]mgwin=(\d+)/) || [])[1];
    if (mw) $win.value = mw;
    persist();
    // momo 會把 /goods/GoodsDetail.jsp?i_code=... 轉址成 /product/{id}?...，
    // 轉址過程中 mgtime 的冒號被百分比編碼成 %3A。
    // 舊寫法 [0-9T:\-]+ 不含 %，會在第一個 %3A 截斷 →「2026-08-15T07」→ $time24='07'
    // → new Date('2026/08/15 07') = Invalid Date → targetTs() = NaN → 永遠不開火。
    // （同一段裡 mgship 用的就是 [^&]+ + decodeURIComponent，這裡漏掉了。）
    var mtRaw = (location.search.match(/[?&]mgtime=([^&]+)/) || [])[1];
    var mt = null;
    if (mtRaw) { try { mt = decodeURIComponent(mtRaw); } catch (e) { mt = mtRaw; } }
    if (mt && mt.indexOf('T') !== -1) {
      var parts = mt.split('T');
      $date.value = parts[0];
      $time24.value = normTime(parts[1]) || parts[1] || '11:00:00';
      persist();
      setStatus('⏰ 已排程準點搶：' + mt);
      arm();                       // 對時＋倒數，到點自動開火
    } else {
      setStatus('🔥 儀表板觸發，立即搶購中…');
      setTimeout(fireLoop, 600);
    }
  }

})();
