"""Secure-origin, real WebGPU rendering regressions (SwiftShader in CI).

python -m pip install playwright==1.57.0 Pillow==12.0.0
python -m playwright install --with-deps chromium
npm run build && python tests/browser_rendering.py

FOLIO_URL optionally targets a deployed build instead of starting the local server.
FOLIO_CASES is a comma-separated subset. No user PDFs are loaded or uploaded.
"""
import asyncio
import io
import json
import os
import subprocess
from pathlib import Path
import sys

from PIL import Image
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'tests/out/rendering'
OUT.mkdir(parents=True, exist_ok=True)
CASES = os.environ.get('FOLIO_CASES', 'normal,delayed-shader,delayed-pipeline,no-webgpu,pipeline-rejected').split(',')
SNAPSHOT = """() => ({
    secure: isSecureContext, mode: folio.gpu.mode, reason: folio.gpuReason || '',
    device: !!folio.gpu.device, pipeline: !!folio.gpu.pipeline,
    uniform: !!folio.gpu.uniform, gpuClass: document.body.classList.contains('gpu-on'),
    textures: folio.gpu.textures.bytes, draws: folio.gpu.draws.length,
    readyPages: [...folio.views.values()].filter(v => v.result).length,
    frame: folio.gpu.frame, events: window.__gpuEvents || []
})"""

async def settle(page):
    await page.evaluate("""async () => {
        folio.updateGpu();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (folio.gpu.device) await folio.gpu.device.queue.onSubmittedWorkDone();
    }""")
    await page.wait_for_timeout(150)

async def pixels(page, label, index=0):
    """Inspect composited screen pixels, not only CPU rasters or status labels."""
    await settle(page)
    await page.screenshot(path=str(OUT / f'{label}-workspace.png'))
    data = await page.locator('.paper').nth(index).screenshot(path=str(OUT / f'{label}-page.png'))
    image = Image.open(io.BytesIO(data)).convert('RGB')
    image.thumbnail((256, 256))
    values = list(image.getdata())
    white = sum(min(p) > 245 for p in values) / len(values)
    dark = sum(max(p) < 180 for p in values) / len(values)
    assert white > .25 and dark > .002, f'{label}: page pixels are blank (white={white:.3f}, dark={dark:.3f})'
    print(f'PASS pixels {label}: white={white:.3f}, dark={dark:.3f}', flush=True)

async def scenario(browser, case, url, results):
    context = await browser.new_context(viewport={'width': 1666, 'height': 1000}, device_scale_factor=1)
    page = await context.new_page()
    await page.add_init_script("""
        window.__gpuEvents = [];
        const record = (event, details = {}) => window.__gpuEvents.push({event, time: performance.now(), ...details});
        if (globalThis.GPUDevice) {
            const destroy = GPUDevice.prototype.destroy;
            GPUDevice.prototype.destroy = function() {
                record('destroy', {stack: new Error('GPUDevice.destroy').stack});
                return destroy.call(this);
            };
            const request = GPUAdapter.prototype.requestDevice;
            GPUAdapter.prototype.requestDevice = async function(...args) {
                const device = await request.apply(this, args);
                record('device', {adapter: {vendor: this.info?.vendor, architecture: this.info?.architecture, description: this.info?.description}});
                device.addEventListener('uncapturederror', e => record('error', {message: e.error.message}));
                device.lost.then(info => record('lost', {reason: info.reason, message: info.message}));
                return device;
            };
        }
    """)
    errors, console_errors = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('console', lambda msg: console_errors.append(msg.text) if msg.type == 'error' else None)
    entry = {'case': case}
    results.append(entry)
    try:
        if case.startswith('delayed-'):
            target = 'GPUShaderModule' if case == 'delayed-shader' else 'GPUDevice'
            method = 'getCompilationInfo' if case == 'delayed-shader' else 'createRenderPipelineAsync'
            await page.add_init_script(f"""
                const original = {target}.prototype.{method};
                {target}.prototype.{method} = async function(...args) {{
                    if (!window.__gpuDelayEntered) {{
                        window.__gpuDelayEntered = true;
                        await new Promise(resolve => window.__releaseGpu = resolve);
                    }}
                    return original.apply(this, args);
                }};
            """)
        elif case == 'no-webgpu':
            await page.add_init_script("Object.defineProperty(navigator, 'gpu', {value: undefined});")
        elif case == 'pipeline-rejected':
            await page.add_init_script("GPUDevice.prototype.createRenderPipelineAsync = async () => { throw Error('Injected pipeline rejection'); };")
        await page.goto(url, wait_until='load')
        if case.startswith('delayed-'):
            await page.wait_for_function('window.__releaseGpu && window.folio && [...folio.views.values()].some(v => v.result)', timeout=30000)
            await settle(page)
            entry['duringInitialization'] = await page.evaluate(SNAPSHOT)
            await page.evaluate('folio.updateGpu()')
            await settle(page)
            await page.evaluate('window.__releaseGpu()')
        await page.wait_for_function('window.folio?.ready && [...folio.views.values()][0]?.result', timeout=30000)
        await settle(page)
        entry['state'] = await page.evaluate(SNAPSHOT)
        print(json.dumps(entry), flush=True)
        await page.screenshot(path=str(OUT / f'{case}-initial.png'))
        state = entry['state']
        assert state['secure'], 'WebGPU tests must navigate to a secure/trustworthy origin; set_content is not sufficient'
        if case in ('no-webgpu', 'pipeline-rejected'):
            assert state['mode'] == 'Canvas 2D' and not state['gpuClass'] and not state['device'], state
            if case == 'pipeline-rejected':
                assert 'Injected pipeline rejection' in state['reason']
        else:
            assert state['mode'] == 'WebGPU' and state['device'] and state['pipeline'] and state['uniform'], state
            assert state['gpuClass'] and state['textures'] > 0, state
        await pixels(page, case)
        if case.startswith('delayed-'):
            before = entry['duringInitialization']
            assert not before['device'] and not before['gpuClass'] and not before['reason'], before
        if case == 'normal':
            await page.set_viewport_size({'width': 1500, 'height': 950})
            await page.evaluate("folio.fit('page')")
            await pixels(page, 'resize')
            await page.evaluate('folio.goTo(1, false)')
            await page.wait_for_function('[...folio.views.values()][1]?.result', timeout=30000)
            await pixels(page, 'scroll-page-2', index=1)
            await page.evaluate("folio.goTo(0, false); folio.setZoom(0.7)")
            await page.wait_for_timeout(300)
            await pixels(page, 'zoom')
            await page.evaluate("folio.history.transact('Rotate regression page', s => { s.pages[0].rotation = 90; }); folio.fit('page')")
            await page.wait_for_function('[...folio.views.values()][0]?.result', timeout=30000)
            await pixels(page, 'rotate')
            await page.evaluate('folio.gpu.device.destroy()')
            await page.wait_for_function("folio.gpu.mode === 'Canvas 2D' && !document.body.classList.contains('gpu-on')")
            await pixels(page, 'device-loss-fallback')
            assert not await page.evaluate('!!folio.gpu.device || !!folio.gpu.frame')
        assert not errors and not console_errors, {'pageErrors': errors, 'consoleErrors': console_errors}
        entry['passed'] = True
    except Exception as error:
        entry['passed'] = False
        entry['error'] = str(error)
        entry['pageErrors'] = errors
        entry['consoleErrors'] = console_errors
        try:
            entry['failureState'] = await page.evaluate(SNAPSHOT)
            await page.screenshot(path=str(OUT / f'{case}-failure.png'))
        except Exception:
            pass
        print(json.dumps({'diagnostics': entry}), flush=True)
        raise
    finally:
        await context.close()

async def main():
    server = None
    results, failures = [], []
    url = os.environ.get('FOLIO_URL')
    try:
        if not url:
            server = subprocess.Popen(['node', 'scripts/serve.mjs'], cwd=ROOT)
            url = 'http://127.0.0.1:4173/dist/'
            await asyncio.sleep(1)
            assert server.poll() is None, 'Local server failed to start'
        async with async_playwright() as playwright:
            options = {'executable_path': os.environ['CHROMIUM']} if os.environ.get('CHROMIUM') else {'channel': 'chromium'}
            flags = ['--no-sandbox', '--enable-unsafe-webgpu']
            if sys.platform == 'linux':
                # ANGLE handles browser presentation in software; Dawn chooses its
                # own WebGPU backend. Do not force Vulkan for the browser compositor
                # or disable its presentation surface on GPU-less CI machines.
                flags += ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
            browser = await playwright.chromium.launch(
                headless=os.environ.get('FOLIO_HEADED') != '1', args=flags, **options)
            for case in CASES:
                assert case in {'normal', 'delayed-shader', 'delayed-pipeline', 'no-webgpu', 'pipeline-rejected'}, case
                try:
                    await scenario(browser, case, url, results)
                except Exception as error:
                    print(f'FAIL {case}: {error}', flush=True)
                    failures.append(case)
            await browser.close()
        assert not failures, f'Rendering regressions failed: {failures}'
        print(f'PASS all {len(CASES)} secure-origin rendering scenarios', flush=True)
    finally:
        (OUT / 'results.json').write_text(json.dumps(results, indent=2))
        if server:
            server.terminate()
            server.wait(timeout=5)

if __name__ == '__main__':
    asyncio.run(main())
