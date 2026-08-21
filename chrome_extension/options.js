/* 設定畫面：取代 Python 版的 config 資料夾與儀表板 */

const STORES = [
  { key: 'funbox', name: '🧸 Funbox',
    hint: '一行一個型號或商品名，例如 UX-04。偵測到有貨會開商品頁自動加入購物車。' },
  { key: 'eslite', name: '📚 誠品',
    hint: '一行一個關鍵字。誠品是綜合書店，關鍵字要夠精確（例如「戰鬥陀螺 UX-04」而不是只寫 UX-04）。' },
  { key: 'momo', name: '🛍️ momo',
    hint: '一行一個「商品編號」或直接貼商品網址。momo 搜尋會撈到溢價賣家，所以固定鎖商品編號。' },
  { key: 'tcsb', name: '🪜 墊腳石',
    hint: '一行一個關鍵字；也可以貼商品網址或條碼（例如 9789863128915）精準鎖定單一商品。' }
];

// momo 的目標存成 {name, i_code}，畫面上用一行一個字串呈現
function momoToLines(targets) {
  return (targets || []).map(t => (typeof t === 'string' ? t : (t.i_code || ''))).join('\n');
}
function linesToMomo(text) {
  return text.split('\n').map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/i_code=(\d+)/) || s.match(/\/product\/(\d+)/);
    const ic = m ? m[1] : s;
    return { name: ic, i_code: ic };
  });
}

async function load() {
  const { cfg = {} } = await chrome.storage.local.get('cfg');
  const wrap = document.getElementById('stores');
  wrap.innerHTML = '';

  STORES.forEach(s => {
    const c = cfg[s.key] || { enabled: true, auto: true, targets: [] };
    const box = document.createElement('div');
    box.className = 'store';

    const lines = s.key === 'momo' ? momoToLines(c.targets)
                                   : (c.targets || []).join('\n');

    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML =
      '<span class="name">' + s.name + '</span>' +
      '<label class="sw"><input type="checkbox" data-k="' + s.key + '" data-f="enabled"' +
        (c.enabled !== false ? ' checked' : '') + '> 偵測這家</label>' +
      '<label class="sw"><input type="checkbox" data-k="' + s.key + '" data-f="auto"' +
        (c.auto !== false ? ' checked' : '') + '> 有貨自動加入購物車</label>';

    const ta = document.createElement('textarea');
    ta.dataset.k = s.key;
    ta.value = lines;

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = s.hint;

    box.appendChild(row); box.appendChild(ta); box.appendChild(hint);
    wrap.appendChild(box);
  });
}

async function save() {
  const { cfg = {} } = await chrome.storage.local.get('cfg');
  const next = Object.assign({ pollMinutes: 1, notify: true }, cfg);

  STORES.forEach(s => {
    const ta = document.querySelector('textarea[data-k="' + s.key + '"]');
    const en = document.querySelector('input[data-k="' + s.key + '"][data-f="enabled"]');
    const au = document.querySelector('input[data-k="' + s.key + '"][data-f="auto"]');
    const raw = ta.value;
    next[s.key] = {
      enabled: en.checked,
      auto: au.checked,
      targets: s.key === 'momo' ? linesToMomo(raw)
                                : raw.split('\n').map(x => x.trim()).filter(Boolean)
    };
  });

  await chrome.storage.local.set({ cfg: next });
  status('✅ 已儲存');
}

function status(msg) {
  const el = document.getElementById('status');
  el.textContent = msg;
  setTimeout(() => { el.textContent = ''; }, 2500);
}

document.getElementById('save').addEventListener('click', save);
document.getElementById('now').addEventListener('click', async () => {
  await save();
  status('偵測中…');
  chrome.runtime.sendMessage({ type: 'pollNow' }, () => status('✅ 偵測完成'));
});

load();
