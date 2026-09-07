"""Diagnostic probe: isolate device, buffer, presentation and external image paths."""
import asyncio
import json
import subprocess
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'tests/out/rendering'
OUT.mkdir(parents=True, exist_ok=True)

async def main():
    (OUT / 'probe.html').write_text('<!doctype html><canvas id="canvas" width="512" height="512"></canvas>')
    server = subprocess.Popen(['node', 'scripts/serve.mjs'], cwd=ROOT)
    results = []
    try:
        await asyncio.sleep(1)
        async with async_playwright() as p:
            browser = await p.chromium.launch(channel='chromium', headless=False, args=[
                '--no-sandbox', '--enable-unsafe-webgpu', '--use-gl=angle',
                '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-logging=stderr'])
            page = await browser.new_page()
            page.on('console', lambda msg: print(f'PROBE CONSOLE {msg.type}: {msg.text}', flush=True))
            await page.goto('http://127.0.0.1:4173/tests/out/rendering/probe.html')
            await page.evaluate('''async () => {
                window.events = [];
                window.adapter = await navigator.gpu.requestAdapter();
                window.device = await adapter.requestDevice();
                device.lost.then(info => events.push({event:'lost',reason:info.reason,message:info.message}));
                device.addEventListener('uncapturederror', e => events.push({event:'error',message:e.error.message}));
                window.context = canvas.getContext('webgpu');
            }''')
            stages = {
                'buffer-readback': '''async () => {
                    const source = device.createBuffer({size:4,usage:GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});
                    const read = device.createBuffer({size:4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
                    device.queue.writeBuffer(source,0,new Uint32Array([0x12345678]));
                    const encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(source,0,read,0,4);
                    device.queue.submit([encoder.finish()]); await read.mapAsync(GPUMapMode.READ);
                    const result = new Uint32Array(read.getMappedRange())[0]; read.unmap(); source.destroy(); read.destroy();
                    return result;
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
                    const texture=device.createTexture({size:[512,512],format:'rgba8unorm',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT});
                    device.queue.copyExternalImageToTexture({source},{texture},[512,512]);
                    await device.queue.onSubmittedWorkDone(); texture.destroy(); return 'copied';
                }''',
                'resize-present': '''async () => {
                    canvas.width=1024; canvas.height=1024;
                    const encoder=device.createCommandEncoder();
                    const pass=encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),clearValue:[0,1,0,1],loadOp:'clear',storeOp:'store'}]});
                    pass.end(); device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone(); return 'resized';
                }'''
            }
            for stage, source in stages.items():
                entry = {'stage': stage}
                try:
                    entry['result'] = await asyncio.wait_for(page.evaluate(source),timeout=15)
                    await page.wait_for_timeout(500)
                    entry['events'] = await page.evaluate('events')
                    await page.screenshot(path=str(OUT / f'probe-{stage}.png'))
                except Exception as error:
                    entry['error'] = str(error)
                results.append(entry)
                print('WEBGPU PROBE ' + json.dumps(entry), flush=True)
            await browser.close()
    finally:
        (OUT / 'probe-results.json').write_text(json.dumps(results,indent=2))
        server.terminate()
        server.wait(timeout=5)

asyncio.run(main())
