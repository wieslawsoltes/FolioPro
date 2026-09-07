# WebGPU startup race regression

The original compositor published `this.device` before awaiting shader compilation
and asynchronous pipeline creation. PDF rasterization could update the scene and
schedule a frame in that interval. That frame used an undefined pipeline (or
uniform buffer), fell back to Canvas 2D, and cleared `this.device`. The unfinished
initialization then announced WebGPU anyway. The UI hid the CPU canvases while
`render()` returned early because there was no device. This explains a working
thumbnail sidebar, blank document pages, and a misleading WebGPU status label.

## Fix

Keep the device pending until the pipeline, uniform buffer, bind group and sampler
are complete, then publish them without an intervening await. Scene updates keep
the latest geometry during initialization without scheduling an incomplete frame.
Generation checks invalidate asynchronous completions after errors, device loss or
disposal. Cleanup releases both pending and live resources and cancels queued
frames. A stopped compositor cannot initialize again.

## Tests

`npm test` includes deterministic deferred shader/pipeline tests and tests for
failure, disposal, device loss, and pipeline rejection during initialization. All
six new tests fail against the original compositor; all pass with the fix.

`tests/browser_rendering.py` navigates to a real localhost origin (not an
in-memory `set_content` document), requires an actual WebGPU device, and inspects
composited screenshots. CI runs Chromium with the software SwiftShader adapter;
it does not claim physical GPU coverage. It covers normal startup, delayed shader
compilation, delayed pipeline creation, unavailable WebGPU, and rejected pipeline
creation. Normal startup also exercises resize, page scrolling, zoom, rotation,
and device-loss fallback. Delays wrap real WebGPU methods, not a fake renderer.
Screenshots and state snapshots are uploaded even on failure.

Both CI and Pages invoke the reusable browser workflow. Pages deployment is gated
on rendering tests, preserves HTTPS/SHA-256 checks, and then runs an additional
rendering smoke test against the deployed URL.

## Build artifacts

Generated `dist/` files are no longer checked in, avoiding a stale standalone app
in the repository. Run `npm run build` to produce `dist/index.html`,
`dist/folio-pro.html`, and `dist/.nojekyll`. CI publishes the standalone HTML as an
artifact; GitHub Pages publishes the freshly built directory. Runtime remains
plain HTML/CSS/JavaScript with no additional application dependencies.
