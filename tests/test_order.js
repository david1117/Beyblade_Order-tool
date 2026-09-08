// funbox 自動下單（v1.4）離線測試：型號抽取邊界 + 貨到付款判定。
// 跑法： cd D:\Funbox_beyblade\tests && node test_order.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'funbox_grab.user.js'), 'utf8');
let checks = [];
function ck(name, cond, extra) {
  checks.push([name, !!cond]);
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra !== undefined ? '   ' + extra : ''));
}
function extract(names) {
  return names.map(n => {
    const i = src.indexOf('function ' + n + '(');
    if (i < 0) throw new Error('找不到 ' + n + '（v1.4 才有；請確認腳本版本）');
    let d = 0, st = false, j = i;
    for (; j < src.length; j++) {
      if (src[j] === '{') { d++; st = true; }
      else if (src[j] === '}') { d--; if (st && d === 0) { j++; break; } }
    }
    return src.slice(i, j);
  }).join('\n');
}
const ex = new Function(extract(['extractModelCodes']) + '\n return extractModelCodes;')();

console.log('== 型號抽取（同商品 1 單守衛靠它）==');
ck('基本：UX-21', JSON.stringify(ex('戰鬥陀螺 UX-21 天雷之槍 NT$495')) === '["UX-21"]');
ck('多型號去重', JSON.stringify(ex('UX-21 x1、BX-35 x1、UX-21 加購')) === '["UX-21","BX-35"]');
ck('BXG 不被 BX 吃掉', JSON.stringify(ex('BXG-57 隨機強化組')) === '["BXG-57"]');
ck('⚠ CX-140 不誤中 CX-14', JSON.stringify(ex('商品編號 CX-140')) === '["CX-140"]');
ck('小寫轉大寫', JSON.stringify(ex('ux-21 特別版')) === '["UX-21"]');
ck('容忍空白 UX - 21', JSON.stringify(ex('UX - 21')) === '["UX-21"]');
ck('沒型號回空', JSON.stringify(ex('多美動物 AL-37')) === '[]');
ck('空輸入安全', JSON.stringify(ex('')) === '[]' && JSON.stringify(ex(null)) === '[]');

console.log('== 貨到付款判定（鐵律：不是 COD 絕不送出）==');
const COD = /貨到付款/;
const PREPAY = /先付款|信用卡|GooglePay|ApplePay/i;
ck('7-11 貨到付款 → 可送', COD.test('7-11貨到付款'));
ck('全家貨到付款 → 可送', COD.test('全家貨到付款'));
ck('7-11 取貨(先付款) → 不可送', !COD.test('7-11取貨(先付款)') && PREPAY.test('7-11取貨(先付款)'));
ck('信用卡 → 不可送', !COD.test('信用卡') && PREPAY.test('信用卡'));
ck('宅配（無付款字樣）→ 不可送', !COD.test('宅配'));

const bad = checks.filter(c => !c[1]);
console.log(bad.length ? `❌ ${bad.length} 失敗` : `✅ 全部通過 (${checks.length}/${checks.length})`);
process.exit(bad.length ? 1 : 0);
