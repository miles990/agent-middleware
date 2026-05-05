# Dedup Proposal: mini-agent × agent-middleware 功能重疊盤點

> 2026-04-20 · Claude Code delegate · source cycle 2026-04-20T00:24

## 背景

Alex directive（CLAUDE.md §三層架構 + BAR）：所有 `<kuro:delegate>` 統一走中台 `/accomplish`，Brain Always Routes。本 proposal 的下游任務是找出 mini-agent 中哪些模組是「mini-agent 自建了中台已有對等能力的功能」，決定哪些應該下沉為中台 worker 呼叫，哪些應該留在 mini-agent 本地。

調查範圍：mini-agent `src/`（TypeScript）+ `plugins/`（shell scripts）對照 agent-middleware `src/`（workers + brain + plan-engine + commitment-ledger）。

---

## 1. Inventory 表格

### 1.1 agent-middleware 側

| 模組名稱 | 路徑 | 一句話功能 |
|---------|------|-----------|
| `brain.ts` | `src/brain.ts` | 接收 goal + 約束，產出 DAG plan（雙模：直接 dispatch 或 /accomplish 規劃） |
| `plan-engine.ts` | `src/plan-engine.ts` | 純 DAG 執行器：streaming dispatch、step retry、convergence loop、per-worker 並行限制 |
| `workers.ts` | `src/workers.ts` | 所有 worker 定義（researcher/coder/reviewer/shell/analyst/explorer/learn/create/planner/debugger/summarizer/classifier/extractor/scorer/agent-brain/web-fetch/web-browser/web-verify/cloud-agent/ci-trigger/google-oauth） |
| `commitment-ledger.ts` | `src/commitment-ledger.ts` | 跨 cycle 承諾 JSONL 帳本：create/patch/query，owner 欄位支援多 agent |
| `content-adapter.ts` | `src/content-adapter.ts` | 把不同格式（markdown/JSON/raw text）轉為 worker 可接受的統一 input |
| `result-buffer.ts` | `src/result-buffer.ts` | 非同步結果快取：dispatch 後 poll 取結果，防止 caller event loop 阻塞 |
| `progress-timeout.ts` | `src/progress-timeout.ts` | 進度型 timeout：無 stdout N 秒 → stall-kill（獨立於 wall-clock cap） |
| `webhook-dispatcher.ts` | `src/webhook-dispatcher.ts` | 把 task 結果 POST 回 callbackUrl，支援 DLQ（`webhook-dlq.jsonl`） |
| `forge-client.ts` | `src/forge-client.ts` | 從中台側呼叫 forge-lite.sh 建立/merge worktree |
| `ci-trigger.ts` | `src/ci-trigger.ts` | 觸發 GitHub Actions workflow 並 poll 等待結果 |

### 1.2 mini-agent 側

| 模組名稱 | 路徑 | 一句話功能 |
|---------|------|-----------|
| `perception-analyzer.ts` | `src/perception-analyzer.ts` | 用 Haiku 並行分析每個 perception plugin 的原始輸出，產出 `SituationReport` |
| `feedback-loops.ts` | `src/feedback-loops.ts` | 三個 fire-and-forget 自我學習迴路：Loop A（error pattern）、Loop B（perception citation tracking）、Loop C（decision quality audit） |
| `github.ts` | `src/github.ts` | 四個 fire-and-forget GitHub 機械自動化：proposal→issue、close issue、auto-merge PR、track new issues |
| `commitments.ts` | `src/commitments.ts` | 本地承諾追蹤：從 response 抽取承諾、按 cycle 標記兌現/逾期，注入 `<commitments>` context section |
| `small-model-research.ts` | `src/small-model-research.ts` | 把結晶化方法論 + 感知信號組裝成小模型 prompt，委派本地 oMLX/ollama 做研究 |
| `research-crystallizer.ts` | `src/research-crystallizer.ts` | 從研究 observations 提煉方法論，持續演化小模型研究品質 |
| `delegation.ts` | `src/delegation.ts` | 所有 `<kuro:delegate>` 路由到中台 `/plan` 或 `/accomplish`，管理 forge slot、result tracking |
| `middleware-client.ts` | `src/middleware-client.ts` | 型別安全的中台 HTTP client（dispatch/plan/accomplish/status） |
| `mushi-client.ts` | `src/mushi-client.ts` | 呼叫 mushi System 1 的 triage/dedup/route HTTP API |
| `achievements.ts` | `src/achievements.ts` | 遊戲化里程碑系統：偵測 visible output 解鎖成就，Telegram 通知 |
| `perception-stream.ts` | `src/perception-stream.ts` | 每個 plugin 獨立 interval 運行，`distinctUntilChanged` + cache，`buildContext()` 直讀 |
| `perception.ts` | `src/perception.ts` | 執行 shell perception plugins，回傳 `PerceptionResult[]` |

---

## 2. Overlap 矩陣

| mini-agent 模組 | agent-middleware 對應 | 重疊程度 | 說明 |
|----------------|----------------------|---------|------|
| `perception-analyzer.ts` | `summarizer` worker | 高 | 兩者都用 Haiku 把原始文字 → 結構化摘要；差異在 mini-agent 是直接 SDK call，中台是 dispatch worker |
| `feedback-loops.ts` Loop A（error pattern） | `classifier` + `scorer` worker | 中 | 錯誤分群邏輯可改為 dispatch classifier；但狀態（`error-patterns.json`）和 HEARTBEAT 寫入是 mini-agent 本地責任 |
| `feedback-loops.ts` Loop C（decision quality） | `scorer` worker | 中 | observabilityScore 計算是 rubric-driven，可走 scorer；但 sliding window state 和 flag file 要留本地 |
| `github.ts` | `ci-trigger` worker + `shell` worker | 中 | `autoMergeApprovedPR` 和 `autoCreateIssueFromProposal` 用 `gh` CLI，和 `ci-trigger` worker 的 `gh` 呼叫完全重疊；但目前是 fire-and-forget 無 acceptance |
| `commitments.ts` | `commitment-ledger.ts`（中台） | 高 | 兩個系統都追蹤「說了要做的事」，schema 相似（text/status/created/resolved）；差異：mini-agent 用 cycle-count 計時，中台用 wall-clock + owner 欄位 |
| `small-model-research.ts` | `learn` worker | 高 | 兩者都是「深度理解一個 topic，產出原則 + mental model」；差異：mini-agent 走本地 oMLX，中台走 Haiku SDK |
| `mushi-client.ts` triage | `classifier` worker | 低 | mushi 是 sub-100ms System 1（Taalas HC1），中台 classifier 是 Haiku ~5s；速度差距讓這個替換沒有 ROI |
| `delegation.ts` | `plan-engine.ts` + `brain.ts` | 低（已整合） | delegation.ts 已經是中台的 caller，不是重疊而是分工 |

---

## 3. Top 3 遷移候選（按 ROI 排序）

### 候選 1：`perception-analyzer.ts` → 中台 `summarizer` worker

**目前位置**：`src/perception-analyzer.ts` L121（`analyzePerceptions`）

**使用頻率**：
```
grep -r "analyzePerceptions\|perception-analyzer\|isAnalysisAvailable" /Users/user/Workspace/mini-agent/src/ --include="*.ts" | wc -l
# 結果：5
```
呼叫鏈：`perception-stream.ts` 匯入 → 每次 perception plugin 執行完 → `analyzePerceptions()` 並行呼叫 Haiku SDK。

**中台對應**：現有 worker `summarizer`（`workers.ts` L261）

`summarizer` 的 description 明確寫：「Use for: perception summarization (externalize from local oMLX)」— 這不是巧合，是設計意圖。

**遷移後收益**：
- mini-agent 主 event loop 不再持有 Anthropic SDK client 做 perception 分析（目前 `perception-analyzer.ts` 直接 `new Anthropic()`）
- `ANTHROPIC_API_KEY` 在 mini-agent 的 launchd 環境可完全移除（coach.ts 已走 Claude CLI subprocess 繞過此問題，perception-analyzer 是殘留的直接 SDK 用戶）
- perception-stream 每個 plugin interval 觸發時改為 `middleware.dispatch({ worker: 'summarizer', task: rawOutput })`，非同步 poll；主 cycle 讀 cache 不阻塞
- 中台 `summarizer` maxConcurrency=6，可吸收 perception 並行分析的 burst，mini-agent 不需要自己管 Promise.all + race timeout

**遷移風險**：
- 介面差異：目前 `analyzePerceptions()` 回傳 `SituationReport`（含 `insights[]` + `totalTokens`），中台 `summarizer` 回傳 `{summary, key_points[], confidence}`。caller（`perception-stream.ts`）需要 adapter 把 middleware JSON → `SituationReport`
- 時序要求：目前 perception-stream 在 plugin 執行後立即 analyze（同 interval loop），改為 dispatch 後需 poll；perception cache entry 的 `updatedAt` 語義需調整（plugin 執行完 vs 分析完）
- 中台離線：`isAnalysisAvailable()` 目前 fallback 到 raw truncated output；中台離線時要保持相同 fallback，在 `middleware-client.ts` 加 timeout + fallback 即可

---

### 候選 2：`commitments.ts`（本地）→ 統一走中台 `commitment-ledger.ts`

**目前位置**：`src/commitments.ts` L1（整個模組，273 行）

**使用頻率**：
```
grep -r "commitments\|extractCommitments\|updateCommitments\|CommitmentsState" /Users/user/Workspace/mini-agent/src/ --include="*.ts" | wc -l
# 結果：56
```
呼叫鏈：`dispatcher.ts`（每次 response 後 extract）→ `loop.ts`（每 cycle 後 update + inject context）→ `prompt-builder.ts`（buildContext 注入 `<commitments>` section）。

**中台對應**：`src/commitment-ledger.ts`（中台已建，schema 含 owner 欄位）

中台 `commitment-ledger.ts` 的 `CommitmentChannel` 已有 `'inner' | 'delegate' | 'room' | 'user-prompt'`，直接對應 mini-agent 的承諾來源。中台已有 REST endpoint（`POST /commit`、`PATCH /commit/:id`、`GET /commits`）。

**遷移後收益**：
- 消除雙軌：mini-agent `commitments.ts`（cycle-count 計時）和中台 `commitment-ledger.ts`（wall-clock + DAG 連結）描述同一件事，兩套並存造成不一致
- 中台的承諾帳本支援 `linked_dag_id`，可把「承諾 → delegate DAG → 結果」閉環在中台完成，mini-agent 只需 poll `/commits?owner=kuro&status=active` 注入 context
- 跨 restart 狀態在中台持久（JSONL），mini-agent crash 不丟失承諾狀態

**遷移風險**：
- 介面差異：mini-agent 用 `cycleCreated` / `cycleDeadline`（相對 cycle 計數），中台用 `created_at` / ISO 時間。context section `<commitments>` 的 deadline 提示要改為「X cycles ago」→「since YYYY-MM-DD HH:mm」或「overdue: Xh」
- 狀態依賴：`buildContext()` 目前同步讀本地 JSON（`getMemoryStateDir()`），改為 HTTP GET 加 latency；需在 prompt-builder 加 `await` + fallback（中台離線時顯示「commitments unavailable」而非 crash）
- 56 個引用點需要逐一確認是否直接呼叫本地函數，或已有 middleware-client 橋接層

---

### 候選 3：`github.ts` 四個 fire-and-forget 函數 → 中台 `ci-trigger` + `shell` worker DAG

**目前位置**：`src/github.ts` L36（`autoCreateIssueFromProposal`）、L130（`autoCloseCompletedIssues`）、L202（`autoMergeApprovedPR`）、L243（`autoTrackNewIssues`）

**使用頻率**：
```
grep -r "github\|autoMergeApprovedPR\|autoCreateIssue\|autoTrackNewIssues\|autoCloseCompleted" /Users/user/Workspace/mini-agent/src/ --include="*.ts" | wc -l
# 結果：9
```
呼叫鏈：`loop.ts` / `cycle-tasks.ts` 每個 OODA cycle 結束後呼叫，全部 fire-and-forget（`.catch(() => {})`）。

**中台對應**：`ci-trigger` worker（`workers.ts` L328）+ `shell` worker（`workers.ts` L106）

`ci-trigger` backend 直接執行 `gh` CLI 命令並 poll workflow；`shell` worker 執行任意 shell 命令（`gh issue create`、`gh pr merge` 等）。把現有邏輯翻譯為中台 DAG plan 只需要把 shell commands 對應到 plan steps。

**遷移後收益**：
- 每個 gh 操作有獨立 step-level retry（`ci-trigger`/`shell` worker 的 `maxRetries`），目前 mini-agent 側 try-catch 靜默失敗沒有重試
- `autoMergeApprovedPR` 的雙重條件（approved + CI pass）可以表達為 DAG condition 節點，比目前的巢狀 if 更清晰
- `gh` CLI 的網路呼叫離開 mini-agent 主 event loop，不再競爭 process fd
- 中台 `ci-trigger` 有 `healthCheck: 'gh auth status > /dev/null 2>&1'`，自動偵測未認證並觸發 `healthFix: 'gh auth login'`，mini-agent 的 `ghAvailable()` 可以刪除

**遷移風險**：
- 介面差異：目前直接讀本地 `memory/proposals/` 目錄（`fs.readdirSync`）；改為 dispatch 後，shell step 的 cwd 必須是 mini-agent repo root（中台 dispatch 需傳 `cwd: '/Users/user/Workspace/mini-agent'`）
- 時序要求：目前四個函數是 fire-and-forget，loop cycle 不等待結果。改為 dispatch 後依然可以 fire-and-forget（不 await poll），結果寫中台 `results.jsonl` 供稽核
- 狀態依賴：`autoTrackNewIssues` 寫 `memory/handoffs/active.md`（本地 file），shell worker 在中台跑時路徑需用絕對路徑或掛載 bind mount；這是唯一有副作用寫回 mini-agent 本地 memory 的操作，要謹慎

---

## 4. 不該搬的項目

### 4.1 `feedback-loops.ts` Loop B（perception citation tracking）— 看起來可搬但不該搬

**理由**：Loop B 的核心是讀 `perceptionStreams.adjustInterval(name, ms)`，這是 mini-agent `perception-stream.ts` 的 in-process singleton 方法。把統計放到中台意味著每次要調頻都需要一次 HTTP 呼叫回來改 mini-agent 的 perception interval，這是跨進程的 side effect，遠比現在複雜。Loop B 的 state（`perception-citations.json`）也只有 mini-agent 能有意義地解釋（plugin 名字 vs citation 文字的 matching 邏輯強耦合 buildContext 的 section tag 格式）。

### 4.2 `mushi-client.ts` triage 邏輯 — 看起來可用 classifier worker 替換但不該搬

**理由**：mushi 是 sub-100ms System 1（Taalas HC1 模型），`mushiTriage()` 設計目標是比啟動一個 OODA cycle 更快。中台 `classifier` worker 用 Haiku，每次 dispatch 包含 HTTP overhead + Haiku 冷啟動，實測至少 5-8 秒。triage 的功能是「決定要不要跑 cycle」，如果 triage 本身比 cycle 還慢，意義消失。mushi 和中台是正交關係——mushi 決定 cycle 要不要發生，中台決定 cycle 內的 delegate 怎麼跑。

### 4.3 `achievements.ts` — 看起來是輸出行為但不該搬

**理由**：achievements 的觸發條件是讀 mini-agent 的 behavior log、NEXT.md、delegation status，這些都是 mini-agent 本地的 file-based state。搬到中台後要把所有這些 context 傳過去才能判斷，payload 遠大於 Telegram 通知本身。achievements 是 Kuro identity 的一部分（`SOUL.md` 連動），放在中台會破壞「只有 Kuro 寫 memory、發 Telegram」的身份邊界原則。

### 4.4 `perception-stream.ts` + `perception.ts` — 看起來可外包感知但不該搬

**理由**：感知層是 Kuro 的 Umwelt（感知世界），每個 plugin 讀的是本機 local state（`~/.mini-agent/`、CDP port 9222、launchd daemon list）。中台沒有、也不應該有這些本地資源的直接存取權。感知的執行必須在 mini-agent 本地，唯一可搬的是「分析感知輸出」這一步（已列為候選 1）。

---

## 5. 下游任務參考

| id | 動作 | 執行者 | dependsOn | 完成條件 |
|----|------|--------|-----------|---------|
| T1 | 讀本 proposal，把「走中台 vs 前景」判斷準則補充進 `memory/SOUL.md` 或 `skills/delegation.md` | Kuro | — | delegation.md 有明確條件說明哪些 delegate 類型走 `/accomplish`、哪些走直接 SDK call |
| T2 | 實作 perception-analyzer → summarizer worker 橋接：`perception-stream.ts` 改為 dispatch + poll，加 fallback | Claude Code | — | `pnpm typecheck` 通過 + perception cache 在中台離線時仍填充 raw truncated output |
| T3 | 統一承諾帳本：mini-agent `commitments.ts` 改為 HTTP client 呼叫中台 `/commit` endpoint，移除本地 JSONL | Claude Code | T2 | `grep -r "CommitmentsState\|getCommitmentsState" src/ \| wc -l` = 0，所有引用改走 middleware-client |
| T4 | github.ts 四個函數改為中台 DAG dispatch（shell/ci-trigger worker），保留 fire-and-forget 語義 | Claude Code | — | `autoMergeApprovedPR` 走中台後，merge 操作有 step-level retry log 可查 |

---

<!-- generated by delegate dedup-inventory, source cycle 2026-04-20T00:24 -->
