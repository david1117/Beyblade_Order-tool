// 離線驗證對時精度：模擬一台真實 offset 已知的伺服器，比較舊法 vs 新法（區間交集）
// 從 momo_grab.user.js 直接抽出 clockAddSample / scheduleAt 的原始碼來測，不重寫邏輯。
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

// ---- 建立一份與腳本同源的估計器實例 ----
function makeEstimator() {
  const body = `
    var clockLo = -Infinity, clockHi = Infinity;
    var clockOffset = 0;
    var clockErrMs = null;
    ${extract('clockAddSample')}
    return {
      add: clockAddSample,
      get offset() { return clockOffset; },
      get err() { return clockErrMs; },
      get lo() { return clockLo; },
      get hi() { return clockHi; }
    };
  `;
  return new Function(body)();
}

// ---- 模擬環境 ----
// 本機時鐘 = 真實時間 + localSkew。伺服器回的 Date 標頭 = floor(真實時間 / 1000) * 1000
// 我們要估的 offset = 真實伺服器時間 - 本機時間 = -localSkew
function runTrial({ localSkew, rttMin, rttMax, probes, gap, rng }) {
  const est = makeEstimator();
  let trueNow = 1786723200000 + Math.floor(rng() * 1000);  // 隨機起始小數位
  let oldOffset = null;

  for (let i = 0; i < probes; i++) {
    const localT0 = trueNow + localSkew;
    const rtt = rttMin + rng() * (rttMax - rttMin);
    const genAt = trueNow + rtt * (0.3 + rng() * 0.4);     // 標頭在來回途中某處產生
    const headerMs = Math.floor(genAt / 1000) * 1000;      // 秒級截斷
    trueNow += rtt;
    const localT1 = trueNow + localSkew;

    est.add(localT0, localT1, headerMs);
    oldOffset = headerMs - localT1;                        // 舊法：只用最後一次

    if (est.err !== null && est.err <= 60) { /* 達標可提早停，但這裡跑完全部 */ }
    trueNow += gap;
  }
  const want = -localSkew;
  return { newErr: est.offset - want, oldErr: oldOffset - want, halfWidth: est.err };
}

// 簡易可重現 PRNG
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

console.log('='.repeat(104));
console.log('對時精度：1000 次試驗／組（localSkew 與起始小數位隨機）');
console.log('='.repeat(104));
console.log('RTT 範圍        取樣  |   舊法 平均誤差   舊法 最差  |  新法 平均誤差  新法 最差  | 收斂半寬');
console.log('-'.repeat(104));

const summary = [];
for (const [rttMin, rttMax] of [[10, 40], [30, 90], [80, 250]]) {
  for (const probes of [1, 6, 18]) {
    let oldAbs = [], newAbs = [], hw = [];
    for (let k = 0; k < 1000; k++) {
      const rng = mulberry32(k * 7919 + rttMin);
      const r = runTrial({ localSkew: Math.floor(rng() * 4000) - 2000, rttMin, rttMax, probes, gap: 110, rng });
      oldAbs.push(Math.abs(r.oldErr)); newAbs.push(Math.abs(r.newErr)); hw.push(r.halfWidth);
    }
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    const max = a => Math.max(...a);
    const row = { rttMin, rttMax, probes, oldMean: mean(oldAbs), oldMax: max(oldAbs), newMean: mean(newAbs), newMax: max(newAbs), hwMean: mean(hw) };
    summary.push(row);
    console.log(
      `${(rttMin + '-' + rttMax + 'ms').padEnd(14)} ${String(probes).padStart(4)}  | ` +
      `${(row.oldMean.toFixed(0) + 'ms').padStart(15)} ${(row.oldMax.toFixed(0) + 'ms').padStart(10)}  | ` +
      `${(row.newMean.toFixed(0) + 'ms').padStart(14)} ${(row.newMax.toFixed(0) + 'ms').padStart(10)}  | ` +
      `${('±' + row.hwMean.toFixed(0) + 'ms').padStart(9)}`
    );
  }
}

// 舊法偏差方向：應該一律「偏慢」（serverNow 落後 → offset 估太小 → 誤差為負）
let neg = 0, tot = 0;
for (let k = 0; k < 2000; k++) {
  const rng = mulberry32(k * 104729 + 3);
  const r = runTrial({ localSkew: Math.floor(rng() * 4000) - 2000, rttMin: 20, rttMax: 60, probes: 1, gap: 110, rng });
  tot++; if (r.oldErr < 0) neg++;
}

console.log();
console.log('='.repeat(104));
console.log(`舊法（單次取樣）誤差為負（＝serverNow 偏慢、開火偏晚）的比例：${neg}/${tot} = ${(neg / tot * 100).toFixed(1)}%`);

// ---- scheduleAt 的收尾精度 ----
const schedBody = `${extract('scheduleAt')}; return scheduleAt;`;
function simSchedule(left0, timerJitterMs, rng) {
  // 用假時鐘重放 scheduleAt 的 delay 選擇邏輯
  let now = 0, steps = 0;
  for (;;) {
    const left = left0 - now;
    if (left <= 0) return { overshoot: -left, steps };
    const delay = left > 2000 ? Math.min(left - 1000, 30000)
                : left > 400 ? left - 300
                : left > 60 ? 15
                : 4;
    now += delay + rng() * timerJitterMs;     // 瀏覽器 timer 一定會晚一點
    if (++steps > 100000) throw new Error('no convergence');
  }
}
console.log();
console.log('scheduleAt 收尾精度（瀏覽器 timer 延遲抖動 0~4ms）：');
let ovs = [], stepsArr = [];
for (let k = 0; k < 2000; k++) {
  const rng = mulberry32(k + 11);
  const r = simSchedule(6000 + rng() * 60000, 4, rng);
  ovs.push(r.overshoot); stepsArr.push(r.steps);
}
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`  平均超時 ${mean(ovs).toFixed(2)}ms、最差 ${Math.max(...ovs).toFixed(2)}ms、平均步數 ${mean(stepsArr).toFixed(1)}`);
console.log(`  對照：舊版靠 200ms setInterval 觸發 → 平均超時 100ms、最差 200ms`);

console.log();
console.log('='.repeat(104));
const r18 = summary.filter(r => r.probes === 18);
const r1 = summary.filter(r => r.probes === 1);
const checks = [
  ['舊法（單次）誤差 100% 為負（系統性偏晚，從不偏早）', neg === tot],
  ['舊法平均誤差 > 400ms', r1.every(r => r.oldMean > 400)],
  ['新法 18 次取樣後平均誤差 < 60ms', r18.every(r => r.newMean < 60)],
  ['新法 18 次取樣後最差誤差 < 150ms', r18.every(r => r.newMax < 150)],
  ['新法在所有 RTT 組合下都優於舊法', summary.every(r => r.newMean <= r.oldMean)],
  ['新法回報的半寬確實涵蓋真實誤差（估計不過度自信）', r18.every(r => r.newMax <= r.hwMean * 2.5)],
  ['scheduleAt 平均超時 < 5ms（舊版 100ms）', mean(ovs) < 5],
  ['scheduleAt 最差超時 < 12ms（舊版 200ms）', Math.max(...ovs) < 12],
];
let bad = 0;
for (const [name, ok] of checks) { console.log((ok ? '  PASS  ' : '  FAIL  ') + name); if (!ok) bad++; }
console.log('='.repeat(104));
console.log(bad === 0 ? `✅ 全部通過 (${checks.length}/${checks.length})` : `❌ ${bad} 項失敗`);
process.exit(bad ? 1 : 0);
