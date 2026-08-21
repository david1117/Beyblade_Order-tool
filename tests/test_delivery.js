// 用 jsdom 真跑一次 selectDelivery / 守衛邏輯，驗證四個修正點
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'momo_grab.user.js');

const src = fs.readFileSync(SRC, 'utf8');

function extract(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let d = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { d++; started = true; }
    else if (src[j] === '}') { d--; if (started && d === 0) return src.slice(i, j + 1); }
  }
}

const CVS_RE_SRC = src.match(/var CVS_RE = (\/[^\n]+?\/);/)[1];

function makePage(options) {
  const rows = options.map((t, i) =>
    `<label><input type="radio" name="delivery" value="${i}"${options.checkedIndex === i ? ' checked' : ''}>${t}</label>`
  ).join('');
  const dom = new JSDOM(`<body><div id="d">${rows}</div></body>`);
  return dom.window;
}

function run(label, optionTexts, shipPref, preChecked) {
  const win = makePage(optionTexts);
  const document = win.document;
  const radios = document.querySelectorAll('input[name=delivery]');
  if (preChecked != null && radios[preChecked]) radios[preChecked].checked = true;

  const $ship = { value: shipPref || '' };
  const realClick = (el) => {
    const r = el.tagName === 'INPUT' ? el : el.querySelector('input');
    if (r) r.checked = true;
  };
  const ctx = { document, $ship, realClick, CVS_RE: null };

  const body = `
    ${CVS_RE_SRC.replace(/^/, 'var CVS_RE = ')};
    ${extract('deliveryOptions')}
    ${extract('shipPrefs')}
    ${extract('currentDeliveryText')}
    ${extract('selectDelivery')}
    ${extract('deliveryIsCvs')}
    return { selectDelivery: selectDelivery, currentDeliveryText: currentDeliveryText, deliveryIsCvs: deliveryIsCvs };
  `;
  const api = new Function('document', '$ship', 'realClick', body)(document, $ship, realClick);

  const ret = api.selectDelivery();
  const picked = api.currentDeliveryText();
  // 舊守衛 vs 新守衛（fireStart 剛開始，還在 2 秒寬限內）
  const oldGuardBlocks = (ret === false);
  const newGuardBlocks = (ret !== true);
  console.log(
    label.padEnd(34),
    '| 回傳=' + String(ret).padEnd(5),
    '| 選到=' + String(picked || '(無)').padEnd(22),
    '| 舊守衛擋?' + (oldGuardBlocks ? '是' : '否 ') ,
    '| 新守衛擋?' + (newGuardBlocks ? '是' : '否')
  );
  return { ret, picked, oldGuardBlocks, newGuardBlocks };
}

console.log('='.repeat(120));
console.log('情境測試（守衛=「不開火、再等」；沒擋就會把「直接購買」點下去）');
console.log('='.repeat(120));

// 1. 洞 #2：配送區塊還沒渲染
const t1 = run('①配送區塊還沒渲染（0 個 radio）', [], 'i郵箱,超商');

// 2. 正常：有三種取貨，偏好 i郵箱
const t2 = run('②偏好 i郵箱（有三種取貨）', ['宅配到府 快速到貨', '超商取貨 7-ELEVEN', 'i郵箱 中華郵政', 'myfone門市取貨'], 'i郵箱,超商');

// 3. 偏好 myfone
const t3 = run('③偏好 myfone門市取貨', ['宅配到府 快速到貨', '超商取貨 7-ELEVEN', 'i郵箱 中華郵政', 'myfone門市取貨'], 'myfone,超商');

// 4. 留空 → 頁面順序（舊行為）
const t4 = run('④偏好留空＝頁面順序（舊行為）', ['宅配到府 快速到貨', '超商取貨 7-ELEVEN', 'i郵箱 中華郵政'], '');

// 5. 偏好指定了但頁面沒有 → 退回第一個取貨
const t5 = run('⑤偏好 i郵箱 但頁面沒有', ['宅配到府 快速到貨', '超商取貨 7-ELEVEN'], 'i郵箱,超商');

// 6. 這商品完全沒有取貨選項
const t6 = run('⑥只有快速到貨（無取貨選項）', ['宅配到府 快速到貨'], 'i郵箱,超商');

console.log('='.repeat(120));

const checks = [
  ['洞#2 修正：未渲染時新守衛會擋、舊守衛不擋', t1.oldGuardBlocks === false && t1.newGuardBlocks === true],
  ['偏好 i郵箱 有生效', /i郵箱/.test(t2.picked) && t2.ret === true],
  ['偏好 myfone 有生效', /myfone/.test(t3.picked) && t3.ret === true],
  ['留空時退回頁面第一個取貨（超商）', /超商/.test(t4.picked) && t4.ret === true],
  ['偏好落空時退回第一個取貨（超商）', /超商/.test(t5.picked) && t5.ret === true],
  ['無取貨選項回 false，兩種守衛都擋', t6.ret === false && t6.newGuardBlocks === true],
  ['無取貨選項時不會誤選快速到貨', !t6.picked || !/快速到貨/.test(t6.picked)],
];
let bad = 0;
for (const [name, ok] of checks) { console.log((ok ? '  PASS  ' : '  FAIL  ') + name); if (!ok) bad++; }
console.log('='.repeat(120));
console.log(bad === 0 ? '✅ 全部通過 (' + checks.length + '/' + checks.length + ')' : '❌ ' + bad + ' 項失敗');
process.exit(bad ? 1 : 0);
