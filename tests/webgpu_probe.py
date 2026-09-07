"""Fail-fast WebGPU canary: readback, screen presentation, upload and resize.

This fixture is independent of Folio. It distinguishes a broken browser capture
configuration from an application regression before the full rendering suite.
"""
import asyncio
import io
import json
import subprocess
from pathlib import Path

from PIL import Image
from playwright.async_api import async_playwright
from browser_runtime import chromium_options

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'tests/out/rendering'
OUT.mkdir(parents=True, exist_ok=True)

async def main():
    (OUT / 'probe.html').write_text('<!doctype html><canvas id="canvas" width="512" height="512"></canvas>')
    server = subprocess.Popen(['node', 'scripts/serve.mjs'], cwd=ROOT)
    results = []
    try:
        await asyncio.sleep(1)
        assert server.poll() is None, 'Canary server failed to start'
        async with async_playwright() as p:
            browser = await p.chromium.launch(**chromium_options())
            try:
                page = await browser.new_page(viewport={'width': 1280, 'height': 1200})
                await page.goto('http://127.0.0.1:4173/tests/out/rendering/probe.html')
                await asyncio.wait_for(page.evaluate('''async () => {
                    window.events = [];
                    window.adapter = await navigator.gpu.requestAdapter();
                    if (!adapter) throw Error('No WebGPU adapter for presentation canary');
                    window.device = await adapter.requestDevice();
                    device.lost.then(info => events.push({event:'lost',reason:info.reason,message:info.message}));
                    device.addEventListener('uncapturederror', e => events.push({event:'error',message:e.error.message}));
                    window.context = canvas.getContext('webgpu');
                }'''), timeout=15)
                stages = {
                    'buffer-readback': '''async () => {
                        const source = device.createBuffer({size:4,usage:GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});
                        const read = device.createBuffer({size:4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
                        device.queue.writeBuffer(source,0,new Uint32Array([0x12345678]));
                        const encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(source,0,read,0,4);
                        device.queue.submit([encoder.finish()]); await read.mapAsync(GPUMapMode.READ);
                        const result = new Uint32Array(read.getMappedRange())[0];
                        read.unmap(); source.destroy(); read.destroy(); return result;
                    }''',
                    'present-clear': '''async () => {
                        context.configure({device,format:navigator.gpu.getPreferredCanvasFormat()});
                        const encoder = device.createCommandEncoder();
                        const pass = encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),clearValue:[1,0,0,1],loadOp:'clear',storeOp:'store'}]});
                        pass.end(); device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone();
                        return 'submitted';
                    }''',
                    'external-image': '''async () => {
                        const source = document.createElement('canvas'); source.width=512; source.height=512;
                        const ctx=source.getContext('2d'); ctx.fillStyle='red'; ctx.fillRect(0,0,512,512);
                        const texture=device.createTexture({size:[512,512],format:'rgba8unorm',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT});
                        device.queue.copyExternalImageToTexture({source},{texture},[512,512]);
                        const read=device.createBuffer({size:256,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
                        const encoder=device.createCommandEncoder();
                        encoder.copyTextureToBuffer({texture},{buffer:read,bytesPerRow:256},[1,1]);
                        device.queue.submit([encoder.finish()]); await read.mapAsync(GPUMapMode.READ);
                        const pixel=Array.from(new Uint8Array(read.getMappedRange()).slice(0,4));
                        read.unmap(); read.destroy(); texture.destroy(); return pixel;
                    }''',
                    'resize-present': '''async () => {
                        canvas.width=1024; canvas.height=1024;
                        const encoder=device.createCommandEncoder();
                        const pass=encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),clearValue:[0,1,0,1],loadOp:'clear',storeOp:'store'}]});
                        pass.end(); device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone();
                        return 'resized';
                    }'''
                }
                for stage, source in stages.items():
                    entry = {'stage': stage}
                    results.append(entry)
                    try:
                        entry['result'] = await asyncio.wait_for(page.evaluate(source), timeout=15)
                        await page.wait_for_timeout(500)
                        entry['events'] = await page.evaluate('events')
                        assert not entry['events'], f'Unexpected device loss or validation error: {entry}'
                        if stage == 'buffer-readback':
                            assert entry['result'] == 0x12345678, entry
                        elif stage == 'external-image':
                            assert entry['result'] == [255, 0, 0, 255], entry
                        else:
                            data = await page.locator('#canvas').screenshot(path=str(OUT / f'probe-{stage}.png'))
                            image = Image.open(io.BytesIO(data)).convert('RGB')
                            color = image.getpixel((image.width // 2, image.height // 2))
                            expected = (255, 0, 0) if stage == 'present-clear' else (0, 255, 0)
                            entry['screenPixel'] = list(color)
                            assert all(abs(a-b) <= 2 for a,b in zip(color, expected)), f'Canvas presentation/capture is broken: {entry}'
                        entry['passed'] = True
                    except Exception as error:
                        entry.update(passed=False, error=str(error))
                        raise
                    finally:
                        (OUT / 'probe-results.json').write_text(json.dumps(results, indent=2))
                        print('WEBGPU CANARY ' + json.dumps(entry), flush=True)
            finally:
                await browser.close()
    finally:
        (OUT / 'probe-results.json').write_text(json.dumps(results, indent=2))
        server.terminate()
        server.wait(timeout=5)

if __name__ == '__main__':
    asyncio.run(main())
