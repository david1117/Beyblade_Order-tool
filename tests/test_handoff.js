// 用虛擬時鐘模擬「預刷 → 重載迴圈 → 交接」的完整時序，比較舊版 vs 新版
// 重點驗證 8/15 UX-20 那個 bug：重載發出時還在窗口內，頁面載回來時已過期 → 舊版靜默放棄

const TICK = 150;            // fireLoop 輪詢間隔
const THROTTLE = 2000;       // 重載節流
const GRACE = 30000;         // 新版 RESUME_GRACE_MS
const MIN_ROOM = 3500;       // 新版 MIN_RELOAD_ROOM_MS

// version: 'old' | 'new'
// T=0 為開賣時刻（ms）。buttonAt = 「直接購買」按鈕在伺服器端出現的時刻。
function simulate({ version, pre, L, windowSec, buttonAt, limit = 400000 }) {
  const W = windowSec * 1000;
  const log = [];
  // --- 預刷：在 T-pre 發出 ---
  let ss = version === 'old'
    ? { deadline: -pre + 60000, holdUntil: 0 }          // 舊版硬寫 60s
    : { hardStop: -pre + pre + W, holdUntil: 0 };       // 新版：從開賣起算 W
  if (version === 'new') ss.hardStop = 0 + W;
  let now = -pre + L;                                   // 預刷頁面載入完成
  log.push({ t: now, ev: 'preload-done' });

  let guard = 0;
  while (now < limit) {
    if (++guard > 100000) throw new Error('loop');
    // --- 交接判定（頁面剛載入時執行一次）---
    const stop = version === 'old' ? (ss.deadline ?? 0) : (ss.hardStop ?? 0);
    const resumeOk = version === 'old'
      ? now < stop
      : now < stop + GRACE;
    if (!resumeOk) {
      log.push({ t: now, ev: 'SILENT-ABANDON', detail: `now=${now} stop=${stop}` });
      return { clickedAt: null, log };
    }
    let hardStop = stop;
    if (version === 'new' && now >= stop) {
      hardStop = now + GRACE;                           // 續命
      log.push({ t: now, ev: 'grace-extend', detail: `hardStop→${hardStop}` });
    }
    log.push({ t: now, ev: 'fireLoop-start' });

    // --- fireLoop 迴圈 ---
    let lastReload = now;
    let pageLoadedAt = now;
    let reloaded = false;
    for (;;) {
      if (now > hardStop) { log.push({ t: now, ev: 'window-exhausted' }); return { clickedAt: null, log }; }
      // 這一頁是 pageLoadedAt 抓的快照：只有當時伺服器已翻頁，按鈕才在
      if (pageLoadedAt >= buttonAt) {
        log.push({ t: now, ev: 'CLICK', detail: `page@${pageLoadedAt}` });
        return { clickedAt: now, log };
      }
      if (now - lastReload > THROTTLE) {
        if (version === 'new' && hardStop - now < MIN_ROOM) {
          log.push({ t: now, ev: 'refuse-reload(explicit-stop)' });
          return { clickedAt: null, log };
        }
        lastReload = now;
        if (version === 'old') ss = { deadline: hardStop };
        else ss = { hardStop: hardStop };
        now += L;                                        // 導頁 + 載入
        log.push({ t: now, ev: 'reload-done' });
        reloaded = true;
        break;                                           // 回到外層做交接判定
      }
      now += TICK;
    }
    if (!reloaded) return { clickedAt: null, log };
  }
  return { clickedAt: null, log };
}

const f = (v) => v === null ? '  —  ' : ('T+' + (v / 1000).toFixed(1) + 's');

console.log('='.repeat(96));
console.log('重現 8/15 UX-20：預刷 6s、momo 頁面載入慢、按鈕在 T+48s 才出現');
console.log('='.repeat(96));
console.log('頁面載入 L | 按鈕出現 |  舊版(60s窗口)  |  新版(180s窗口)  | 結論');
console.log('-'.repeat(96));
let rows = [];
for (const L of [3000, 6000, 10000, 15000]) {
  for (const buttonAt of [20000, 48000, 90000]) {
    const o = simulate({ version: 'old', pre: 6000, L, windowSec: 60, buttonAt });
    const n = simulate({ version: 'new', pre: 6000, L, windowSec: 180, buttonAt });
    const verdict = o.clickedAt === null && n.clickedAt !== null ? '✅ 新版救回'
      : o.clickedAt !== null && n.clickedAt !== null ? (n.clickedAt <= o.clickedAt ? '＝ 兩者都到' : '兩者都到')
      : o.clickedAt === null && n.clickedAt === null ? '兩者皆失敗' : '⚠️ 新版變差';
    rows.push({ L, buttonAt, o: o.clickedAt, n: n.clickedAt, verdict, oldLog: o.log, newLog: n.log });
    console.log(`${(L/1000+'s').padStart(10)} | ${(buttonAt/1000+'s').padStart(8)} | ${f(o.clickedAt).padStart(15)} | ${f(n.clickedAt).padStart(16)} | ${verdict}`);
  }
}

console.log();
console.log('='.repeat(96));
console.log('舊版失敗案例的詳細事件（L=15s、按鈕 T+48s）—— 這就是 8/15 的形狀');
console.log('='.repeat(96));
const bad = simulate({ version: 'old', pre: 6000, L: 15000, windowSec: 60, buttonAt: 48000 });
for (const e of bad.log) console.log(`  T${(e.t/1000).toFixed(1).padStart(7)}s  ${e.ev}${e.detail ? '  (' + e.detail + ')' : ''}`);
console.log();
console.log('  同條件下新版：');
const good = simulate({ version: 'new', pre: 6000, L: 15000, windowSec: 180, buttonAt: 48000 });
for (const e of good.log) console.log(`  T${(e.t/1000).toFixed(1).padStart(7)}s  ${e.ev}${e.detail ? '  (' + e.detail + ')' : ''}`);

console.log();
console.log('='.repeat(96));
const checks = [
  ['舊版在「重載跨過 deadline」時會靜默放棄', bad.log.some(e => e.ev === 'SILENT-ABANDON')],
  ['新版在同條件下成功點擊', good.clickedAt !== null],
  ['新版沒有任何 SILENT-ABANDON（永遠有明確結束訊息）',
    rows.every(r => !r.newLog.some(e => e.ev === 'SILENT-ABANDON'))],
  ['新版不會比舊版差（沒有「新版變差」）', rows.every(r => r.verdict !== '⚠️ 新版變差')],
  ['至少有一組是新版救回舊版的失敗', rows.some(r => r.verdict === '✅ 新版救回')],
  ['按鈕在窗口內出現時，新版一定點得到',
    rows.filter(r => r.buttonAt < 180000).every(r => r.n !== null)],
];
let bad_n = 0;
for (const [name, ok] of checks) { console.log((ok ? '  PASS  ' : '  FAIL  ') + name); if (!ok) bad_n++; }
console.log('='.repeat(96));
console.log(bad_n === 0 ? `✅ 全部通過 (${checks.length}/${checks.length})` : `❌ ${bad_n} 項失敗`);
process.exit(bad_n ? 1 : 0);
