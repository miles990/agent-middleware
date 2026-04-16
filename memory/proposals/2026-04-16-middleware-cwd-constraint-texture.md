# Middleware DAG Plan 失敗根因 + Constraint Texture 修復

日期：2026-04-16
作者：Claude Code（由 Alex 指示排查中台最近 DAG failures）
狀態：draft

## 症狀（觀測事實）

最近 3 個 failed plan（`acc-1776331400776-0`, `acc-1776331413967-1`, `acc-1776331435921-2`）全部都是同一個錯誤 pattern：

```
[ACCEPTANCE FAILED] file_exists:mesh-output/xxx.md
  — file not found: /Users/user/Workspace/agent-middleware/mesh-output/xxx.md
```

每個 plan 的故事都一樣：
1. Plan step A：researcher/coder SDK worker 寫檔到 `mesh-output/xxx.md`（相對路徑）
2. Step A 的 `acceptance_criteria` 是結構化 `file_exists` 搭配相對路徑 value
3. Worker LLM 自報「accepted=true」 — 從 LLM 視角它確實寫了檔
4. 中台 `evaluateStructuredAcceptance` 用 `process.cwd()` fallback 解析路徑 → `/Users/user/Workspace/agent-middleware/mesh-output/xxx.md` → 檔案不存在
5. Step A 被標 failed → 下游 dependent steps 連鎖 `Dependency failed`（skip）

## 根因分層

### 直接原因
SDK worker 寫檔時，檔案沒有落在中台進程 cwd 下，而是落在 worker subprocess 自己的 cwd（看起來被導向 `/Users/user/`，HOME）。

### 中間原因
中台 `lsof` 驗證進程 cwd = `/Users/user/Workspace/agent-middleware/`（正確）。但 Claude Agent SDK 透過 `query()` spawn 的 Claude Code CLI subprocess，即使 `options.cwd` 傳入 middleware cwd，subprocess 實際執行時仍會 reset 到其他目錄（2026-04-16 的手動 repro 顯示 `Shell cwd was reset to /Users/user/Workspace/mini-agent` 的 debug log）。

這不是中台 code path 的問題 — cwd 在 `sdk-provider.ts` 裡正確傳遞。但 SDK subprocess 層的行為不可控。

### 根本原因（Constraint Texture 視角）
這是典型 **prescription 型約束**的脆弱：

| 層次 | 目前設計（prescription） | 問題 |
|---|---|---|
| Acceptance | `file_exists: mesh-output/xxx.md`（相對路徑） | 依賴 "cwd = middleware cwd" 的 implicit assumption |
| Worker task | `Write to mesh-output/xxx.md` | 路徑模糊，worker 必須「猜」cwd 是什麼 |
| 跨進程 | cwd 從 middleware → SDK → CLI subprocess 會被 reset/override | implicit assumption 在 process boundary 失效 |

**結果**：同一個路徑字串在「worker 看到的 cwd」和「acceptance 檢查的 cwd」兩端不一致 → false-negative failure。

Worker 回報「做好了」符合 prescription 的字面，但終點（convergence condition）沒達到。

## 修復設計

### 原則

把 prescription 改成 convergence condition：worker 和 acceptance 都看到**絕對路徑**。中台統一解析、統一 inject、統一驗證。

### 三步修改

**改動 1：PlanEngine 知道自己的 middleware cwd**

`PlanEngineOptions` 新增 `cwd?: string` field。`evaluateStructuredAcceptance` 的 `file_exists` / `test_passes` case fallback 優先用這個 cwd（step.cwd > engine.cwd > process.cwd()）。

```typescript
export interface PlanEngineOptions {
  // ... existing
  /** Middleware's own cwd — used as fallback for path resolution in structured
   *  acceptance when step.cwd is not set. Threading this explicitly avoids relying
   *  on process.cwd(), which diverges from middleware cwd in edge cases. */
  cwd?: string;
}
```

**改動 2：Dispatch 前 prepend acceptance 絕對路徑到 task（CT 核心）**

在 `executeWithRetry` 的 dispatch 前，若 step 有 `file_exists` 結構化 acceptance 且 value 是相對路徑：
1. 基於 `step.cwd ?? engine.cwd ?? process.cwd()` 解析為絕對路徑
2. 在 resolved task 前 prepend 一段 convergence note：

```
[ACCEPTANCE CONDITION]
After this step completes, the file at the ABSOLUTE path below MUST exist:
/Users/user/Workspace/agent-middleware/mesh-output/xxx.md

Use this absolute path when writing. Do not rely on relative paths or cwd assumptions.

--- Original Task ---
{original task}
```

這讓 worker 看到無歧義的 convergence condition。worker 即使 cwd 被 reset 到哪裡，只要按絕對路徑寫，就會到對的位置。

**改動 3：api.ts 建構 PlanEngine 時傳入 cwd**

```typescript
const planEngine = new PlanEngine(executeWorker, {
  cwd,  // ← 新增
  getWorkerTimeoutSeconds: ...,
  onEvent: ...,
});
```

## 非目標（故意不做）

- **不動** SDK provider：cwd 傳遞鏈已經正確，問題在 subprocess 層，修 SDK 超出中台範圍
- **不動** worker system prompt：prepend 到 task 前比改 system prompt 更精確（per-step，不汙染共通 prompt）
- **不加** defensive path probing（例如同時查 HOME + middleware cwd）：那是 bandage，不是 structural fix
- **不改** Kuro 寫 plan 的 prompt：修中台一處 > 教每個 agent 記得寫絕對路徑

## 可逆性

L1 改動，git revert 可立即回退。不影響已有 plan format — `file_exists` 原本就是結構化 field，只是增強了解析和 dispatch 前處理。

## 驗證計畫

1. `pnpm typecheck` 通過
2. `pnpm build` 成功
3. 重啟 middleware，`/health` 回 200
4. 提交一個 minimal test plan：用 create worker 寫檔到 `mesh-output/test-cwd-fix.md`，acceptance `file_exists: mesh-output/test-cwd-fix.md`
5. 預期：step completed（不再 ACCEPTANCE FAILED），檔案出現在 `/Users/user/Workspace/agent-middleware/mesh-output/test-cwd-fix.md`
