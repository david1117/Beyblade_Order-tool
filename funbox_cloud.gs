/************************************************************
 * Funbox 上架監控 — 雲端版（Google Apps Script）
 *
 * 跑在 Google 的伺服器上，24 小時偵測，電腦關機也會推播。
 * 只做「偵測 + Telegram 通知」，不加入購物車（雲端不放你的登入 cookie，較安全）。
 * 上架時手機收到通知 → 點連結開商品頁（手機已登入 funbox）→ 自己加入結帳。
 *
 * 安裝步驟：
 *   1. 到 https://script.google.com → 新增專案，把這整段貼進去。
 *   2. 填好下面三個設定（TELEGRAM_TOKEN、CHAT_ID、KEYWORDS）。
 *      TELEGRAM_TOKEN / CHAT_ID 跟 PC 版用的同一組即可。
 *   3. 上方選函式 checkFunbox → 按「執行」一次 → 依提示授權（第一次要點允許）。
 *      執行成功手機應收到「雲端監控已啟動」測試訊息。
 *   4. 左側「觸發條件(Triggers)」→ 新增觸發條件：
 *        函式 checkFunbox、時間驅動、分鐘計時器、每 5 分鐘（或每分鐘）。
 *   5. 完成。之後 PC 關機也會通知。
 ************************************************************/

// ===== 設定（改這裡就好）=====
var TELEGRAM_TOKEN = "";   // 你的 Telegram bot token
var CHAT_ID        = "";   // 你的 chat id
var KEYWORDS = [
  "UX-04",
  "UX-11",
  "UX-03",
  "UX-20",
  "UX-21",
  "BX-35",
  "UX-15",
  "BX-09",
  "多美動物 AL-37 斑馬",
  "TOMICA Premium 載運車-日產GT-R Nismo",
  "TOMICA Premium 無極限 迷你四驅車Brocken Gigant"
];
// ==============================

var BASE = "https://shop.funbox.com.tw";

function checkFunbox() {
  var props = PropertiesService.getScriptProperties();

  // 啟動測試訊息（只在第一次跑時發一次）
  if (props.getProperty("__started") !== "1") {
    sendTelegram("✅ Funbox 雲端監控已啟動", "設定成功，商品上架會通知你。", "");
    props.setProperty("__started", "1");
  }

  KEYWORDS.forEach(function (kw) {
    var key = "notified_" + kw;
    try {
      var searchUrl = BASE + "/search?q=" + encodeURIComponent(kw) + "&sort_by=sell_from-desc";
      var html = UrlFetchApp.fetch(searchUrl, { muteHttpExceptions: true, followRedirects: true }).getContentText();

      var notFound = html.indexOf("找不到任何東西") !== -1;
      var m = html.match(/\/products\/([A-Za-z0-9_-]+)/);
      var listed = !notFound && !!m;

      if (!listed) {                       // 沒上架 → 清掉狀態，下次上架會再通知
        props.deleteProperty(key);
        return;
      }

      // 抓商品頁確認是否可購買
      var purl = BASE + "/products/" + m[1];
      var phtml = UrlFetchApp.fetch(purl, { muteHttpExceptions: true }).getContentText();
      var soldOut = /售完|已售完|補貨中|缺貨中/.test(phtml);
      var buyable = phtml.indexOf("加入購物車") !== -1 && !soldOut;

      var already = props.getProperty(key) === "1";
      if (buyable && !already) {
        sendTelegram("🔔 上架可買：" + kw, "", purl);
        props.setProperty(key, "1");       // 記住已通知，避免每次重複推
      } else if (!buyable) {
        props.deleteProperty(key);         // 又變不可買 → 重置
      }
    } catch (e) {
      // 單一關鍵字出錯不影響其他，靜默略過
    }
  });
}

function sendTelegram(title, text, url) {
  if (!TELEGRAM_TOKEN || !CHAT_ID) return;
  var body = title + (text ? "\n" + text : "") + (url ? "\n" + url : "");
  var payload = { chat_id: CHAT_ID, text: body };
  if (url) {
    payload.reply_markup = JSON.stringify({
      inline_keyboard: [[{ text: "🛒 開商品頁準備結帳", url: url }]]
    });
  }
  UrlFetchApp.fetch("https://api.telegram.org/bot" + TELEGRAM_TOKEN + "/sendMessage", {
    method: "post",
    payload: payload,
    muteHttpExceptions: true
  });
}
