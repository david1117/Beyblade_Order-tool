// 驗證 combo 網址參數解析 + 開賣時間正規化 + NaN 防護
// 重現 8/15 07:00 UX-15 的失敗：momo 把 /goods/GoodsDetail.jsp?... 轉址成 /product/{id}?...
// 過程中 mgtime 的冒號被編成 %3A，舊 regex [0-9T:\-]+ 在第一個 % 就截斷。
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

// 從腳本抽出 pad / normTime / targetTs（targetTs 需要 $date、$time24）
function makeApi(dateVal, timeVal) {
  const body = `
    ${extract('pad')}
    var $date = { value: ${JSON.stringify(dateVal)} };
    var $time24 = { value: ${JSON.stringify(timeVal)} };
    ${extract('normTime')}
    ${extract('targetTs')}
    return { normTime: normTime, targetTs: targetTs, time: function(){ return $time24.value; } };
  `;
  return new Function(body)();
}

// 腳本裡實際用的 mgtime / mgship 解析（新版）
function parseCombo(search) {
  const mtRaw = (search.match(/[?&]mgtime=([^&]+)/) || [])[1];
  let mt = null;
  if (mtRaw) { try { mt = decodeURIComponent(mtRaw); } catch (e) { mt = mtRaw; } }
  const msRaw = (search.match(/[?&]mgship=([^&]+)/) || [])[1];
  let ms = null;
  if (msRaw) { try { ms = decodeURIComponent(msRaw); } catch (e) { ms = msRaw; } }
  return { mt, ms };
}
// 舊版寫法，用來對照
function parseComboOld(search) {
  return (search.match(/[?&]mgtime=([0-9T:\-]+)/) || [])[1];
}
// 舊版 targetTs（v2.5 以前）：沒有 normTime、無效時回 0 或 NaN 都不擋
function oldTargetTs(dv, tv) {
  dv = (dv || '').trim(); tv = (tv || '').trim();
  if (!dv || !tv) return 0;
  if (/^\d{1,2}:\d{2}$/.test(tv)) tv += ':00';   // "07" 不符合 HH:MM → 不補
  return new Date(dv.replace(/-/g, '/') + ' ' + tv).getTime();
}

// 8/15 早上網址列上真正的字串
const REAL = '?mgauto=1&mgmode=buy&mgpre=6&mgwin=180&mgship=%E8%B6%85%E5%95%86%2Ci%E9%83%B5%E7%AE%B1%2C%E9%96%80%E5%B8%82%E5%8F%96%E8%B2%A8&mgtime=2026-08-15T07%3A00%3A00';
const LITERAL = '?mgauto=1&mgmode=buy&mgtime=2026-08-15T07:00:00&mgship=%E8%B6%85%E5%95%86,i%E9%83%B5%E7%AE%B1';

console.log('='.repeat(100));
console.log('① 重現 8/15 07:00 的失敗（冒號被編成 %3A）');
console.log('='.repeat(100));
const oldMt = parseComboOld(REAL);
const newMt = parseCombo(REAL).mt;
console.log('  舊版 mgtime 擷取 :', JSON.stringify(oldMt));
console.log('  新版 mgtime 擷取 :', JSON.stringify(newMt));
const oldTime = (oldMt || '').split('T')[1] || '';
const newTime = (newMt || '').split('T')[1] || '';
console.log('  舊版 $time24     :', JSON.stringify(oldTime), '→ 舊版 targetTs =', oldTargetTs('2026-08-15', oldTime), '(' + new Date(oldTargetTs('2026-08-15', oldTime)) + ')');
console.log('  新版 $time24     :', JSON.stringify(newTime), '→ targetTs =', new Date(makeApi('2026-08-15', newTime).targetTs()).toString());

console.log();
console.log('='.repeat(100));
console.log('② normTime 正規化');
console.log('='.repeat(100));
const api0 = makeApi('2026-08-15', '');
const normCases = [
  ['07:00:00', '07:00:00'], ['7:00:00', '07:00:00'], ['07:00', '07:00:00'],
  ['7:0', '07:00:00'], ['07', '07:00:00'], ['7', '07:00:00'],
  ['23:59:59', '23:59:59'], ['24:00:00', null], ['07:60', null],
  ['abc', null], ['', null], ['07:00:00:00', null],
];
let normBad = 0;
for (const [inp, want] of normCases) {
  const got = api0.normTime(inp);
  const ok = got === want;
  if (!ok) normBad++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  normTime(${JSON.stringify(inp).padEnd(12)}) = ${JSON.stringify(got).padEnd(12)} (want ${JSON.stringify(want)})`);
}

console.log();
console.log('='.repeat(100));
console.log('③ targetTs 對無效輸入一律回 NaN（不會變成 0 或 Invalid Date 在系統裡流竄）');
console.log('='.repeat(100));
const tsCases = [
  ['2026-08-15', '07:00:00', true],
  ['2026-08-15', '07', true],          // 正規化後仍有效
  ['2026-08-15', 'abc', false],
  ['2026-08-15', '', false],
  ['', '07:00:00', false],
  ['2026-08-15', '24:00:00', false],
];
let tsBad = 0;
for (const [d, t, wantValid] of tsCases) {
  const ts = makeApi(d, t).targetTs();
  const valid = isFinite(ts);
  const ok = valid === wantValid;
  if (!ok) tsBad++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  date=${JSON.stringify(d).padEnd(14)} time=${JSON.stringify(t).padEnd(11)} → ${valid ? new Date(ts).toISOString() : 'NaN'}`);
}

console.log();
console.log('='.repeat(100));
console.log('④ scheduleAt 遇到 NaN 目標必須停手（舊版會掉到 4ms 分支無限空轉）');
console.log('='.repeat(100));
const schedSrc = extract('scheduleAt');
const hasGuard = /isFinite\(left\)/.test(schedSrc);
console.log('  scheduleAt 內含 isFinite(left) 防護 :', hasGuard);
// 模擬舊版沒有防護時的行為
let spins = 0;
(function simOld() {
  let left = NaN;
  for (let i = 0; i < 5; i++) {
    if (left <= 0) break;                    // NaN <= 0 → false
    const delay = left > 2000 ? 1 : left > 400 ? 2 : left > 60 ? 15 : 4;
    if (delay === 4) spins++;
  }
})();
console.log('  舊版邏輯在 NaN 下 5 次迭代全部落到 4ms 分支 :', spins === 5);

console.log();
console.log('='.repeat(100));
console.log('⑤ 文字型參數（含中文逗號編碼）');
console.log('='.repeat(100));
for (const [label, s] of [['轉址編碼後', REAL], ['原始字面值', LITERAL]]) {
  const p = parseCombo(s);
  console.log(`  ${label.padEnd(10)} mgtime=${JSON.stringify(p.mt).padEnd(24)} mgship=${JSON.stringify(p.ms)}`);
}

console.log();
console.log('='.repeat(100));
const p1 = parseCombo(REAL), p2 = parseCombo(LITERAL);
const checks = [
  ['舊版在 %3A 上截斷成 "2026-08-15T07"', oldMt === '2026-08-15T07'],
  ['舊版 targetTs = NaN（面板顯示 NaN:NaN:NaN 的原因）', !isFinite(oldTargetTs('2026-08-15', oldTime))],
  ['舊版 NaN 下 left<=0 恆為 false → 永遠不開火', !((oldTargetTs('2026-08-15', oldTime) - Date.now()) <= 0)],
  ['新版同一組輸入能救回來（normTime 補成 07:00:00）', isFinite(makeApi('2026-08-15', oldTime).targetTs())],
  ['新版正確解出 2026-08-15T07:00:00', p1.mt === '2026-08-15T07:00:00'],
  ['新版 targetTs 有效', isFinite(makeApi('2026-08-15', newTime).targetTs())],
  ['字面冒號的網址也照樣正確', p2.mt === '2026-08-15T07:00:00'],
  ['mgship 中文＋%2C 逗號正確解碼', p1.ms === '超商,i郵箱,門市取貨'],
  ['normTime 全部案例通過', normBad === 0],
  ['targetTs NaN 行為全部正確', tsBad === 0],
  ['scheduleAt 有 NaN 防護', hasGuard],
];
let bad = 0;
for (const [name, ok] of checks) { console.log((ok ? '  PASS  ' : '  FAIL  ') + name); if (!ok) bad++; }
console.log('='.repeat(100));
console.log(bad === 0 ? `✅ 全部通過 (${checks.length}/${checks.length})` : `❌ ${bad} 項失敗`);
process.exit(bad ? 1 : 0);
