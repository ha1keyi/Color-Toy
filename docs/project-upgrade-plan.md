# Color Toy Project Upgrade Plan

## Goal

Build Color Toy into a more reliable, color-accurate, and production-ready image adjustment tool by improving engineering quality, rendering correctness, and editing workflow fundamentals.

## Current Snapshot

- Frontend stack: Vite + TypeScript + native DOM + Canvas 2D + WebGL
- Strengths: lightweight architecture, custom rendering pipeline, clear state model, no framework overhead
- Main gaps: engineering tooling is thin, automated validation is missing, color-management expectations are not documented, and some professional photo-editing workflow features are absent

## Review Findings

### 1. Engineering and Maintainability

- Add linting, formatting, tests, and CI to reduce regressions
- Keep `TypeScript` strict mode enabled and make it part of a repeatable `check` pipeline
- Expand `README` with development, validation, and release expectations

### 2. Image Editing Workflow

- Strengthen non-destructive editing semantics for every adjustment
- Make history more explicit, durable, and testable
- Add preset versioning and migration rules
- Improve keyboard-first workflows and tool discoverability

### 3. Color Accuracy

- Document the working color space and every gamma/linear transition
- Add tests around color conversion invariants and gamut compression behavior
- Plan import/export color profile handling and soft-proof style previews

### 4. Performance

- Audit high-frequency redraw paths and consolidate them behind `requestAnimationFrame`
- Consider `OffscreenCanvas` or worker-based histogram/wheel rendering for large images
- Add high-DPI rendering checks and benchmark repeatable render hotspots

### 5. Accessibility and Delivery

- Improve keyboard navigation, focus treatment, and `ARIA` labeling
- Add CI quality gates before shipping changes
- Harden `PWA` caching rules and document deployment assumptions

## Upgrade Roadmap

### Phase 1: Quality Baseline

- Add `ESLint`, `Prettier`, `Vitest`, and CI
- Add smoke-level unit tests for color and calibration math
- Add a single `npm run check` gate for local and CI usage

### Phase 2: Workflow Reliability

- Refine undo/redo behavior and test history boundaries
- Add preset schema versioning and import validation
- Separate transient UI state from edit state more clearly

## Completed After Phase 1

- Added preset import normalization, schema validation, and basic legacy migration behavior
- Added automated tests for preset import behavior and store undo/redo boundaries
- Improved invalid preset import feedback in the UI
- Replaced snapshot-only undo/redo with labeled command history that supports external edit sources such as the tone curve
- Added in-app history chain visualization with direct jump-to-state support
- Consolidated wheel and histogram redraw scheduling behind a shared `requestAnimationFrame` queue

## Completed In This Round (Color Accuracy + Pipeline)

- Added explicit working color space control in UI and render pipeline:
	- `Linear sRGB` (default)
	- `ACEScg` (working-space conversion inside shader pipeline)
- Added optional soft gamut compression toggle as a first-class processing control
- Kept processing in linear-light domain and made gamma transitions explicit in shader path:
	- Input: `sRGB -> Linear`
	- Processing: linear working space
	- Output: linear working space -> `Linear sRGB` -> `sRGB`
- Upgraded picker sampling precision:
	- configurable sampling radius (box average)
	- pixel coordinate readout for reproducible sampling
- Added ICC import detection from common containers:
	- JPEG `APP2 / ICC_PROFILE`
	- PNG `iCCP`
- Added export profile sidecar metadata (`.icc.json`) including:
	- working color space
	- gamut compression setting
	- detected source ICC metadata

## Completed In This Round (Mobile + PWA)

- Improved mobile responsive usability:
	- larger touch targets for key controls
	- safe-area aware layout (`env(safe-area-inset-*)`)
	- mobile-specific toolbar/panel spacing and overflow behavior
- Strengthened touch and pen interaction paths:
	- pointer-event handling for hold-compare interactions
	- pointer-event handling for split divider drag
	- pointer-based color-picker sampling on canvas
- Added adaptive high-DPI render scaling and mobile performance safeguards:
	- renderer-level dynamic render scale (`0.55` to `1.0`) based on pointer type, DPR, and device memory hints
	- texture-size constrained resize path to avoid oversized render targets
	- FPS-triggered adaptive scale + preview-resolution downgrade fallback
	- lighter histogram sampling budget on coarse-pointer devices
- Added baseline PWA delivery improvements:
	- `manifest.webmanifest` with install metadata and icons
	- service worker registration in app startup
	- `sw.js` offline shell cache + stale-while-revalidate asset strategy + cache version cleanup
	- mobile/PWA head metadata (`manifest`, mobile-web-app, Apple meta tags)

### ICC Embedding Limitation (Browser Runtime)

- Direct ICC profile embedding into browser-generated image blobs (`canvas.toBlob`) is not reliably controllable across browsers.
- Current implementation uses deterministic sidecar metadata as the safe fallback.
- For strict embedded ICC deliverables, recommended next step is a server-side or WASM encoder pipeline.

### Phase 3: Rendering and Color Management

- Profile wheel/histogram redraws and move expensive work off the main thread where practical
- Introduce explicit color-management documentation and profile-aware import/export roadmap
- Validate high-DPI and large-image behavior with repeatable fixtures

### Phase 4: Pro Editing Features

- Add soft-proof and gamut-warning previews
- Add richer export options and metadata/profile preservation
- Improve comparison modes and tool discoverability for calibration workflows

## Roadmap Status After This Upgrade

- Phase 1: Completed
- Phase 2: Completed baseline
- Phase 3: In progress with major completed parts
	- shared `requestAnimationFrame` scheduling for wheel/histogram completed
	- explicit working-space pipeline and UI controls completed
	- ICC import detection + export sidecar completed
- Phase 4: Not started in this pass

## Acceptance Criteria for Phase 1

- `npm run typecheck` passes
- `npm run lint` passes
- `npm run test:run` passes
- `npm run build` passes
- CI runs the same checks automatically

## Notes

- This document is intentionally implementation-oriented so it can stay aligned with real repository changes.
- The upgrades completed in this pass cover the full Phase 1 baseline except future test expansion.