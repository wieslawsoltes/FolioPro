/** Folio Pro: coordinate math, bounded caches, immutable edit history and project validation. */
export const VERSION = '0.1.0';
export const LIMITS = Object.freeze({ fileBytes: 128 * 1024 * 1024, streamBytes: 128 * 1024 * 1024, pages: 2000, objects: 200000, depth: 80, history: 80, annotations: 20000, cacheBytes: 128 * 1024 * 1024 });
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const uid = () => globalThis.crypto?.randomUUID?.() ?? `f${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
export const clone = x => structuredClone(x);
export const identity = () => [1, 0, 0, 1, 0, 0];
export function multiply(a, b) {
    return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
export function inverse(m) {
    const d = m[0] * m[3] - m[1] * m[2];
    if (Math.abs(d) < 1e-12)
        throw Error('Singular coordinate transform');
    return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
}
export const transform = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export function viewport(box, rotation = 0, scale = 1) {
    const [x0, y0, x1, y1] = box, w = x1 - x0, h = y1 - y0, r = ((rotation % 360) + 360) % 360;
    let m, width, height;
    if (r === 0) {
        m = [1, 0, 0, -1, -x0, y1];
        width = w;
        height = h;
    }
    else if (r === 90) {
        m = [0, 1, 1, 0, -y0, -x0];
        width = h;
        height = w;
    }
    else if (r === 180) {
        m = [-1, 0, 0, 1, x1, -y0];
        width = w;
        height = h;
    }
    else if (r === 270) {
        m = [0, -1, -1, 0, y1, x1];
        width = h;
        height = w;
    }
    else
        throw Error('Only quarter-turn page rotation is supported');
    return { width: width * scale, height: height * scale, transform: m.map(v => v * scale) };
}
export function rectFromPoints(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}
export function boundsOfPoints(points) {
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}
export function normalizedRotation(r) {
    return ((Math.round(r / 90) * 90) % 360 + 360) % 360;
}
export function pageSize(page) {
    return page.rotation % 180 ? { width: page.height, height: page.width } : { width: page.width, height: page.height };
}
export function rotatePoint(p, page, invert = false) {
    let r = normalizedRotation(page.rotation);
    const w = page.width, h = page.height;
    if (invert) {
        if (r === 90)
            return { x: p.y, y: h - p.x };
        if (r === 180)
            return { x: w - p.x, y: h - p.y };
        if (r === 270)
            return { x: w - p.y, y: p.x };
    }
    else {
        if (r === 90)
            return { x: h - p.y, y: p.x };
        if (r === 180)
            return { x: w - p.x, y: h - p.y };
        if (r === 270)
            return { x: p.y, y: w - p.x };
    }
    return p;
}
export function parsePageRange(text, count) {
    if (!text.trim())
        return Array.from({ length: count }, (_, i) => i);
    const out = new Set();
    for (const part of text.split(',')) {
        const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
        if (!m)
            throw Error('Use page ranges such as 1-3, 5, 8');
        const a = +m[1], b = m[2] ? +m[2] : a;
        if (a < 1 || b > count || a > b)
            throw Error(`Page range must be between 1 and ${count}`);
        for (let i = a; i <= b; i++)
            out.add(i - 1);
    }
    return [...out];
}
export function bytesToBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 32768)
        s += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(s);
}
export const base64ToBytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export function latin1(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 32768)
        out += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return out;
}
export const ascii = s => Uint8Array.from(s, c => c.charCodeAt(0) & 255);
export function concatBytes(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}
export const escapeHTML = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function colorRGB(hex) {
    if (!/^#[\da-f]{6}$/i.test(hex))
        throw Error('Invalid color');
    return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
}
export function safeText(text, max = 100000) {
    return String(text ?? '').replace(/\0/g, '').slice(0, max);
}
export function validateState(s) {
    if (!s || !Array.isArray(s.pages) || !s.pages.length || s.pages.length > LIMITS.pages)
        throw Error('Invalid page list');
    if (typeof s.name !== 'string' || s.name.length > 1000 || !s.metadata || typeof s.metadata !== 'object' || !s.fieldValues || typeof s.fieldValues !== 'object')
        throw Error('Invalid document properties');
    const ids = new Set();
    let total = 0;
    for (const p of s.pages) {
        if (typeof p.id !== 'string' || !/^[-_a-zA-Z0-9]{1,128}$/.test(p.id) || ids.has(p.id))
            throw Error('Duplicate or invalid page ID');
        ids.add(p.id);
        if (![p.width, p.height].every(v => Number.isFinite(v) && v > 0 && v <= 20000))
            throw Error('Invalid page dimensions');
        if (![0, 90, 180, 270].includes(p.rotation))
            throw Error('Invalid page rotation');
        if (p.sourceId !== null && typeof p.sourceId !== 'string')
            throw Error('Invalid page source');
        if (!Number.isInteger(p.sourcePage) || p.sourcePage < 0)
            throw Error('Invalid source page');
        if (p.crop && (!['x', 'y', 'w', 'h'].every(k => Number.isFinite(p.crop[k])) || p.crop.x < 0 || p.crop.y < 0 || p.crop.w <= 0 || p.crop.h <= 0 || p.crop.x + p.crop.w > p.width + .001 || p.crop.y + p.crop.h > p.height + .001))
            throw Error('Invalid page crop');
        if (!Array.isArray(p.annotations))
            throw Error('Invalid annotation list');
        const aids = new Set();
        for (const a of p.annotations) {
            if (!a || typeof a.id !== 'string' || !/^[-_a-zA-Z0-9]{1,128}$/.test(a.id) || aids.has(a.id) || !['text', 'highlight', 'rect', 'ellipse', 'line', 'ink', 'note', 'stamp', 'image', 'signature', 'redact', 'field', 'check'].includes(a.type))
                throw Error('Invalid annotation');
            aids.add(a.id);
            for (const k of ['x', 'y', 'w', 'h'])
                if (!Number.isFinite(a[k]) || Math.abs(a[k]) > 100000)
                    throw Error('Invalid annotation geometry');
            if (a.w < 0 || a.h < 0)
                throw Error('Negative annotation dimensions');
            if (a.opacity !== undefined && (!Number.isFinite(a.opacity) || a.opacity < 0 || a.opacity > 1))
                throw Error('Invalid opacity');
            if (a.fontSize !== undefined && (!Number.isFinite(a.fontSize) || a.fontSize <= 0 || a.fontSize > 1000))
                throw Error('Invalid font size');
            if (a.strokeWidth !== undefined && (!Number.isFinite(a.strokeWidth) || a.strokeWidth <= 0 || a.strokeWidth > 1000))
                throw Error('Invalid stroke width');
            if (a.color && !/^#[0-9a-f]{6}$/i.test(a.color))
                throw Error('Invalid annotation color');
            if (a.points && (!Array.isArray(a.points) || a.points.length > 50000 || !a.points.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))))
                throw Error('Invalid stroke');
            if (a.data && !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(a.data))
                throw Error('Unsafe image');
            if (a.text && String(a.text).length > 100000)
                throw Error('Text exceeds limit');
            total++;
        }
    }
    if (total > LIMITS.annotations)
        throw Error('Too many annotations');
    return s;
}
export class History {
    constructor(state, limit = LIMITS.history) {
        validateState(state);
        this.state = clone(state);
        this.undoStack = [];
        this.redoStack = [];
        this.limit = limit;
        this.listeners = new Set();
        this.revision = 0;
        this.savedRevision = 0;
    }
    subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
    notify(label) {
        this.revision++;
        for (const fn of this.listeners)
            fn(this.state, label);
    }
    transact(label, fn) {
        const before = this.state, next = clone(before);
        fn(next);
        validateState(next);
        if (JSON.stringify(before) === JSON.stringify(next))
            return false;
        this.undoStack.push({ state: before, label });
        if (this.undoStack.length > this.limit)
            this.undoStack.shift();
        this.state = next;
        this.redoStack = [];
        this.notify(label);
        return true;
    }
    undo() {
        const e = this.undoStack.pop();
        if (!e)
            return false;
        this.redoStack.push({ state: this.state, label: e.label });
        this.state = e.state;
        this.notify(`Undo ${e.label}`);
        return true;
    }
    redo() {
        const e = this.redoStack.pop();
        if (!e)
            return false;
        this.undoStack.push({ state: this.state, label: e.label });
        this.state = e.state;
        this.notify(`Redo ${e.label}`);
        return true;
    }
    markSaved() {
        this.savedRevision = this.revision;
    }
    get dirty() {
        return this.revision !== this.savedRevision;
    }
}
export class ByteLRU {
    constructor(budget = LIMITS.cacheBytes, onEvict = () => {
    }) {
        this.budget = budget;
        this.bytes = 0;
        this.map = new Map();
        this.onEvict = onEvict;
    }
    get(key) {
        const x = this.map.get(key);
        if (!x)
            return null;
        this.map.delete(key);
        this.map.set(key, x);
        return x.value;
    }
    set(key, value, bytes) {
        if (!Number.isFinite(bytes) || bytes < 0)
            throw Error('Invalid cache entry size');
        if (bytes > this.budget)
            return false;
        this.delete(key);
        this.map.set(key, { value, bytes });
        this.bytes += bytes;
        while (this.bytes > this.budget && this.map.size > 0)
            this.delete(this.map.keys().next().value);
    }
    delete(key) {
        const x = this.map.get(key);
        if (x) {
            this.bytes -= x.bytes;
            this.map.delete(key);
            this.onEvict(x.value);
        }
    }
    clear() {
        for (const key of this.map.keys())
            this.delete(key);
    }
}
export class TaskPool {
    constructor(concurrency = 2) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
    }
    run(fn, priority = 0) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fn, resolve, reject, priority });
            this.queue.sort((a, b) => b.priority - a.priority);
            this.pump();
        });
    }
    pump() {
        while (this.running < this.concurrency && this.queue.length) {
            const t = this.queue.shift();
            this.running++;
            Promise.resolve().then(t.fn).then(t.resolve, t.reject).finally(() => {
                this.running--;
                this.pump();
            });
        }
    }
}
