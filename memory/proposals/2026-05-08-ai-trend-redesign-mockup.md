# AI Trend Page Redesign — Mockup v1

**Date:** 2026-05-08
**Author:** Kuro
**Status:** Draft for Alex review (issues #39 / #40 / #43)
**Output target:** `mini-agent/kuro-portfolio/ai-trend/preview.html` (v2 → v3)
**Generator:** `mini-agent/scripts/build-ai-trend-preview.mjs`

---

## 為什麼要重做（context）

Alex 在 #39/#40/#43 連續提了三件事，整理成一個 redesign 命題：

1. **「直接開始做，mockup 好了的話可以先給我看」** — Alex 要 visible artifact，不要再 spec-only
2. **#40「你說不重疊 那不能一起用嗎？」** — TrendRadar zh-CN lane 跟既有 5 source 不重疊 → 應該並列為第 6 source
3. **#43 點評要：**
   - 關聯到的文章要連結（每條 take 都點得出原文）
   - 未來走向：上升趨勢 vs 下降趨勢 兩欄
   - SWOT 分析（對 AI 生態 / 對 Kuro 自己 二選一，傾向後者）
   - 介紹今天選出的 GitHub 專案（ex: `sansan0/TrendRadar`）

當前 `preview.html` v2 是「密集列表 + 每項閱讀原文」，已經滿足 #43 第一點（連結）。缺的是 **趨勢方向、SWOT、專案 spotlight、TrendRadar lane**。

---

## v3 版面骨架（top → bottom）

```
┌─────────────────────────────────────────────────────────┐
│  Today (Asia/Taipei) · 2026-05-08                       │
│  ── Kuro 點評（120 字 max，3 條主線判斷）─────           │
│  ① …                                                    │
│  ② …                                                    │
│  ③ …                                                    │
├─────────────────────────────────────────────────────────┤
│  ▲ 上升趨勢                  │  ▼ 下降趨勢              │
│  · agentic memory            │  · multi-agent rl        │
│  · small-model RAG           │  · prompt-only fine-tune │
│  · tool-use eval             │  · plain instruct-tune   │
│  （每項 1 句為什麼 + ref）   │                          │
├─────────────────────────────────────────────────────────┤
│  🔧 今日 GitHub 專案 spotlight                          │
│  sansan0/TrendRadar — keyword-driven news monitor       │
│  · 它做什麼：…                                           │
│  · 為什麼今天值得看：…                                   │
│  · 我接它的方式（已 ship Path 1 MCP wrapper）：…         │
│  · 還沒接的（Path 2 zh-CN lane / Path 3 keyword filter）│
├─────────────────────────────────────────────────────────┤
│  🪟 SWOT — Kuro 自己 vs 今日訊息流                       │
│  S 我擁有的            │  W 我缺的                       │
│  · 6 source 並列 lane │  · 沒 long-horizon eval        │
│  O 機會               │  T 威脅                         │
│  · MCP wrapper 是 moat│  · cron silent-fail 仍 23×     │
├─────────────────────────────────────────────────────────┤
│  📚 各 source 列表（v2 既有結構保留）                    │
│  · arXiv cs.MA / HN / Latent Space / GitHub / X / 【新】│
│    TrendRadar zh-CN — Path 2 上線後出現                  │
└─────────────────────────────────────────────────────────┘
```

---

## 區塊規格（generator 要新增的 data shape）

### Block A: Kuro 點評（top）
- **入料：** 今日 6 source 全文 → 我寫 3 條 1 句判斷
- **資料源：** 新檔 `memory/state/ai-trend-take-YYYY-MM-DD.md`（我自己寫，不是 LLM 生成）
- **fallback：** 沒寫就顯示「Kuro 今日未點評」+ 連到 issue tracker 讓 Alex 戳我

### Block B: 上升 / 下降趨勢
- **入料：** 比較今日 vs 過去 7 日 source 的 keyword frequency delta
- **資料源：** 新 script `scripts/ai-trend-direction.mjs` 產出 `state/ai-trend-direction-YYYY-MM-DD.json`
  - shape：`{rising: [{term, delta_pct, ref_url}], falling: [...]}`
- **演算法 v0（最笨可動）：** TF over recent 7d, today vs 7d-mean，top-5 by abs(delta_pct)
- **連結：** 每 term 點下去到當天該 source 的對應 anchor

### Block C: GitHub spotlight
- **入料：** `state/github-trending-{date}.json` → Kuro 從 top-N 選 1 個寫 4 段
- **資料源：** 新檔 `memory/state/ai-trend-spotlight-YYYY-MM-DD.md`（我自己寫）
- **規定欄位：** 它做什麼 / 為什麼今天值得看 / 我接它的方式 / 還沒接的
- **今日範例：** sansan0/TrendRadar — Path 1 MCP wrapper shipped (commit 09fc1d9), Path 2/3 待 Alex confirm scope

### Block D: SWOT — Kuro 自己
- **入料：** 我自己寫，不是 LLM 生成。用 KG entities `kuro:capability:*` + 今日 trend delta 對照
- **資料源：** 新檔 `memory/state/ai-trend-swot-YYYY-MM-DD.md`
- **scope：** 「Kuro 對今日訊息流」(自己 vs 環境)，不是 AI 產業總體 SWOT
- **每格 2-3 條，每條附 ref**

### Block E: source 列表（v2 既有）
- 加 6th lane：TrendRadar zh-CN trending（Path 2 上線後）
- 排序：按更新時間 desc
- 不變：每項閱讀原文 → outbound link

---

## TrendRadar 三 path 對應

| Path | 在 v3 哪裡呈現 | 狀態 |
|------|----------------|------|
| Path 1: MCP archive wrapper | Block C 提一句 + repo 連結 | ✅ shipped (09fc1d9) |
| Path 2: zh-CN lane | Block E 第 6 source | ⏳ 等 Alex confirm |
| Path 3: keyword pre-filter | Block B 用其 keyword pool 提升 direction quality | ⏳ 等 Alex confirm |

#40「不重疊那不能一起用嗎」的回答：**能。Path 2 走 Block E 並列、Path 3 灌進 Block B 演算法。互補不重疊。**

---

## 實作切片（建議 PR 順序）

1. **PR-A（最小）：** generator 加 Block A/C/D 三個 markdown loader，無 → fallback「未點評」。HTML/CSS 加版面。**0 行新 data fetch**，只渲染。
2. **PR-B：** 寫 `scripts/ai-trend-direction.mjs` + Block B 區塊。需要 7d historical，從 `state/*-trend-*.json` 既有 archive 讀，0 新 cron。
3. **PR-C：** Path 2 zh-CN lane → Block E 第 6 source。需要 cron entry 跟 TrendRadar API key，等 Alex confirm。
4. **PR-D：** Path 3 keyword pool 灌入 Block B。

每個 PR 自帶可觀察 artifact（preview.html 截圖差異）。

---

## 我自己要寫的 3 個 markdown（不是 LLM 生成）

每天 4 行各 1 個：
- `memory/state/ai-trend-take-2026-05-08.md` — 3 條主線判斷，每條 ≤ 40 字
- `memory/state/ai-trend-spotlight-2026-05-08.md` — 4 段 sansan0/TrendRadar
- `memory/state/ai-trend-swot-2026-05-08.md` — Kuro 對今日訊息流

第一天我先填好 demo 內容，generator 拿來渲染給 Alex 看樣子。

---

## 給 Alex 的決定點

選一條：

- **(a) 全做** — 4 個 PR 依序出。我從 PR-A 開始（最小 risk）。
- **(b) 只做 Block A + C + D** — 跳過趨勢/方向（要新 script），先把「點評 + 專案 + SWOT」三塊靜態渲染上線。
- **(c) 砍掉某 block** — 哪個你覺得不必要？
- **(d) 版面排序不對** — 講哪邊要換，我改 mockup v2。

我傾向 **(a)** 從 PR-A 開始，因為它 0 新 fetch、0 cron、純前端 + markdown loader，今天就能 ship 給你看真版面。

---

## 開放問題

1. SWOT 是 Kuro 自己 / AI 產業 / TM 平台？我預設 Kuro 自己，因為對 Alex 唯一 actionable。
2. 上升/下降趨勢的 reference window 是 7d 還是 30d？短窗噪音大，長窗反應慢。
3. GitHub spotlight 一天一個還是 top-3？一個 → 深度，三個 → 廣度。我傾向一個。
4. preview.html 部署到 kuro.page 還是只在 mini-agent dist？v2 目前是 dist only。

---

## Falsifier（給自己）

- 2026-05-09T00:00Z 前如果 PR-A 沒 push → 這份 mockup 變 phantom-spec，要降級成 issue close + reason
- Alex 24h 內無回覆 → 我自己挑 (a) 動 PR-A，不再等
