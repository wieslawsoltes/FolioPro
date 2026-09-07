import test from 'node:test';
import assert from 'node:assert/strict';
import { PageCompositor } from '../src/gpu.mjs';

const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
function harness(t, stage = 'shader') {
    const gate = deferred(), entered = deferred(), lost = deferred(), frames = new Map();
    const modes = [], submitted = [], events = new Map();
    let nextFrame = 0, destroyed = 0;
    const buffer = () => ({ destroy() {} });
    const pipeline = { getBindGroupLayout: () => ({}) };
    const device = {
        limits: { maxTextureDimension2D: 8192 }, lost: lost.promise,
        addEventListener: (name, cb) => events.set(name, cb),
        destroy() { destroyed++; },
        createShaderModule: () => ({ async getCompilationInfo() {
            if (stage === 'shader') { entered.resolve(); await gate.promise; }
            return { messages: [] };
        } }),
        async createRenderPipelineAsync() {
            if (stage === 'pipeline') { entered.resolve(); await gate.promise; }
            return pipeline;
        },
        createBuffer: buffer, createSampler: () => ({}), createBindGroup: () => ({}),
        createTexture: () => ({ destroy() {}, createView: () => ({}) }),
        createCommandEncoder: () => ({
            beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, draw() {}, end() {} }),
            finish: () => ({})
        }),
        queue: {
            copyExternalImageToTexture() {},
            writeBuffer(target) { assert.ok(target, 'Cannot write an uninitialized GPUBuffer'); },
            submit(commands) { submitted.push(commands); }
        }
    };
    const context = { configure() {}, unconfigure() {}, getCurrentTexture: () => ({ createView: () => ({}) }) };
    const canvas = { width: 300, height: 150, style: {}, getContext: () => context };
    for (const [name, value] of Object.entries({
        navigator: { gpu: { requestAdapter: async () => ({ requestDevice: async () => device }), getPreferredCanvasFormat: () => 'bgra8unorm' } },
        GPUBufferUsage: { UNIFORM: 1, COPY_DST: 2, VERTEX: 4 },
        GPUTextureUsage: { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4 },
        requestAnimationFrame: cb => { const id = ++nextFrame; frames.set(id, cb); return id; },
        cancelAnimationFrame: id => frames.delete(id)
    })) {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
        Object.defineProperty(globalThis, name, { configurable: true, value });
        t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
    }
    const compositor = new PageCompositor(canvas, (mode, reason) => modes.push({ mode, reason }));
    const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb()); };
    return { compositor, device, modes, submitted, gate, entered, lost, events, flush, frames, destroyed: () => destroyed };
}
for (const stage of ['shader', 'pipeline']) {
    test(`Scene updates during ${stage} initialization must not trigger fallback or publish an incomplete device`, async t => {
        const h = harness(t, stage), ready = h.compositor.initialize();
        await h.entered.promise;
        h.compositor.setScene([{ key: 'page-1', canvas: { width: 16, height: 16 }, x: 0, y: 0, w: 16, h: 16 }], 100, 100, 1);
        h.flush();
        const prematureModes = [...h.modes];
        h.gate.resolve();
        assert.equal(await ready, true);
        assert.deepEqual(prematureModes, [], 'PDF rasterization must not race an incomplete WebGPU pipeline');
        assert.equal(h.compositor.device, h.device, 'WebGPU mode must have a live device');
        h.flush();
        assert.equal(h.compositor.mode, 'WebGPU');
        assert.equal(h.submitted.length, 1, 'The queued page must actually be submitted');
        h.compositor.dispose();
    });
}
for (const action of ['fail', 'dispose']) {
    test(`${action} during asynchronous initialization cannot resurrect WebGPU`, async t => {
        const h = harness(t), ready = h.compositor.initialize();
        await h.entered.promise;
        if (action === 'fail') h.compositor.fail('Initialization cancelled by GPU error');
        else h.compositor.dispose();
        h.gate.resolve();
        assert.equal(await ready, false);
        assert.equal(h.compositor.device, null);
        assert.ok(h.modes.every(m => m.mode !== 'WebGPU'));
        assert.ok(h.destroyed() > 0, 'Abandoned devices must be released');
    });
}
test('Lost device during shader compilation cannot later report a healthy compositor', async t => {
    const h = harness(t), ready = h.compositor.initialize();
    await h.entered.promise;
    h.lost.resolve({ reason: 'unknown', message: 'Test device loss' });
    await Promise.resolve();
    h.gate.resolve();
    assert.equal(await ready, false);
    assert.equal(h.compositor.device, null);
    assert.equal(h.compositor.mode, 'Canvas 2D');
    assert.ok(h.modes.some(m => m.reason.includes('Test device loss')));
});
test('Pipeline rejection fails closed to Canvas 2D and releases the pending device', async t => {
    const h = harness(t, 'pipeline'), ready = h.compositor.initialize();
    await h.entered.promise;
    h.gate.reject(Error('Pipeline validation failed'));
    assert.equal(await ready, false);
    assert.equal(h.compositor.device, null);
    assert.equal(h.compositor.mode, 'Canvas 2D');
    assert.equal(h.compositor.canvas.style.visibility, 'hidden');
    assert.ok(h.destroyed() > 0);
});
