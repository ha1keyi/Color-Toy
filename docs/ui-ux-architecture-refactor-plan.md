# Color Toy UI/UX + Architecture Refactor Plan

Date: 2026-03-19

## Objectives

1. Raise usability baseline for accessibility and touch interactions.
2. Improve responsive behavior and visual hierarchy without changing product identity.
3. Reduce `src/main.ts` complexity by extracting UI orchestration logic into dedicated modules.
4. Keep behavior stable and verify with existing quality gate (`npm run check`).

## Scope

### In Scope


### Out of Scope (for this pass)


## Layout Studio / History — 位置与交互说明（优化提示词，供实现/PR 用）

目标：把 `History` 面板放到页面右下角（图片右侧、主操作面板下方），作为独立的底部操作模块；同时把 `Layout Studio` 保留为一个单独入口按钮，放置在主题切换（Dark/Light）按钮旁，默认为隐藏/待开发状态。重要约束是：在桌面端不改变图片预览的尺寸或布局优先级——仅改变面板的位置与层级。

说明（要点，便于实现时参考）：

- 位置与层级
  - `History` 面板应位于页面右下角：逻辑上在主操作面板（`#controls`）下方、图片预览的右侧位置，不应压缩或改变预览区域的可视尺寸（即不更改 `#preview-container` 或 `#app` 布局优先级）。实现层面可将 `#history-panel` 渲染到右下 `#bottom-bar`（或右下独立容器），并在 `src/ui/panels/panelState.ts` 中同步显示/隐藏逻辑。
  - `Layout Studio` 仅保留为一个入口按钮（放在 `#theme-toggle-btn` 附近），初始状态为不展示面板（按钮为待开发/隐藏功能）。点击该按钮当前不触发布局变更（点按为 inert），并在 UI 文档/tooltip 中标记“待开发”。

- 移动端（image-priority）行为
  - 底部模块栏在移动端的 image-priority 模式应始终为单行可横向滚动，而不是换行到多行。对应样式位于 `src/styles.css`（`.mobile-module-bar`），确保使用 `display: grid`/`flex` + `overflow-x: auto` 或 `white-space: nowrap` 实现横向滚动体验。
  - 当在底部栏点击某个 `preset` 时，展开内容应在底部栏上方弹出（向上展开），与其他模块的展开方式保持一致（避免遮挡或扩展到页面下方）。实现时检查 `#preset-section` 的定位逻辑与展开处理（相关代码参考 `src/presets/presetManager.ts` 或处理 preset 的 UI 逻辑），确保弹出层使用合适的 `position`/`transform`/`z-index`，并靠 `#bottom-bar` 锚定向上展开。
  - 当前发现的问题说明：preset 列表可能会展示到 `Layout Manager` 区域，且 `Layout` 按钮在某些情况下无响应。实现时需确保 preset 的弹出层不会把 `layout-manager-panel` 置于弹层之下；同时在将来启用 `Layout Studio` 功能前，`Layout` 按钮应保持隐藏或明确标注为“待开发”，避免用户点击后无反馈。

- 无侵入约定
  - 以上位置与展示调整**不得**改变图片优先的布局算法或压缩图片区域（不要把 `#controls` 的宽度作为可压缩区域）。任何 UI 更动都应通过额外容器或 `position`/`z-index` 调整实现，而非重设主栅格或 `--sidebar-width` 等全局布局变量。

- 实现参考文件（快速索引）
  - DOM / 入口： `index.html` （查找 `#history-panel`, `#layout-manager-panel`, `#theme-toggle-btn`, `#bottom-bar`, `#preset-section`）
  - 面板显示与移动端分流： `src/ui/panels/panelState.ts`
  - 布局模式与移动模块： `src/ui/layout/layoutState.ts`, `src/main.ts`（`setupMobileModuleBar` / `setMobileModuleSelection`）
  - Layout Studio 管理器（现有）： `src/ui/layout/layoutProfileManager.ts`（本功能目前只保留文档/入口）
  - 样式： `src/styles.css`（`.mobile-module-bar`, `#bottom-bar`, `#preset-section`, 面板折叠/压缩规则）
  - Preset 展开： `src/presets/presetManager.ts`（或项目中处理 preset 展开的模块）

- 可交付实现步骤（建议，后续执行时使用）
  1. 在 `index.html` 中把 `#history-panel` 的 DOM 挪到 `#bottom-bar`（或渲染到一个 `#bottom-right` 容器），并确保 `#panels` 仍保留其它模块。
  2. 在 `src/ui/panels/panelState.ts` 中把对 `history` 的显示/隐藏逻辑映射到新位置，同时保证 `updatePanelState` 在桌面端不会调整 `#preview-container` 尺寸。
  3. 在 `src/styles.css` 中为 `.mobile-module-bar` 强制单行横向滚动，调整 preset 弹出层样式使其向上展开（`bottom` 方向开口），并压缩折叠后面板的最小高度以减小占用空间。
  4. 在 `src/presets/presetManager.ts`（或 preset UI 处理处）修改展开逻辑：在移动端或窄视口优先把展开容器定位到 `#bottom-bar` 上方并增加足够的 `z-index`，避免穿透至 `layout-manager-panel`。
  5. 把 `Layout Studio` 的入口按钮放在 `#theme-toggle-btn` 附近，按钮初始为隐藏或加 `data-hidden="dev"` 标记并在 tooltip 中写明“待开发”。

如需，我可以基于此直接提交一个小的实现 PR（先移动 DOM、改 CSS，随后修正 preset 展开行为）。

## Findings Summary

### UX Risks (Highest)

1. Touch target sizes are below 44x44 for multiple controls.
2. Several icon-only actions rely on `title` and need stronger accessible labels.
3. Dense typography and tight spacing reduce readability on mobile.
4. Heavy manual panel toggling increases responsive fragility.

### Architecture Risks (Highest)

1. `src/main.ts` owns too many responsibilities (state reaction, panel visibility, resize flow, histogram scheduling, layout mode orchestration).
2. UI wiring and panel update logic are coupled with non-UI tasks.
3. Feature growth increases regression risk due to central coupling.

## Refactor Strategy

## Phase 1: UX Baseline Hardening

### Changes

- Normalize touch targets to minimum 44px for interactive controls.
- Improve keyboard/focus semantics for icon buttons and region controls.
- Increase base typography and control readability.
- Respect reduced motion preferences for non-essential effects.

### Files

- `index.html`
- `src/styles.css`

### Acceptance

- No critical control below 44px target on mobile.
- Keyboard focus ring remains visible on all key controls.
- Control labels remain readable and no horizontal overflow on 375px width.

## Phase 2: UI Orchestration Extraction

### Changes

- Move panel visibility and layout mode logic into dedicated module.
- Move slider/number synchronization and panel mirror updates out of `main.ts`.
- Keep `main.ts` as composition root (wiring and lifecycle only).

### Proposed New Modules

- `src/ui/layout/uiLayout.ts`
  - layout mode helpers
  - preview-controls split helpers
- `src/ui/panels/panelState.ts`
  - `updatePanelUI` and related DOM update helpers

### Acceptance

- `main.ts` no longer contains full panel DOM orchestration implementation.
- Behavior parity for module switching, split compare, and mobile layout modes.

## Phase 3: Validation and Cleanup

### Changes

- Run full checks and fix regressions.
- Confirm accessibility baseline manually on key paths.

### Acceptance

- `npm run check` passes.
- No obvious UX regression in image upload, layer switching, and compare workflows.

## Execution Order

1. Implement Phase 1 immediately.
2. Implement Phase 2 with minimal behavior change.
3. Run verification and finalize notes.

## Rollback Safety

- Keep renderer and store public APIs unchanged.
- Keep module extraction shallow (pure function extraction first).
- Avoid data model migration in this pass.

## Completed In This Pass

1. Added this plan file for follow-up execution and cross-session continuity.
2. Applied UI baseline upgrades for accessibility and touch:
  - critical control size uplift to 44px minimum targets
  - improved control semantics (`aria-label`, `aria-pressed`, `role=alert`, separator roles)
  - reduced-motion fallback for animation-heavy surfaces
3. Extracted UI logic from `src/main.ts` into dedicated modules:
  - `src/ui/panels/historyPanel.ts`
  - `src/ui/panels/panelControls.ts`
  - `src/ui/panels/panelState.ts`
4. Reduced `src/main.ts` responsibilities by delegating panel-state DOM updates to `updatePanelState(...)`.
5. Fixed pre-existing lint blockers in utility/debug scripts under flat ESLint config.
6. Verified full quality gate success via `npm run check` (typecheck + lint + tests + build).
7. Continued extraction by moving layout helpers into a dedicated module:
  - `src/ui/layout/layoutState.ts`
  - wired `main.ts` to shared layout helper APIs
8. Added regression tests for layout helper behavior:
  - `src/ui/layout/layoutState.test.ts`
9. Implemented high-freedom layout profile management end-to-end:
  - profile save/update/save-as/rename/delete flows in UI
  - profile import/export JSON support
  - profile application includes layout mode, mobile module selection, split view state, wheel pin state, ratios, and panel collapse map
10. Added schema-based layout profile model for future extensibility:
  - `src/ui/layout/layoutProfiles.ts` with `version` and `extensions` fields
  - supports array/single/wrapped JSON import formats for forward compatibility
11. Added tests for layout profile normalization and import/export behavior:
  - `src/ui/layout/layoutProfiles.test.ts`
