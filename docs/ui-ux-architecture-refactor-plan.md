# Color Toy UI/UX + Architecture Refactor Plan

Date: 2026-03-19

## Objectives

1. Raise usability baseline for accessibility and touch interactions.
2. Improve responsive behavior and visual hierarchy without changing product identity.
3. Reduce `src/main.ts` complexity by extracting UI orchestration logic into dedicated modules.
4. Keep behavior stable and verify with existing quality gate (`npm run check`).

## Scope

### In Scope

- UI shell semantics in `index.html`.
- Control sizing, focus, spacing, and motion in `src/styles.css`.
- Split UI orchestration from `src/main.ts` into feature modules under `src/ui/`.
- Preserve current rendering pipeline (`src/gpu/renderer.ts`) and state model (`src/state/`).

### Out of Scope (for this pass)

- Rebuilding the renderer architecture.
- Replacing store implementation.
- Large redesign of visual language.

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
