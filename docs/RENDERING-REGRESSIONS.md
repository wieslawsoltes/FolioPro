# WebGPU rendering regressions

## Application defect: asynchronous startup race

The original compositor published `this.device` before awaiting shader compilation
and asynchronous pipeline creation. PDF rasterization could update the scene and
schedule a frame in that interval. That frame used an undefined pipeline (or
uniform buffer), fell back to Canvas 2D, and cleared `this.device`. The unfinished
initialization then announced WebGPU anyway. The UI hid the CPU canvases while
`render()` returned early because there was no device. This caused working
thumbnails, blank document pages, and a misleading WebGPU status label.

The fix keeps the device pending until the pipeline, uniform buffer, bind group
and sampler are complete, then publishes them without an intervening await. Scene
updates retain the newest geometry during initialization without scheduling an
incomplete frame. Generation checks invalidate asynchronous completions after
errors, device loss or disposal. Cleanup releases pending and live resources,
cancels queued frames, and restores the visible Canvas fallback. A stopped
compositor cannot initialize again.

## Separate CI defect: WebGPU canvas presentation

A minimal independent browser probe reproduced the remaining failure without any
Folio code. Buffer write/copy/map readback succeeded, but acquiring/presenting a
canvas texture lost the device with `A valid external Instance reference no longer
exists`. The native device-loss event preceded the application's cleanup call to
`destroy()`. This was not evidence of a second application-side destroy call.

The passing Linux configuration uses an Xvfb display, headless Chromium, explicitly
enabled GPU compositing, and compatible SwiftShader/Vulkan presentation:

```text
--enable-unsafe-webgpu
--use-angle=swiftshader
--enable-unsafe-swiftshader
--ignore-gpu-blocklist
--enable-gpu
--enable-features=Vulkan
--use-vulkan=swiftshader
```

`tests/browser_runtime.py` centralizes those test-only flags. The application does
not set flags or force a software adapter on users' browsers. CI provisions the
Vulkan runtime and virtual display and pins Playwright 1.62.0 / Chromium
151.0.7922.34. The recipe is supported by the independent reproduction in
[visgl/luma.gl#2874](https://github.com/visgl/luma.gl/issues/2874).

On this configuration, the probe's buffer readback, canvas clear/presentation,
external-image upload, and resize/presentation stages all succeeded. The five
application scenarios also passed, including actual on-screen page pixels:
[successful rendering run](https://github.com/wieslawsoltes/FolioPro/actions/runs/34149116127).
The captured adapter identifies itself as SwiftShader. This verifies actual
WebGPU APIs and browser presentation through a software adapter, not physical GPU
hardware, driver coverage, or performance benchmarks.

## Reproduce

```sh
npm test
npm run build
npm run check

# Linux test prerequisites (CI performs these steps):
python -m pip install playwright==1.62.0 Pillow==12.0.0
python -m playwright install --with-deps --no-shell chromium
sudo apt-get install -y mesa-vulkan-drivers libvulkan1 xvfb xauth
xvfb-run -a python tests/webgpu_probe.py
xvfb-run -a python tests/browser_rendering.py
```

Both scripts start the supplied server when testing locally. `FOLIO_URL` targets a
deployed build for the application suite; `FOLIO_CASES` selects comma-separated
scenarios. `CHROMIUM` overrides the executable, `FOLIO_HEADED=1` requests a visible
browser, and `FOLIO_BROWSER_FLAGS` supplies an explicit JSON array of Linux GPU
flags for diagnostics. Overriding those flags changes the verified configuration.
Only the generated example document is opened; no personal documents are used.

`npm test` runs 47 tests, including six deferred compositor lifecycle regressions.
All six fail against the original compositor and pass against the fix. Local
in-memory Canvas integration testing also passes 22 checks, including editing,
forms, imported PDFs, exported-file inspection and redaction. That suite is
separate from the secure-origin GPU tests.

`tests/browser_rendering.py` requires a real WebGPU device for normal, delayed
shader, and delayed pipeline startup. It tests intentional fallback for unavailable
WebGPU and rejected pipeline creation. Normal startup additionally checks resize,
scrolling to page two, zoom, rotation, and deliberate device-loss fallback. Pixel
checks also assert the expected compositor mode after capture, so an unintended
fallback cannot pass as a working WebGPU frame. Page errors and console errors
fail the suite. Screenshots, adapter/system information, event ordering and state
snapshots are retained as workflow artifacts.

## Deployment and generated artifacts

CI and Pages invoke the same reusable rendering workflow. Deployment requires the
Node tests, fresh standalone build, syntax checks, and browser rendering tests.
Pages then verifies the served HTML's SHA-256 and runs the normal rendering
scenario against the deployed HTTPS URL, including viewport operations and
intentional device loss. The post-deployment artifact is named
`live-rendering-verification`.

Generated `dist/` files are not tracked. Run `npm run build` to produce
`dist/index.html`, `dist/folio-pro.html`, and `dist/.nojekyll`. CI publishes the
standalone HTML as an artifact; Pages publishes the freshly built directory.
Runtime remains plain HTML/CSS/JavaScript with no additional app dependencies.
