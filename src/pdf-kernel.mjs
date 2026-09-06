/**
 * Folio PDF kernel. No native library or framework dependency.
 * Reads classic/hybrid/xref-stream PDFs and object streams; preserves encoded
 * resources during vector export. Rendering is a deliberately bounded subset;
 * unsupported graphics fail explicitly rather than silently disappearing.
 */
import { LIMITS, ascii, latin1, concatBytes, viewport, multiply, identity, transform, colorRGB } from './core.mjs';
export const N = value => ({ kind: 'name', value });
export const R = (id, gen = 0) => ({ kind: 'ref', id, gen });
export const S = value => ({ kind: 'string', bytes: typeof value === 'string' ? ascii(value) : value });
export const ST = (dict, bytes) => ({ kind: 'stream', dict, bytes });
export const name = x => x?.kind === 'name' ? x.value : null;
const WS = /[\x00\t\n\f\r ]/, DELIM = /[\x00\t\n\f\r ()<>\[\]{}/%]/;
const hexBytes = h => Uint8Array.from((h.replace(/\s/g, '') + (h.replace(/\s/g, '').length % 2 ? '0' : '')).match(/../g) ?? [], p => parseInt(p, 16));
export function stringText(v) {
    if (v?.kind !== 'string')
        return '';
    const b = v.bytes;
    if (b[0] === 254 && b[1] === 255) {
        let s = '';
        for (let i = 2; i + 1 < b.length; i += 2)
            s += String.fromCharCode(b[i] * 256 + b[i + 1]);
        return s;
    }
    return new TextDecoder('windows-1252').decode(b);
}
export function unicodeString(s) {
    const b = new Uint8Array(2 + s.length * 2);
    b.set([254, 255]);
    for (let i = 0; i < s.length; i++) {
        b[2 + i * 2] = s.charCodeAt(i) >> 8;
        b[3 + i * 2] = s.charCodeAt(i) & 255;
    }
    return S(b);
}
export class PDFSyntax {
    constructor(bytes, pos = 0, sourceText = null) {
        this.bytes = bytes;
        this.s = sourceText ?? latin1(bytes);
        this.pos = pos;
    }
    skip() {
        while (this.pos < this.s.length) {
            if (WS.test(this.s[this.pos])) {
                this.pos++;
                continue;
            }
            if (this.s[this.pos] === '%') {
                while (this.pos < this.s.length && !/[\r\n]/.test(this.s[this.pos]))
                    this.pos++;
                continue;
            }
            break;
        }
    }
    word() {
        this.skip();
        const p = this.pos;
        while (this.pos < this.s.length && !DELIM.test(this.s[this.pos]))
            this.pos++;
        if (this.pos === p)
            this.pos++;
        return this.s.slice(p, this.pos);
    }
    value(depth = 0) {
        if (depth > LIMITS.depth)
            throw Error('PDF nesting limit exceeded');
        this.skip();
        const s = this.s, c = s[this.pos++];
        if (c === undefined)
            throw Error('Unexpected end of PDF');
        if (c === '/') {
            let out = '';
            while (this.pos < s.length && !DELIM.test(s[this.pos]))
                out += s[this.pos++];
            return N(out.replace(/#([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))));
        }
        if (c === '(') {
            const out = [];
            let n = 1;
            while (this.pos < s.length && n) {
                let ch = s[this.pos++];
                if (ch === '\\') {
                    ch = s[this.pos++];
                    if (ch === '\r') {
                        if (s[this.pos] === '\n')
                            this.pos++;
                        continue;
                    }
                    if (ch === '\n')
                        continue;
                    const esc = { n: 10, r: 13, t: 9, b: 8, f: 12 };
                    if (ch in esc) {
                        out.push(esc[ch]);
                        continue;
                    }
                    if (/[0-7]/.test(ch)) {
                        let oct = ch;
                        for (let i = 0; i < 2 && /[0-7]/.test(s[this.pos] ?? 'x'); i++)
                            oct += s[this.pos++];
                        out.push(parseInt(oct, 8) & 255);
                        continue;
                    }
                    out.push(ch.charCodeAt(0));
                    continue;
                }
                if (ch === '(')
                    n++;
                if (ch === ')')
                    n--;
                if (n)
                    out.push(ch.charCodeAt(0));
            }
            if (n)
                throw Error('Unterminated PDF string');
            return S(new Uint8Array(out));
        }
        if (c === '[') {
            const arr = [];
            while (true) {
                this.skip();
                if (s[this.pos] === ']') {
                    this.pos++;
                    return arr;
                }
                if (arr.length > LIMITS.objects)
                    throw Error('PDF array limit exceeded');
                arr.push(this.value(depth + 1));
            }
        }
        if (c === '<') {
            if (s[this.pos] === '<') {
                this.pos++;
                const d = Object.create(null);
                while (true) {
                    this.skip();
                    if (s.slice(this.pos, this.pos + 2) === '>>') {
                        this.pos += 2;
                        return d;
                    }
                    const k = this.value(depth + 1);
                    if (k?.kind !== 'name')
                        throw Error('Malformed PDF dictionary');
                    d[k.value] = this.value(depth + 1);
                }
            }
            const end = s.indexOf('>', this.pos);
            if (end < 0)
                throw Error('Unterminated hex string');
            const str = S(hexBytes(s.slice(this.pos, end)));
            this.pos = end + 1;
            return str;
        }
        this.pos--;
        const w = this.word();
        if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
            const num = Number(w), save = this.pos;
            if (Number.isInteger(num) && num >= 0) {
                this.skip();
                const g = this.word();
                if (/^\d+$/.test(g)) {
                    this.skip();
                    if (this.word() === 'R')
                        return R(num, +g);
                }
                this.pos = save;
            }
            return num;
        }
        if (w === 'true')
            return true;
        if (w === 'false')
            return false;
        if (w === 'null')
            return null;
        return { kind: 'operator', value: w };
    }
}
async function inflate(bytes) {
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    const output = (async () => {
        const reader = ds.readable.getReader();
        let total = 0;
        const chunks = [];
        while (true) {
            const { value, done } = await reader.read();
            if (done)
                break;
            total += value.length;
            if (total > LIMITS.streamBytes) {
                await reader.cancel();
                throw Error('Decompressed stream exceeds safety limit');
            }
            chunks.push(value);
        }
        return concatBytes(chunks);
    })();
    writer.write(bytes).catch(() => {
    });
    writer.close().catch(() => {
    });
    return output;
}
export async function deflate(bytes) {
    const cs = new CompressionStream('deflate');
    const result = new Response(cs.readable).arrayBuffer();
    const w = cs.writable.getWriter();
    w.write(bytes).catch(() => {
    });
    w.close().catch(() => {
    });
    return new Uint8Array(await result);
}
function ascii85(bytes) {
    let s = latin1(bytes).replace(/\s/g, '').replace(/^<~/, '').replace(/~>.*$/s, ''), out = [], group = [];
    for (const c of s) {
        if (c === 'z') {
            if (group.length)
                throw Error('Malformed ASCII85 stream');
            out.push(0, 0, 0, 0);
            continue;
        }
        const n = c.charCodeAt(0) - 33;
        if (n < 0 || n > 84)
            throw Error('Malformed ASCII85 digit');
        group.push(n);
        if (group.length === 5) {
            let v = 0;
            for (const n of group)
                v = v * 85 + n;
            out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
            group = [];
        }
    }
    if (group.length) {
        const count = group.length - 1;
        while (group.length < 5)
            group.push(84);
        let v = 0;
        for (const n of group)
            v = v * 85 + n;
        out.push(...[(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].slice(0, count));
    }
    return new Uint8Array(out);
}
function runLength(b) {
    const out = [];
    for (let i = 0; i < b.length;) {
        const n = b[i++];
        if (n === 128)
            break;
        if (n < 128) {
            for (let j = 0; j <= n; j++)
                out.push(b[i++]);
        }
        else {
            const v = b[i++];
            for (let j = 0; j < 257 - n; j++)
                out.push(v);
        }
        if (out.length > LIMITS.streamBytes)
            throw Error('Stream exceeds safety limit');
    }
    return new Uint8Array(out);
}
function lzw(b, early = 1) {
    let bit = 0, width = 9, dict = [], prev = null;
    const out = [];
    function reset() {
        dict = Array.from({ length: 256 }, (_, i) => [i]);
        dict.push(null, null);
        width = 9;
        prev = null;
    }
    reset();
    while (bit + width <= b.length * 8) {
        let code = 0;
        for (let i = 0; i < width; i++, bit++)
            code = code * 2 + ((b[bit >> 3] >> (7 - (bit & 7))) & 1);
        if (code === 257)
            break;
        if (code === 256) {
            reset();
            continue;
        }
        let entry = dict[code];
        if (!entry && code === dict.length && prev)
            entry = [...prev, prev[0]];
        if (!entry)
            throw Error('Invalid LZW code');
        out.push(...entry);
        if (prev && dict.length < 4096) {
            dict.push([...prev, entry[0]]);
            if (dict.length + early === (1 << width) && width < 12)
                width++;
        }
        prev = entry;
        if (out.length > LIMITS.streamBytes)
            throw Error('Stream exceeds safety limit');
    }
    return new Uint8Array(out);
}
function predictor(b, p = {}) {
    const pred = p?.Predictor ?? 1, colors = p?.Colors ?? 1, bits = p?.BitsPerComponent ?? 8, cols = p?.Columns ?? 1;
    if (pred <= 1)
        return b;
    const row = Math.ceil(colors * bits * cols / 8), bpp = Math.max(1, Math.ceil(colors * bits / 8));
    if (pred === 2) {
        if (bits !== 8)
            throw Error('TIFF predictor requires 8-bit components');
        const out = b.slice();
        for (let at = 0; at < out.length; at += row)
            for (let x = bpp; x < row; x++)
                out[at + x] = (out[at + x] + out[at + x - bpp]) & 255;
        return out;
    }
    if (pred < 10 || pred > 15)
        throw Error(`Unsupported predictor ${pred}`);
    if (b.length % (row + 1) !== 0)
        throw Error('Truncated PNG predictor stream');
    const rows = b.length / (row + 1), out = new Uint8Array(row * rows);
    for (let y = 0; y < rows; y++) {
        const filter = b[y * (row + 1)];
        for (let x = 0; x < row; x++) {
            const raw = b[y * (row + 1) + 1 + x], a = x >= bpp ? out[y * row + x - bpp] : 0, up = y ? out[(y - 1) * row + x] : 0, ul = y && x >= bpp ? out[(y - 1) * row + x - bpp] : 0;
            let v = raw;
            if (filter === 1)
                v += a;
            else if (filter === 2)
                v += up;
            else if (filter === 3)
                v += Math.floor((a + up) / 2);
            else if (filter === 4) {
                const pp = a + up - ul, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - ul);
                v += pa <= pb && pa <= pc ? a : pb <= pc ? up : ul;
            }
            else if (filter !== 0)
                throw Error('Invalid PNG filter');
            out[y * row + x] = v & 255;
        }
    }
    return out;
}
export async function decodeStream(stream, { image = false } = {}) {
    if (stream?.kind !== 'stream')
        throw Error('Expected PDF stream');
    let b = stream.bytes, filters = stream.dict.Filter ?? [], params = stream.dict.DecodeParms ?? [];
    if (!Array.isArray(filters))
        filters = [filters];
    if (!Array.isArray(params))
        params = [params];
    for (let i = 0; i < filters.length; i++) {
        const f = name(filters[i]);
        if (f === 'FlateDecode' || f === 'Fl')
            b = predictor(await inflate(b), params[i]);
        else if (f === 'ASCII85Decode' || f === 'A85')
            b = ascii85(b);
        else if (f === 'ASCIIHexDecode' || f === 'AHx')
            b = hexBytes(latin1(b).replace(/>.*/s, ''));
        else if (f === 'RunLengthDecode' || f === 'RL')
            b = runLength(b);
        else if (f === 'LZWDecode' || f === 'LZW')
            b = predictor(lzw(b, params[i]?.EarlyChange ?? 1), params[i]);
        else if (image && ['DCTDecode', 'DCT', 'JPXDecode'].includes(f))
            return { bytes: b, encoded: f };
        else
            throw Error(`Unsupported PDF stream filter: ${f}`);
        if (b.length > LIMITS.streamBytes)
            throw Error('Stream limit exceeded');
    }
    return image ? { bytes: b, encoded: null } : b;
}
export class PDFSource {
    constructor(bytes, label = 'Document.pdf') {
        if (!(bytes instanceof Uint8Array) || bytes.length > LIMITS.fileBytes)
            throw Error('PDF exceeds the 128 MiB input limit');
        this.bytes = bytes;
        this.label = label;
        this.syntax = new PDFSyntax(bytes);
        this.xref = new Map();
        this.objects = new Map();
        this.objectStreams = new Map();
        this.pages = [];
        this.pending = new Map();
        this.fonts = new Map();
        this.images = new Map();
        this.warnings = new Set();
    }
    static async load(bytes, label) {
        const doc = new PDFSource(bytes, label);
        await doc.load();
        return doc;
    }
    async load() {
        if (!latin1(this.bytes.subarray(0, 1024)).includes('%PDF-'))
            throw Error('This is not a PDF document');
        const tail = latin1(this.bytes.subarray(Math.max(0, this.bytes.length - 65536))), matches = [...tail.matchAll(/startxref\s+(\d+)/g)];
        if (!matches.length)
            throw Error('Missing PDF cross-reference table');
        await this.readXref(+matches.at(-1)[1], new Set());
        if (this.trailer.Encrypt)
            throw Error('Encrypted PDFs are not supported by the offline kernel. Open an unencrypted copy.');
        this.catalog = await this.resolve(this.trailer.Root);
        if (name(this.catalog?.Type) !== 'Catalog')
            throw Error('Invalid PDF catalog');
        if (this.catalog.AcroForm) {
            const form = await this.resolve(this.catalog.AcroForm);
            if (form.XFA)
                throw Error('XFA forms are not supported; export a static PDF first');
            this.form = form;
        }
        await this.walkPages(this.catalog.Pages, {}, new Set());
        if (!this.pages.length)
            throw Error('PDF contains no pages');
        const info = await this.resolve(this.trailer.Info) || {};
        this.metadata = { title: stringText(info.Title), author: stringText(info.Author), subject: stringText(info.Subject), producer: stringText(info.Producer) };
        return this;
    }
    async directObject(offset, trail = new Set()) {
        if (!Number.isInteger(offset) || offset < 0 || offset >= this.bytes.length)
            throw Error('Invalid object offset');
        const p = new PDFSyntax(this.bytes, offset, this.syntax.s);
        const id = Number(p.word()), gen = Number(p.word());
        if (!Number.isInteger(id) || p.word() !== 'obj')
            throw Error(`Invalid PDF object at ${offset}`);
        let value = p.value();
        p.skip();
        if (p.s.slice(p.pos, p.pos + 6) === 'stream') {
            p.pos += 6;
            if (p.s[p.pos] === '\r')
                p.pos++;
            if (p.s[p.pos] === '\n')
                p.pos++;
            let len = value.Length;
            if (len?.kind === 'ref') {
                try {
                    len = await this.resolve(len, 0, trail);
                }
                catch {
                    len = null;
                }
            }
            let end = typeof len === 'number' ? p.pos + len : -1;
            if (end < 0 || end > this.bytes.length || !/^\s*endstream/.test(p.s.slice(end, end + 32))) {
                end = p.s.indexOf('endstream', p.pos);
                if (end < 0)
                    throw Error('Unterminated PDF stream');
                if (p.s[end - 1] === '\n')
                    end--;
                if (p.s[end - 1] === '\r')
                    end--;
            }
            value = ST(value, this.bytes.slice(p.pos, end));
        }
        return { id, gen, value };
    }
    async readXref(offset, seen) {
        if (seen.has(offset))
            throw Error('Cyclic PDF cross-reference chain');
        seen.add(offset);
        if (seen.size > 100)
            throw Error('Too many incremental updates');
        const p = new PDFSyntax(this.bytes, offset, this.syntax.s);
        let trailer;
        if (p.word() === 'xref') {
            while (true) {
                p.skip();
                if (p.s.startsWith('trailer', p.pos)) {
                    p.pos += 7;
                    trailer = p.value();
                    break;
                }
                const first = Number(p.word()), count = Number(p.word());
                if (!Number.isInteger(count) || count < 0 || count > LIMITS.objects)
                    throw Error('Invalid cross-reference subsection');
                for (let i = 0; i < count; i++) {
                    const off = Number(p.word()), gen = Number(p.word()), type = p.word();
                    if (!this.xref.has(first + i))
                        this.xref.set(first + i, type === 'n' ? { type: 1, offset: off, gen } : { type: 0 });
                }
            }
        }
        else {
            const obj = await this.directObject(offset), stream = obj.value;
            if (stream?.kind !== 'stream' || name(stream.dict.Type) !== 'XRef')
                throw Error('Unsupported or corrupt cross-reference section');
            this.objects.set(obj.id, stream);
            trailer = stream.dict;
            const widths = trailer.W, indices = trailer.Index ?? [0, trailer.Size], data = await decodeStream(stream);
            if (!Array.isArray(widths) || widths.length !== 3 || widths.some(n => n < 0 || n > 8))
                throw Error('Invalid xref stream widths');
            let at = 0;
            const read = n => {
                let v = 0;
                if (at + n > data.length)
                    throw Error('Truncated xref stream');
                for (let i = 0; i < n; i++)
                    v = v * 256 + data[at++];
                return v;
            };
            for (let i = 0; i < indices.length; i += 2) {
                const first = indices[i], count = indices[i + 1];
                if (count > LIMITS.objects)
                    throw Error('Object count limit exceeded');
                for (let j = 0; j < count; j++) {
                    const type = widths[0] ? read(widths[0]) : 1, a = read(widths[1]), b = read(widths[2]);
                    if (!this.xref.has(first + j))
                        this.xref.set(first + j, type === 1 ? { type, offset: a, gen: b } : type === 2 ? { type, stream: a, index: b } : { type: 0 });
                }
            }
        }
        if (!this.trailer)
            this.trailer = trailer;
        if (this.xref.size > LIMITS.objects)
            throw Error('Object count limit exceeded');
        if (trailer.XRefStm && !seen.has(trailer.XRefStm))
            await this.readXref(trailer.XRefStm, seen);
        if (trailer.Prev && !seen.has(trailer.Prev))
            await this.readXref(trailer.Prev, seen);
    }
    async resolve(v, depth = 0, trail = new Set()) {
        if (v?.kind !== 'ref')
            return v;
        if (depth > LIMITS.depth)
            throw Error('Reference nesting limit exceeded');
        if (trail.has(v.id))
            throw Error('Cyclic object resolution');
        if (this.objects.has(v.id))
            return this.objects.get(v.id);
        if (this.pending.has(v.id))
            return this.pending.get(v.id);
        const next = new Set(trail);
        next.add(v.id);
        const promise = (async () => {
            const x = this.xref.get(v.id);
            if (!x || !x.type)
                throw Error(`Missing PDF object ${v.id}`);
            let value;
            if (x.type === 1) {
                const o = await this.directObject(x.offset, next);
                if (o.id !== v.id)
                    throw Error('Cross-reference object mismatch');
                value = o.value;
            }
            else {
                let items = this.objectStreams.get(x.stream);
                if (!items) {
                    const stream = await this.resolve(R(x.stream), depth + 1, next), b = await decodeStream(stream), p = new PDFSyntax(b), n = stream.dict.N, first = stream.dict.First;
                    if (!Number.isInteger(n) || n < 0 || n > LIMITS.objects || !Number.isInteger(first) || first < 0 || first > b.length)
                        throw Error('Invalid object stream');
                    const entries = [];
                    for (let i = 0; i < n; i++)
                        entries.push([Number(p.word()), Number(p.word())]);
                    items = new Map();
                    for (const [id, off] of entries) {
                        if (!Number.isInteger(off) || off < 0 || first + off >= b.length)
                            throw Error('Invalid compressed object offset');
                        items.set(id, new PDFSyntax(b, first + off).value());
                    }
                    this.objectStreams.set(x.stream, items);
                }
                value = items.get(v.id);
                if (value === undefined)
                    throw Error('Missing compressed object');
            }
            this.objects.set(v.id, value);
            return value;
        })();
        this.pending.set(v.id, promise);
        try {
            return await promise;
        }
        finally {
            this.pending.delete(v.id);
        }
    }
    async deep(v, depth = 0) {
        if (depth > LIMITS.depth)
            throw Error('Deep resolution limit');
        v = await this.resolve(v);
        if (Array.isArray(v))
            return Promise.all(v.map(x => this.deep(x, depth + 1)));
        if (v && typeof v === 'object' && !v.kind) {
            const d = Object.create(null);
            for (const [k, x] of Object.entries(v))
                d[k] = await this.deep(x, depth + 1);
            return d;
        }
        return v;
    }
    async walkPages(ref, inherited, seen) {
        if (seen.size > LIMITS.pages * 4)
            throw Error('Page tree limit exceeded');
        if (ref?.kind === 'ref') {
            if (seen.has(ref.id))
                throw Error('Cyclic page tree');
            seen.add(ref.id);
        }
        const node = await this.resolve(ref), props = { ...inherited };
        for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate', 'UserUnit'])
            if (node[k] !== undefined)
                props[k] = node[k];
        if (name(node.Type) === 'Pages' || node.Kids) {
            for (const child of await this.resolve(node.Kids))
                await this.walkPages(child, props, seen);
            return;
        }
        if (this.pages.length >= LIMITS.pages)
            throw Error('Page count limit exceeded');
        const box = await this.deep(props.CropBox ?? props.MediaBox);
        if (!Array.isArray(box) || box.length !== 4 || box.some(x => !Number.isFinite(x)) || box[2] <= box[0] || box[3] <= box[1])
            throw Error('Invalid page box');
        const userUnit = props.UserUnit ?? 1;
        if (!Number.isFinite(userUnit) || userUnit <= 0 || userUnit > 75000)
            throw Error('Invalid PDF UserUnit');
        const rotation = ((props.Rotate ?? 0) % 360 + 360) % 360, vp = viewport(box, rotation, userUnit);
        this.pages.push({ index: this.pages.length, ref, node, box, rotation, width: vp.width, height: vp.height, transform: vp.transform, resources: await this.resolve(props.Resources) ?? {} });
    }
    async content(page) {
        const c = await this.resolve(page.node.Contents);
        if (!c)
            return new Uint8Array();
        const parts = [];
        for (const x of Array.isArray(c) ? c : [c]) {
            parts.push(await decodeStream(await this.resolve(x)));
            parts.push(ascii('\n'));
        }
        return concatBytes(parts);
    }
    async annotations(page) {
        const arr = await this.resolve(page.node.Annots) || [], out = [];
        for (const ref of arr) {
            const d = await this.resolve(ref);
            out.push({ ...d, _ref: ref });
        }
        return out;
    }
    async outline() {
        const root = await this.resolve(this.catalog.Outlines);
        if (!root)
            return [];
        const out = [], seen = new Set();
        let next = root.First;
        while (next && out.length < 500) {
            if (next.kind === 'ref' && seen.has(next.id))
                break;
            seen.add(next.id);
            const d = await this.resolve(next), dest = await this.resolve(d.Dest ?? (await this.resolve(d.A))?.D);
            out.push({ title: stringText(d.Title), page: Array.isArray(dest) ? Math.max(0, this.pages.findIndex(p => p.ref?.id === dest[0]?.id)) : 0 });
            next = d.Next;
        }
        return out;
    }
}
export function serialize(v) {
    if (v === null || v === undefined)
        return 'null';
    if (typeof v === 'boolean')
        return v ? 'true' : 'false';
    if (typeof v === 'number') {
        if (!Number.isFinite(v))
            throw Error('Non-finite PDF number');
        return String(Math.round(v * 100000) / 100000);
    }
    if (Array.isArray(v))
        return `[${v.map(serialize).join(' ')}]`;
    if (v.kind === 'name')
        return '/' + v.value.replace(/[^\w.-]/g, c => '#' + c.charCodeAt(0).toString(16).padStart(2, '0'));
    if (v.kind === 'ref')
        return `${v.id} ${v.gen ?? 0} R`;
    if (v.kind === 'string')
        return '<' + Array.from(v.bytes, b => b.toString(16).padStart(2, '0')).join('') + '>';
    if (v.kind)
        throw Error(`Cannot serialize ${v.kind}`);
    return '<<' + Object.entries(v).filter(([k]) => !k.startsWith('_')).map(([k, x]) => `${serialize(N(k))} ${serialize(x)}`).join('\n') + '>>';
}
export class PDFWriter {
    constructor() {
        this.objects = [null];
        this.copyMaps = new Map();
        this.fontRefs = new Map();
    }
    reserve() {
        this.objects.push(null);
        return R(this.objects.length - 1);
    }
    set(ref, value) {
        this.objects[ref.id] = value;
        return ref;
    }
    add(value) {
        return this.set(this.reserve(), value);
    }
    font(base = 'Helvetica') {
        if (!this.fontRefs.has(base))
            this.fontRefs.set(base, this.add({ Type: N('Font'), Subtype: N('Type1'), BaseFont: N(base), Encoding: N('WinAnsiEncoding') }));
        return this.fontRefs.get(base);
    }
    async stream(dict, bytes, compress = true) {
        if (compress) {
            bytes = await deflate(bytes);
            dict = { ...dict, Filter: N('FlateDecode') };
        }
        return this.add(ST({ ...dict, Length: bytes.length }, bytes));
    }
    async copy(source, v, depth = 0) {
        if (depth > LIMITS.depth)
            throw Error('Resource graph limit exceeded');
        if (v?.kind === 'ref') {
            let map = this.copyMaps.get(source);
            if (!map) {
                map = new Map();
                this.copyMaps.set(source, map);
            }
            if (map.has(v.id))
                return map.get(v.id);
            const ref = this.reserve();
            map.set(v.id, ref);
            this.set(ref, await this.copy(source, await source.resolve(v), depth + 1));
            return ref;
        }
        if (Array.isArray(v))
            return Promise.all(v.map(x => this.copy(source, x, depth + 1)));
        if (v?.kind === 'stream')
            return ST(await this.copy(source, v.dict, depth + 1), v.bytes);
        if (v && typeof v === 'object' && !v.kind) {
            const d = Object.create(null);
            for (const [k, x] of Object.entries(v)) {
                if (['Parent', 'P', 'AA', 'JavaScript', 'JS', 'OpenAction', 'Launch', 'EmbeddedFiles'].includes(k))
                    continue;
                d[k] = await this.copy(source, x, depth + 1);
            }
            return d;
        }
        return v;
    }
    save(root, info = null) {
        const parts = [ascii('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n')], offsets = [0];
        let at = parts[0].length;
        for (let i = 1; i < this.objects.length; i++) {
            const v = this.objects[i];
            if (v === null)
                throw Error(`Uninitialized PDF object ${i}`);
            offsets.push(at);
            let b;
            if (v?.kind === 'stream') {
                const dict = { ...v.dict, Length: v.bytes.length };
                b = concatBytes([ascii(`${i} 0 obj\n${serialize(dict)}\nstream\n`), v.bytes, ascii('\nendstream\nendobj\n')]);
            }
            else
                b = ascii(`${i} 0 obj\n${serialize(v)}\nendobj\n`);
            parts.push(b);
            at += b.length;
        }
        const start = at;
        let xref = `xref\n0 ${this.objects.length}\n0000000000 65535 f \n`;
        for (let i = 1; i < offsets.length; i++)
            xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
        xref += `trailer\n${serialize({ Size: this.objects.length, Root: root, ...(info ? { Info: info } : {}) })}\nstartxref\n${start}\n%%EOF\n`;
        parts.push(ascii(xref));
        return concatBytes(parts);
    }
}
export const pdfLiteral = s => '(' + String(s).replace(/[^\x20-\x7e\xa0-\xff]/g, '?').replace(/[\\()]/g, c => '\\' + c) + ')';
export const num = n => String(Math.round(n * 10000) / 10000);
export const rgbOps = hex => colorRGB(hex).map(num).join(' ');
export function annotationOps(a, height, { imageName = null } = {}) {
    const x = a.x, y = height - a.y, w = a.w, h = a.h, color = rgbOps(a.color || '#25334a'), sw = num(a.strokeWidth || 1.5), out = ['q', `${color} rg ${color} RG ${sw} w`];
    const rect = `${num(x)} ${num(y - h)} ${num(w)} ${num(h)} re`;
    if (['text', 'signature', 'stamp', 'note', 'field', 'check'].includes(a.type)) {
        if (a.type === 'note') {
            out.push('1 .88 .35 rg', rect, 'f');
        }
        if (a.type === 'field') {
            out.push('.94 .96 1 rg', rect, 'f', `${color} rg`);
        }
        if (a.type === 'stamp') {
            out.push(rect, 'S');
        }
        const font = a.type === 'signature' ? 'FC' : a.bold ? 'FB' : 'FR', size = a.fontSize || 14, tx = x + (a.type === 'stamp' ? 8 : 0), ty = y - (a.type === 'stamp' ? h * .65 : size);
        if (a.type === 'check' && !a.checked)
            return '';
        const text = a.type === 'check' ? 'X' : a.text ?? '';
        out.push(`BT /${font} ${num(size)} Tf 1 0 0 1 ${num(tx)} ${num(ty)} Tm`);
        for (const [i, line] of text.split('\n').entries()) {
            if (i)
                out.push(`0 ${num(-size * 1.25)} Td`);
            out.push(pdfLiteral(line) + ' Tj');
        }
        out.push('ET');
    }
    else if (a.type === 'image') {
        if (imageName)
            out.push(`${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y - h)} cm /${imageName} Do`);
    }
    else if (a.type === 'rect') {
        if (a.fill && a.fill !== 'none')
            out.push(`${rgbOps(a.fill)} rg`, rect, 'B');
        else
            out.push(rect, 'S');
    }
    else if (a.type === 'highlight') {
        out.push('/GH gs', rect, 'f');
    }
    else if (a.type === 'redact') {
        throw Error('Pending redactions require sanitized raster export');
    }
    else if (a.type === 'ellipse') {
        const cx = x + w / 2, cy = y - h / 2, rx = w / 2, ry = h / 2, k = .5522847498;
        out.push(`${num(cx + rx)} ${num(cy)} m`, `${num(cx + rx)} ${num(cy + ry * k)} ${num(cx + rx * k)} ${num(cy + ry)} ${num(cx)} ${num(cy + ry)} c`, `${num(cx - rx * k)} ${num(cy + ry)} ${num(cx - rx)} ${num(cy + ry * k)} ${num(cx - rx)} ${num(cy)} c`, `${num(cx - rx)} ${num(cy - ry * k)} ${num(cx - rx * k)} ${num(cy - ry)} ${num(cx)} ${num(cy - ry)} c`, `${num(cx + rx * k)} ${num(cy - ry)} ${num(cx + rx)} ${num(cy - ry * k)} ${num(cx + rx)} ${num(cy)} c`, 'S');
    }
    else if (a.type === 'ink' || a.type === 'line') {
        const pts = a.points ?? [[x, a.y], [x + w, a.y + h]];
        out.push('1 J 1 j');
        for (let i = 0; i < pts.length; i++)
            out.push(`${num(pts[i][0])} ${num(height - pts[i][1])} ${i ? 'l' : 'm'}`);
        out.push('S');
    }
    out.push('Q');
    return out.join('\n');
}
