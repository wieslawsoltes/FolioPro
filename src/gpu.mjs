import { ByteLRU } from './core.mjs';
/** Single-surface compositor. PDF interpretation is separate from this GPU stage. */
export class PageCompositor {
    constructor(canvas, onMode) {
        this.canvas = canvas;
        this.onMode = onMode;
        this.device = null;
        this.context = null;
        this.mode = 'Canvas 2D';
        this.frame = 0;
        this.draws = [];
        this.verticesCapacity = 0;
        this.lastFrameMs = 0;
        this.stopped = false;
        this.textures = new ByteLRU(128 * 1024 * 1024, t => t.texture.destroy());
    }
    async initialize() {
        if (!navigator.gpu) {
            this.onMode?.('Canvas 2D', 'WebGPU is unavailable; explicit Canvas fallback');
            return false;
        }
        try {
            const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
            if (!adapter)
                throw Error('No WebGPU adapter');
            const device = await adapter.requestDevice();
            this.device = device;
            device.addEventListener('uncapturederror', e => this.fail(e.error.message));
            device.lost.then(info => {
                if (!this.stopped)
                    this.fail(`Device lost: ${info.message || info.reason}`);
            });
            this.context = this.canvas.getContext('webgpu');
            if (!this.context)
                throw Error('WebGPU canvas context unavailable');
            this.format = navigator.gpu.getPreferredCanvasFormat();
            this.context.configure({ device, format: this.format, alphaMode: 'premultiplied' });
            const module = device.createShaderModule({ label: 'Folio page compositor WGSL', code: `
struct View { size: vec2f, padding: vec2f };
@group(0) @binding(0) var<uniform> view: View;
@group(1) @binding(0) var pageSampler: sampler;
@group(1) @binding(1) var pageTexture: texture_2d<f32>;
struct Varyings { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@location(0) position: vec2f, @location(1) uv: vec2f) -> Varyings {
 var output: Varyings;
 output.position = vec4f(position.x / view.size.x * 2.0 - 1.0, 1.0 - position.y / view.size.y * 2.0, 0.0, 1.0);
 output.uv = uv; return output;
}
@fragment fn fs(input: Varyings) -> @location(0) vec4f { return textureSample(pageTexture, pageSampler, input.uv); }
` });
            const compilation = await module.getCompilationInfo();
            const errors = compilation.messages.filter(m => m.type === 'error');
            if (errors.length)
                throw Error(errors.map(e => e.message).join('\n'));
            this.pipeline = await device.createRenderPipelineAsync({ label: 'Folio textured pages', layout: 'auto', vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32x2' }] }] }, fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] }, primitive: { topology: 'triangle-list' } });
            this.uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            this.viewBindGroup = device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.uniform } }] });
            this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'nearest' });
            this.mode = 'WebGPU';
            this.onMode?.(this.mode, adapter.info?.description || 'GPU page compositing');
            this.invalidate();
            return true;
        }
        catch (error) {
            this.fail(error.message);
            return false;
        }
    }
    fail(reason) {
        this.mode = 'Canvas 2D';
        this.textures.clear();
        this.device = null;
        this.canvas.style.visibility = 'hidden';
        this.onMode?.(this.mode, reason);
    }
    upload(key, source) {
        if (!this.device)
            return null;
        let existing = this.textures.get(key);
        if (existing)
            return existing;
        const max = this.device.limits.maxTextureDimension2D;
        if (source.width > max || source.height > max || source.width * source.height * 4 > this.textures.budget)
            throw Error('Page exceeds GPU texture limits; using Canvas fallback');
        const texture = this.device.createTexture({ label: `PDF page ${key}`, size: [source.width, source.height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
        this.device.queue.copyExternalImageToTexture({ source }, { texture }, [source.width, source.height]);
        const bindGroup = this.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(1), entries: [{ binding: 0, resource: this.sampler }, { binding: 1, resource: texture.createView() }] });
        existing = { texture, bindGroup, width: source.width, height: source.height };
        this.textures.set(key, existing, source.width * source.height * 4);
        return existing;
    }
    setScene(draws, width, height, dpr = Math.min(devicePixelRatio || 1, 2)) {
        this.draws = draws;
        this.width = width;
        this.height = height;
        this.dpr = dpr;
        this.invalidate();
    }
    invalidate() {
        if (!this.frame)
            this.frame = requestAnimationFrame(() => {
                this.frame = 0;
                try {
                    this.render();
                }
                catch (error) {
                    this.fail(error.message);
                }
            });
    }
    render() {
        if (!this.device || !this.width || !this.height)
            return;
        const start = performance.now(), cw = Math.max(1, Math.floor(this.width * this.dpr)), ch = Math.max(1, Math.floor(this.height * this.dpr));
        if (this.canvas.width !== cw || this.canvas.height !== ch) {
            this.canvas.width = cw;
            this.canvas.height = ch;
        }
        this.canvas.style.visibility = 'visible';
        const estimated = this.draws.filter(d => !(d.x + d.w < 0 || d.y + d.h < 0 || d.x > this.width || d.y > this.height)).reduce((sum, d) => sum + d.canvas.width * d.canvas.height * 4, 0);
        if (estimated > this.textures.budget)
            throw Error('Visible pages exceed the GPU cache budget');
        const active = [];
        for (const d of this.draws) {
            if (d.x + d.w < 0 || d.y + d.h < 0 || d.x > this.width || d.y > this.height)
                continue;
            const resource = this.upload(d.key, d.canvas);
            if (resource)
                active.push({ ...d, resource });
        }
        const vertices = new Float32Array(active.length * 24);
        let at = 0;
        for (const d of active) {
            const pts = [[0, 0], [1, 0], [0, 1], [0, 1], [1, 0], [1, 1]];
            for (const [x, y] of pts) {
                let u = x, v = y;
                switch (d.rotation) {
                    case 90:
                        u = y;
                        v = 1 - x;
                        break;
                    case 180:
                        u = 1 - x;
                        v = 1 - y;
                        break;
                    case 270:
                        u = 1 - y;
                        v = x;
                        break;
                }
                vertices.set([d.x + x * d.w, d.y + y * d.h, u, v], at);
                at += 4;
            }
        }
        if (vertices.byteLength > this.verticesCapacity) {
            this.vertexBuffer?.destroy();
            this.verticesCapacity = Math.max(vertices.byteLength, 4096);
            this.vertexBuffer = this.device.createBuffer({ size: this.verticesCapacity, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        }
        this.device.queue.writeBuffer(this.uniform, 0, new Float32Array([this.width, this.height, 0, 0]));
        if (vertices.length)
            this.device.queue.writeBuffer(this.vertexBuffer, 0, vertices);
        const encoder = this.device.createCommandEncoder(), pass = encoder.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }] });
        if (active.length) {
            pass.setPipeline(this.pipeline);
            pass.setBindGroup(0, this.viewBindGroup);
            pass.setVertexBuffer(0, this.vertexBuffer);
            for (let i = 0; i < active.length; i++) {
                pass.setBindGroup(1, active[i].resource.bindGroup);
                pass.draw(6, 1, i * 6);
            }
        }
        pass.end();
        this.device.queue.submit([encoder.finish()]);
        this.lastFrameMs = performance.now() - start;
    }
    dispose() {
        this.stopped = true;
        if (this.frame)
            cancelAnimationFrame(this.frame);
        this.textures.clear();
        this.vertexBuffer?.destroy();
        this.uniform?.destroy();
        this.device?.destroy();
    }
}
