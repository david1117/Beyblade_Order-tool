# momo_grab 離線測試

不需要連 momo、不需要等開賣，全部用假時鐘／假 DOM 跑。
改動 `momo_grab.user.js` 之後先跑這三支再貼上瀏覽器。

```bash
cd D:\Funbox_beyblade\tests
npm install jsdom          # 只有 test_delivery.js 需要
node test_clock.js         # 對時精度（區間交集法 vs 舊法）
node test_handoff.js       # 預刷→重載→交接 的時序（8/15 UX-20 那個 bug）
node test_delivery.js      # selectDelivery 配送鎖定與偏好順序
```

`test_clock.js` 與 `test_delivery.js` 是直接從 `../momo_grab.user.js` 用字串抽出
函式原始碼來跑（`extract('函式名')`），**不是複製一份邏輯** —— 腳本改了測試就會測到新版。
函式改名時 `extract()` 的參數要一起改，否則會直接報 `not found`。

`test_handoff.js` 例外：它是一份**獨立重寫**的時序模擬（虛擬時鐘），不讀腳本原始碼。
所以改了 `RESUME_GRACE_MS`／`MIN_RELOAD_ROOM_MS`／`hardStop` 的邏輯之後，
要記得手動同步該檔頂端的同名常數。

## 目前基準（2026-08-15）

| 測試 | 項目 | 結果 |
|---|---|---|
| test_clock | 舊法誤差方向 | 2000/2000 全部偏晚 |
| test_clock | 舊法平均誤差 | ~520ms |
| test_clock | 新法（18 取樣）平均誤差 | 17～27ms |
| test_clock | scheduleAt 平均超時 | 3.1ms（舊版 100ms） |
| test_handoff | 舊版靜默放棄 / 新版救回 | 4 組情境救回 |
| test_delivery | 配送鎖定與偏好 | 7/7 |
