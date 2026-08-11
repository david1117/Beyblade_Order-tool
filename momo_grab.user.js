// ==UserScript==
// @name         momo 準點搶購（Beyblade 等限時開賣）
// @namespace    funbox-tools.local
// @version      2.0
// @description  在 momo 商品頁設定開賣時間，準點自動「直接購買 / 放入購物車」，可開賣前自動刷新再狂點。支援儀表板 combo：?mgauto=1&mgtime=ISO 會自動填入開賣時間並準點搶；無 mgtime 則立即搶。付款與最後送出仍由你本人操作。
// @match        https://www.momoshop.com.tw/goods/GoodsDetail.jsp*
// @match        https://www.momoshop.com.tw/product/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

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
  if (st.spec) $spec.value = st.spec;
  var d0 = new Date();
  $date.value = st.date || (d0.getFullYear() + '-' + pad(d0.getMonth() + 1) + '-' + pad(d0.getDate()));
  $time24.value = st.time24 || '12:00:00';
  function persist() { save({ date: $date.value, time24: $time24.value, mode: $mode.value, reload: $reload.checked, spec: $spec.value }); }
  $date.onchange = persist; $time24.onchange = persist; $mode.onchange = persist; $reload.onchange = persist; $spec.onchange = persist;

  // ---- 伺服器時間校準 ----
  var clockOffset = 0;
  function syncClock() {
    return fetch(location.href, { method: 'HEAD', cache: 'no-store' })
      .then(function (r) { var dd = r.headers.get('date'); if (dd) clockOffset = new Date(dd).getTime() - Date.now(); })
      .catch(function () {});
  }
  function serverNow() { return Date.now() + clockOffset; }

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
  function selectDelivery() {
    var radios = document.querySelectorAll('input[type=radio][name="delivery"]');
    for (var i = 0; i < radios.length; i++) {
      var box = radios[i].closest('label') || radios[i].parentElement || radios[i];
      if (/超商|門市取貨|i郵箱/.test(box.textContent || '')) {
        if (!radios[i].checked) { try { radios[i].click(); } catch (e) {} }
        return true;
      }
    }
    return false;
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
    // 撐 60 秒；熱門搶購頁面可能慢幾秒才翻可買，期間持續重刷直到抓到「直接購買」
    var deadline = info.deadline || (Date.now() + 60000);
    var startN = cartCount();
    var lastReload = Date.now();
    var lastBuy = 0;       // 上次點「直接購買」的時間（點一下等 1.8 秒，不狂點）
    var buyFails = 0;      // 「直接購買失敗」次數（自動關窗重試，最多 3 次）
    setStatus('🔥 開火中…');
    var iv = setInterval(function () {
      if (Date.now() > deadline) { clearInterval(iv); sessionStorage.removeItem(SS); setStatus('結束（逾時），可手動再按「立即搶」。'); return; }
      // 已加入購物車：momo 會跳「已加入購物車!」提示視窗，看到就算成功
      var addedModal = [].slice.call(document.querySelectorAll('div,p,span')).filter(function (e) {
        var t = (e.textContent || '').trim();
        return t.length < 24 && /已加入購物車/.test(t) && e.getBoundingClientRect().width > 0;
      })[0];
      if (cartCount() > startN || addedModal) {
        clearInterval(iv); sessionStorage.removeItem(SS);
        setStatus('✅ 已加入購物車');
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
        // 點一下→等 1.8 秒看結果，不狂點（連環點會觸發「直接購買失敗」）
        if (Date.now() - lastBuy > 1800) {
          selectSpec(); selectDelivery();   // 選規格＋鎖定超商取貨
          realClick(buyBtn);                 // 擬真點擊（普通 .click() 對直接購買可能無效）
          lastBuy = Date.now();
          setStatus('✅ 已按下購買（第 ' + (buyFails + 1) + ' 次），等待結果…');
        }
      } else if ($reload.checked && (Date.now() - lastReload) > 2000) {
        // 還沒開賣（只有「開賣通知/貨到通知」）→ 每 2 秒重刷。
        // 關鍵：用時間戳強制不吃快取，否則 momo/CDN 會一直餵舊的「開賣通知」頁。
        lastReload = Date.now();
        sessionStorage.setItem(SS, JSON.stringify({ deadline: deadline, mode: $mode.value }));
        setStatus('🔄 重新整理搶最新狀態…');
        cacheBustReload();
      }
    }, 150);
  }

  function fireNow() {
    if ($reload.checked) {
      sessionStorage.setItem(SS, JSON.stringify({ deadline: Date.now() + 60000, mode: $mode.value }));
      cacheBustReload();
    } else { fireLoop(); }
  }

  var armed = false, timer = null;
  function targetTs() {
    var dv = ($date.value || '').trim();
    var tv = ($time24.value || '').trim();
    if (!dv || !tv) return 0;
    if (/^\d{1,2}:\d{2}$/.test(tv)) tv += ':00';   // 允許只填 HH:MM
    return new Date(dv.replace(/-/g, '/') + ' ' + tv).getTime();
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
    syncClock();
    if (timer) clearInterval(timer);
    timer = setInterval(function () {
      var left = targetTs() - serverNow();
      if (left <= 0) { clearInterval(timer); timer = null; armed = false; $arm.textContent = '啟動'; $arm.style.background = '#22c55e'; $arm.style.color = '#04210f'; fireNow(); return; }
      if (left < 20000 && left > 19000) syncClock();
      var s = Math.floor(left / 1000);
      setStatus('倒數 ' + pad(Math.floor(s / 3600)) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60) + '（已對時）');
    }, 200);
  }
  function disarm() { armed = false; if (timer) clearInterval(timer); timer = null; $arm.textContent = '啟動'; $arm.style.background = '#22c55e'; $arm.style.color = '#04210f'; setStatus('已停止'); }

  $arm.onclick = function () { armed ? disarm() : arm(); };
  // 立即搶＝用當下畫面的選擇直接下手，不刷新（刷新只給排程開賣用，避免清掉你選好的款式/取貨）
  $now.onclick = function () { persist(); fireLoop(); };

  // 若剛才「開火中」被刷新回來，接手狂點（此時就別再跑下面的 combo 重新 arm）
  var firingResumed = false;
  (function () {
    var info = null; try { info = JSON.parse(sessionStorage.getItem(SS) || 'null'); } catch (e) {}
    if (info && Date.now() < (info.deadline || 0)) { firingResumed = true; if (info.mode) $mode.value = info.mode; fireLoop(); }
  })();

  // combo：儀表板開啟本頁並帶暗號（開火中被重載回來時跳過，避免無限重載）
  //   ?mgauto=1&mgtime=2026-07-31T11:00:00 → 官方預售，準點搶
  //   ?mgauto=1（無 mgtime）           → 已開賣，立即搶
  if (!firingResumed && /[?&]mgauto=1\b/.test(location.search)) {
    // 預設「放入購物車」：可以累積多件、最後一起結帳，也比直接購買穩定。
    // 想改回搶最快的「直接購買」，把下面 'cart' 改成 'buy'，或在面板手動切換。
    $mode.value = 'cart'; persist();
    var mt = (location.search.match(/[?&]mgtime=([0-9T:\-]+)/) || [])[1];
    if (mt && mt.indexOf('T') !== -1) {
      var parts = mt.split('T');
      $date.value = parts[0];
      $time24.value = parts[1] || '11:00:00';
      persist();
      setStatus('⏰ 已排程準點搶：' + mt);
      arm();                       // 對時＋倒數，到點自動開火
    } else {
      setStatus('🔥 儀表板觸發，立即搶購中…');
      setTimeout(fireLoop, 600);
    }
  }

})();
