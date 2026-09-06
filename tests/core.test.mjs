import test from 'node:test';
import assert from 'node:assert/strict';
import { History, ByteLRU, TaskPool, viewport, transform, inverse, multiply, identity, rotatePoint, parsePageRange, validateState, bytesToBase64, base64ToBytes, escapeHTML, colorRGB, normalizedRotation } from '../src/core.mjs';
import { blankState } from '../src/documents.mjs';
const near = (a, b) => a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < 1e-9, `${a} != ${b}`));
for (const r of [0, 90, 180, 270])
    test(`Viewport rotation ${r}: all corners and inverse`, () => {
        const v = viewport([10, 20, 310, 420], r, 2), corners = [[10, 20], [310, 20], [310, 420], [10, 420]].map(p => transform(v.transform, ...p));
        assert.equal(v.width, r % 180 ? 800 : 600);
        assert.equal(v.height, r % 180 ? 600 : 800);
        assert.equal(Math.min(...corners.map(p => p[0])), 0);
        assert.equal(Math.max(...corners.map(p => p[0])), v.width);
        assert.equal(Math.min(...corners.map(p => p[1])), 0);
        assert.equal(Math.max(...corners.map(p => p[1])), v.height);
        near(transform(inverse(v.transform), ...transform(v.transform, 77, 123)), [77, 123]);
    });
test('Affine matrix composition and singular rejection', () => {
    near(multiply([2, 0, 0, 3, 10, 20], inverse([2, 0, 0, 3, 10, 20])), identity());
    assert.throws(() => inverse([0, 0, 0, 0, 0, 0]), /Singular/);
});
test('Page point rotation round-trips', () => {
    for (const rotation of [0, 90, 180, 270]) {
        const p = { width: 600, height: 800, rotation };
        assert.deepEqual(rotatePoint(rotatePoint({ x: 50, y: 90 }, p), p, true), { x: 50, y: 90 });
    }
    assert.equal(normalizedRotation(-90), 270);
});
test('Ranges preserve order and deduplicate', () => {
    assert.deepEqual(parsePageRange('4,1-3,2', 5), [3, 0, 1, 2]);
    assert.deepEqual(parsePageRange('', 3), [0, 1, 2]);
});
test('Ranges reject malformed and out-of-bound input', () => {
    for (const r of ['0', '5', '3-2', '2,,3', '-1', 'abc', '1-5'])
        assert.throws(() => parsePageRange(r, 4));
});
test('History transaction, undo, redo, and branch isolation', () => {
    const state = blankState(), h = new History(state);
    h.transact('rename', s => s.name = 'A.pdf');
    assert.equal(state.name, 'Untitled.pdf');
    assert.equal(h.state.name, 'A.pdf');
    assert.ok(h.dirty);
    h.undo();
    assert.equal(h.state.name, 'Untitled.pdf');
    h.redo();
    assert.equal(h.state.name, 'A.pdf');
    h.undo();
    h.transact('branch', s => s.name = 'B.pdf');
    assert.equal(h.redo(), false);
    h.markSaved();
    assert.equal(h.dirty, false);
});
test('History rejects invalid transactions atomically', () => {
    const h = new History(blankState());
    assert.throws(() => h.transact('bad', s => s.pages = []));
    assert.equal(h.state.pages.length, 1);
    assert.equal(h.undoStack.length, 0);
    assert.equal(h.dirty, false);
});
test('History bounds memory and notifies only changes', () => {
    const h = new History(blankState(), 3), labels = [];
    h.subscribe((_, l) => labels.push(l));
    assert.equal(h.transact('noop', () => {
    }), false);
    for (let i = 0; i < 5; i++)
        h.transact('change', s => s.name = `${i}.pdf`);
    assert.equal(h.undoStack.length, 3);
    assert.equal(labels.length, 5);
});
test('LRU honors recency, byte budget, and disposal', () => {
    const evicted = [], c = new ByteLRU(10, v => evicted.push(v));
    c.set('a', 'A', 4);
    c.set('b', 'B', 4);
    c.get('a');
    c.set('c', 'C', 4);
    assert.equal(c.get('b'), null);
    assert.equal(c.get('a'), 'A');
    assert.deepEqual(evicted, ['B']);
    assert.equal(c.set('oversized', 'X', 11), false);
    assert.ok(c.bytes <= 10);
    c.clear();
    assert.equal(c.bytes, 0);
    assert.equal(evicted.length, 3);
});
test('Task pool bounds concurrency and recovers after failure', async () => {
    const pool = new TaskPool(2);
    let running = 0, max = 0;
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => pool.run(async () => {
        max = Math.max(max, ++running);
        await new Promise(r => setTimeout(r, 2));
        running--;
        if (i === 2)
            throw Error('planned');
        return i;
    })));
    assert.equal(max, 2);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 7);
    assert.equal(await pool.run(() => 42), 42);
});
test('Project rejects executable image URLs and injected IDs', () => {
    for (const change of [s => s.pages[0].id = '" onload="x', s => s.pages[0].annotations.push({ id: 'a', type: 'image', x: 0, y: 0, w: 1, h: 1, data: 'javascript:alert(1)' }), s => s.pages[0].annotations.push({ id: 'a', type: 'text', x: NaN, y: 0, w: 1, h: 1 }), s => s.pages[0].rotation = 45]) {
        const s = blankState();
        change(s);
        assert.throws(() => validateState(s));
    }
});
test('Project rejects crop beyond source bounds and invalid opacity', () => {
    const s = blankState();
    s.pages[0].crop = { x: 10, y: 0, w: 700, h: 100 };
    assert.throws(() => validateState(s), /crop/);
    s.pages[0].crop = null;
    s.pages[0].annotations = [{ id: 'a', type: 'rect', x: 0, y: 0, w: 10, h: 10, opacity: 2 }];
    assert.throws(() => validateState(s), /opacity/);
});
test('Binary base64 round trip covers all byte values', () => {
    const data = Uint8Array.from({ length: 70000 }, (_, i) => i % 256);
    assert.deepEqual(base64ToBytes(bytesToBase64(data)), data);
});
test('HTML and color validation', () => {
    assert.equal(escapeHTML('<img "x">&'), '&lt;img &quot;x&quot;&gt;&amp;');
    assert.deepEqual(colorRGB('#ff8000'), [1, 128 / 255, 0]);
    assert.throws(() => colorRGB('red'));
});
