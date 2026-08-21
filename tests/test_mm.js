// M.M小舖 規格判讀的離線測試 —— 用真實存下來的「已渲染」HTML，不連網。
//
// 跑法：  cd D:\Funbox_beyblade\tests  &&  npm install jsdom  &&  node test_mm.js
//
// 這支測的是 mm_grab.user.js 裡「怎麼判斷某個規格能不能買」那段。判斷錯的後果是
// 兩種都很糟：漏判＝有貨沒搶到；誤判＝對著「補貨中」猛按。所以兩個方向都要測。

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'mm_grab.user.js');
const RECON_DIR = path.join(__dirname, '..', 'recon');

let checks = [];
function ck(name, cond, extra) {
  checks.push([name, !!cond]);
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra !== undefined ? '   ' + extra : ''));
}

// 從真正的腳本原始碼抽函式出來跑 —— 這樣測試會跟著實作走，不會各寫一份而漂移。
function extract(src, names) {
  return names.map(n => {
    const i = src.indexOf('function ' + n + '(');
    if (i < 0) throw new Error('找不到函式 ' + n + '（改名了？測試要同步更新）');
    let depth = 0, started = false, j = i;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '{') { depth++; started = true; }
      else if (c === '}') { depth--; if (started && depth === 0) { j++; break; } }
    }
    return src.slice(i, j);
  }).join('\n');
}

const src = fs.readFileSync(SRC, 'utf8');
const FNS = ['norm', 'specButtons', 'chosenButton', 'findSpec', 'visible',
             'readStock', 'addButton', 'soldoutShown', 'state'];
const code = extract(src, FNS);

function makeApi(dom) {
  const sandbox = {
    document: dom.window.document,
    window: dom.window,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    Array: Array, parseInt: parseInt, console: console
  };
  const fn = new Function(...Object.keys(sandbox),
    code + '\n return {' + FNS.join(',') + '};');
  return fn(...Object.values(sandbox));
}

function findRecon() {
  if (!fs.existsSync(RECON_DIR)) return null;
  const f = fs.readdirSync(RECON_DIR).filter(n => /mm.*render|render.*mm|CX01|CX-01/i.test(n) && n.endsWith('.html'));
  return f.length ? path.join(RECON_DIR, f[0]) : null;
}

console.log('='.repeat(84));
console.log('① 真實已渲染頁面：CX-01 蒼龍勇氣（兩個規格，目標規格庫存 0 → 補貨中）');
console.log('='.repeat(84));

const reconPath = findRecon();
let api = null, dom = null;
if (!reconPath) {
  console.log('  ⚠️ recon/ 裡找不到已渲染的 MM 商品頁 HTML，跳過這一段。');
  console.log('     （把 Ctrl+S 存下來的「網頁，完整」HTML 放進 recon/，檔名含 mm_rendered 或 CX-01）');
} else {
  console.log('  素材：' + path.basename(reconPath));
  dom = new JSDOM(fs.readFileSync(reconPath, 'utf8'));
  api = makeApi(dom);

  const opts = api.specButtons().map(b => api.norm(b.textContent));
  console.log('  找到規格：' + JSON.stringify(opts, null, 0));
  ck('找到 2 個規格選項', api.specButtons().length === 2, api.specButtons().length);
  ck('第一個是「預購-1個(不可搭其他預購) #不補」',
     opts[0] === '預購-1個(不可搭其他預購) #不補', opts[0]);

  const ch = api.chosenButton();
  ck('讀得出目前選中的規格（.isChosen）', ch && api.norm(ch.textContent) === opts[0],
     ch ? api.norm(ch.textContent) : null);
  ck('選中規格的 spec id = 2437747', ch && ch.value === '2437747', ch && ch.value);

  const stock = api.readStock();
  ck('庫存讀成數字 0（不是 null、不是字串）', stock === 0, JSON.stringify(stock));
  ck('偵測到「補貨中」是顯示狀態', api.soldoutShown() === true, api.soldoutShown());

  // 這是最重要的一項：補貨中那顆按鈕自己也帶 addtocart_btn class
  const add = api.addButton();
  ck('⚠ 沒有把「補貨中」誤判成加入購物車鈕', add === null,
     add ? add.className.slice(0, 60) : 'null');

  const st = api.state();
  console.log('  state() = ' + JSON.stringify(
    { specText: st.specText, stock: st.stock, buyable: st.buyable, soldout: st.soldout }));
  ck('判定為不可買（false，不是 null 也不是 true）', st.buyable === false, st.buyable);
}

console.log();
console.log('='.repeat(84));
console.log('② 規格比對（選錯規格 = 買到不想要的東西，所以要嚴格）');
console.log('='.repeat(84));
if (api) {
  const a = '預購-1個(不可搭其他預購) #不補';
  const b = '預購-1個(限客訂assp0123';
  ck('完整字串找得到 A', api.findSpec(a) && api.findSpec(a).value === '2437747');
  ck('完整字串找得到 B', api.findSpec(b) && api.findSpec(b).value === '2437748');
  ck('片段「不可搭」命中 A', api.findSpec('不可搭') && api.findSpec('不可搭').value === '2437747');
  ck('片段「限客訂」命中 B', api.findSpec('限客訂') && api.findSpec('限客訂').value === '2437748');
  ck('兩者共同前綴「預購-1個」不會亂挑 → 回傳第一個相符（有明確行為）',
     api.findSpec('預購-1個') !== null);
  ck('找不到的規格回 null（不會退而求其次亂選）', api.findSpec('UX-99 不存在') === null);
  ck('空字串回 null（呼叫端會改用「目前選中的」）', api.findSpec('') === null);
  ck('大小寫／空白不敏感',
     api.findSpec('  預購-1個(不可搭其他預購)   #不補  ') !== null);
} else {
  console.log('  （沒有素材，跳過）');
}

console.log();
console.log('='.repeat(84));
console.log('③ 有貨的情境（真實素材全是缺貨的，所以這裡把 DOM 改成有貨來測正向路徑）');
console.log('='.repeat(84));

const IN_STOCK_HTML = `<!DOCTYPE html><html><body>
<div class="productInfoSpec">
  <input type="hidden" id="specs" value="2437747">
  <div data-label="規格">
    <span class="buttonSpan"><button type="button" value="2437747" class="getClick isChosen"> 預購-1個(不可搭其他預購) #不補 </button></span>
    <span class="buttonSpan"><button type="button" value="2437748" class="getClick"> 預購-1個(限客訂assp0123 </button></span>
  </div>
</div>
<p id="quantity" class="instock productInfoQuantity">商品庫存：<span>3</span></p>
<div class="productInfoCartbtn">
  <div class="grid">
    <button type="button" class="cart_btn add_cart quick_check">直接購買</button>
    <button type="button" class="cart_btn add_cart addtocart_btn">加入購物車</button>
  </div>
  <div class="grid" style="display: none;">
    <button type="button" id="qty" class="soldout-hint productInfoSoldout cart_btn addtocart_btn" style="display: none;">補貨中</button>
  </div>
</div></body></html>`;

{
  const d = new JSDOM(IN_STOCK_HTML);
  const a2 = makeApi(d);
  const st = a2.state();
  console.log('  state() = ' + JSON.stringify(
    { stock: st.stock, buyable: st.buyable, soldout: st.soldout, hasAddBtn: st.hasAddBtn }));
  ck('庫存 3 讀得到', st.stock === 3, st.stock);
  ck('「補貨中」判定為隱藏', st.soldout === false, st.soldout);
  ck('找得到真正的加入購物車鈕', a2.addButton() !== null);
  ck('⚠ 抓到的是「加入購物車」，不是排在它前面的「直接購買」',
     a2.addButton() && a2.norm(a2.addButton().textContent) === '加入購物車',
     a2.addButton() && a2.norm(a2.addButton().textContent));
  ck('「直接購買」不會被當成目標（那會跳過購物車直接進結帳）',
     a2.addButton() && !a2.addButton().classList.contains('quick_check'));
  ck('✅ 判定為可買', st.buyable === true, st.buyable);
}

console.log();
console.log('='.repeat(84));
console.log('④ 不要猜：讀不到就說讀不到');
console.log('='.repeat(84));
{
  // 頁面還沒渲染完 —— 沒有 #quantity
  const d = new JSDOM(`<!DOCTYPE html><html><body>
    <div class="productInfoSpec"><button value="1" class="getClick isChosen">預購-1個(不可搭其他預購) #不補</button></div>
    <div class="productInfoCartbtn"><button class="cart_btn addtocart_btn">加入購物車</button></div>
    </body></html>`);
  const a3 = makeApi(d);
  ck('沒有 #quantity 時 readStock() 回 null（不是 0）', a3.readStock() === null, a3.readStock());
  ck('讀不到庫存時 buyable 回 null（不猜成有貨）', a3.state().buyable === null, a3.state().buyable);
}
{
  // 庫存 0 但按鈕還在（Vue 還沒切換完的中間狀態）
  const d = new JSDOM(`<!DOCTYPE html><html><body>
    <div class="productInfoSpec"><button value="1" class="getClick isChosen">A</button></div>
    <p id="quantity">商品庫存：<span>0</span></p>
    <div class="productInfoCartbtn"><button class="cart_btn addtocart_btn">加入購物車</button></div>
    </body></html>`);
  const a4 = makeApi(d);
  ck('庫存 0 就不可買，即使加入鈕還看得見', a4.state().buyable === false, a4.state().buyable);
}
{
  // 空頁面
  const d = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const a5 = makeApi(d);
  ck('完全空的頁面不會爆炸', a5.specButtons().length === 0 && a5.state().buyable === null);
}

console.log();
console.log('='.repeat(84));
console.log('⑤ config 驅動：網址暗號解析（momo §1-4 的教訓 —— 參數編碼往返要測）');
console.log('='.repeat(84));
{
  // 抽出 urlParam；它用到 location，所以搭一個假的 location 一起跑
  const upSrc = extract(src, ['norm', 'urlParam']);
  function makeUrlApi(search) {
    const fn = new Function('location', 'decodeURIComponent', 'RegExp',
      upSrc + '\n return {urlParam, norm};');
    return fn({ search }, decodeURIComponent, RegExp);
  }
  // server 端 mm_arm_url 會產生這種網址：spec 用 quote(safe="") 全編碼
  const spec = '預購-1個(不可搭其他預購) #不補';
  const enc = encodeURIComponent(spec);   // Python quote(safe='') 與 encodeURIComponent 對 # 和中文行為一致
  ck('# 有被編碼成 %23（沒編的話 # 後面會被當 fragment 吃掉）', enc.includes('%23'), enc.slice(-12));
  const u = makeUrlApi('?mmauto=1&mmint=120&mmspec=' + enc);
  ck('mmauto 讀得到', u.urlParam('mmauto') === '1');
  ck('mmint 讀得到', u.urlParam('mmint') === '120');
  ck('⚠ mmspec 解碼後與原字串完全一致（含 # 與中文）',
     u.urlParam('mmspec') === spec, JSON.stringify(u.urlParam('mmspec')));
  ck('不存在的參數回 null（不是空字串）', u.urlParam('mmfoo') === null);
  const u2 = makeUrlApi('');
  ck('沒有 query string 時安全', u2.urlParam('mmauto') === null);
  // 順序顛倒也要讀得到（reload 後瀏覽器可能重排？不會，但便宜就測）
  const u3 = makeUrlApi('?mmspec=' + enc + '&mmauto=1');
  ck('參數順序無關', u3.urlParam('mmauto') === '1' && u3.urlParam('mmspec') === spec);
}

console.log();
console.log('='.repeat(84));
console.log('⑥ 搜尋頁 finder：從渲染後的搜尋結果找商品連結（config 只放型號的關鍵一步）');
console.log('='.repeat(84));
{
  const finderSrc = extract(src, ['norm', 'itemAnchors', 'anchorText', 'findItemLink']);
  function makeFinder(dom) {
    const fn = new Function('document', 'Array', 'RegExp',
      finderSrc + '\n return {itemAnchors, findItemLink, anchorText, norm};');
    return fn(dom.window.document, Array, RegExp);
  }
  // 模擬渲染後的搜尋結果：標題在 <a> 裡、在 img alt、在卡片容器兄弟節點 —— 三種都要找得到
  const SEARCH_HTML = `<!DOCTYPE html><html><body>
    <div class="card"><a href="/item/ShopeeAAA111"><p>【M.M小舖】『預購』 9月 TAKARA TOMY 戰鬥陀螺 UX-21 天雷之槍</p></a></div>
    <div class="card"><a href="/item/ShopeeBBB222"><img alt="【M.M小舖】戰鬥陀螺 BX-35 隨機強化組" src="x.jpg"></a></div>
    <div class="card"><div><a href="/item/ShopeeCCC333"><img src="y.jpg"></a></div><p>【M.M小舖】戰鬥陀螺 CX-14 烈焰騎士</p></div>
    <div class="card"><a href="/item/ShopeeDDD444"><p>AOSHIMA 青島 組裝模型 VF-31</p></a></div>
    <a href="/cart">購物車</a><a href="/category?page=2">下一頁</a>
    </body></html>`;
  const d = new JSDOM(SEARCH_HTML);
  const f = makeFinder(d);
  ck('只抓 /item/ 連結，購物車與分頁連結不算', f.itemAnchors().length === 4, f.itemAnchors().length);
  const hit1 = f.findItemLink('UX-21');
  ck('標題在 <a> 內：UX-21 找得到', hit1 && hit1.getAttribute('href') === '/item/ShopeeAAA111',
     hit1 && hit1.getAttribute('href'));
  const hit2 = f.findItemLink('BX-35');
  ck('標題只在 img alt：BX-35 也找得到', hit2 && hit2.getAttribute('href') === '/item/ShopeeBBB222',
     hit2 && hit2.getAttribute('href'));
  const hit3 = f.findItemLink('CX-14');
  ck('標題在卡片容器兄弟節點：CX-14 也找得到', hit3 && hit3.getAttribute('href') === '/item/ShopeeCCC333',
     hit3 && hit3.getAttribute('href'));
  ck('小寫 ux-21 也命中（大小寫不敏感）', f.findItemLink('ux-21') !== null);
  ck('沒上架的型號回 null（BXG-57 不在結果裡）', f.findItemLink('BXG-57') === null);
  ck('空字串回 null', f.findItemLink('') === null);
  // 誤中檢查：UX-2 不可以誤中 UX-21？—— 包含比對本來就會中，這是已知行為：
  // config 請寫完整型號（UX-21 不會誤中 UX-2 因為清單裡沒有 UX-2 這種短碼商品）
  const empty = new JSDOM('<!DOCTYPE html><html><body><p>搜尋不到相關商品</p></body></html>');
  const fe = makeFinder(empty);
  ck('搜尋結果空頁不會爆炸', fe.itemAnchors().length === 0 && fe.findItemLink('UX-21') === null);
}

console.log();
console.log('='.repeat(84));
console.log('⑦ 巡邏模式：下一站網址組法');
console.log('='.repeat(84));
{
  const pSrc = extract(src, ['patrolUrl']);
  const fn = new Function('location', pSrc + '\n return patrolUrl;');
  const pu = fn({ origin: 'https://mmtoyshop.com' });
  ck('已知網址 → 商品頁＋mmpatrol=1',
     pu({name:'UX-03', url:'https://mmtoyshop.com/item/ShopeeX'}) ===
     'https://mmtoyshop.com/item/ShopeeX?mmpatrol=1');
  ck('網址已有 query 用 & 接',
     pu({name:'A', url:'https://mmtoyshop.com/item/Y?a=1'}) ===
     'https://mmtoyshop.com/item/Y?a=1&mmpatrol=1');
  ck('網址帶 #fragment 會先剝掉（# 後面的 mmpatrol 會讀不到）',
     pu({name:'A', url:'https://mmtoyshop.com/item/Z#top'}) ===
     'https://mmtoyshop.com/item/Z?mmpatrol=1');
  const su = pu({name:'BXG-57', url:''});
  ck('沒網址 → 搜尋頁＋mmpatrol=1',
     su === 'https://mmtoyshop.com/category?keyword=BXG-57&mmpatrol=1', su);
  const cn = pu({name:'戰鬥陀螺 UX-21', url:''});
  ck('中文型號有 percent-encode', cn.indexOf('%E6%88%B0') > 0 && cn.indexOf('mmpatrol=1') > 0);
}

console.log();
console.log('='.repeat(84));
const bad = checks.filter(c => !c[1]);
console.log(bad.length ? `❌ ${bad.length} 項失敗：` + bad.map(b => b[0]).join('; ')
                       : `✅ 全部通過 (${checks.length}/${checks.length})`);
process.exit(bad.length ? 1 : 0);
