import { PDFSyntax, decodeStream, name, stringText, R } from './pdf-kernel.mjs';
import { identity, multiply, transform, latin1, viewport, LIMITS, TaskPool } from './core.mjs';
const glyphs = { space: ' ', hyphen: '-', minus: '−', period: '.', comma: ',', colon: ':', semicolon: ';', parenleft: '(', parenright: ')', slash: '/', backslash: '\\', quotedbl: '"', quotesingle: "'", ampersand: '&', asterisk: '*', at: '@', numbersign: '#', percent: '%', plus: '+', equal: '=', exclam: '!', question: '?', underscore: '_', bullet: '•', endash: '–', emdash: '—', quoteleft: '‘', quoteright: '’', quotedblleft: '“', quotedblright: '”', fi: 'fi', fl: 'fl', Euro: '€', dollar: '$', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
function glyphName(n) {
    if (n.length === 1)
        return n;
    if (glyphs[n])
        return glyphs[n];
    if (/^uni[\da-f]{4}$/i.test(n))
        return String.fromCharCode(parseInt(n.slice(3), 16));
    return '?';
}
function hexUnicode(h) {
    let out = '';
    for (let i = 0; i + 3 < h.length; i += 4)
        out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return out;
}
async function fontFor(src, resource) {
    const key = resource?.id ?? JSON.stringify(resource);
    if (src.fonts.has(key))
        return src.fonts.get(key);
    const promise = (async () => {
        const d = await src.resolve(resource);
        if (name(d.Subtype) === 'Type3')
            throw Error('Type 3 fonts require PDF.js compatibility rendering');
        const base = name(d.BaseFont) || 'Helvetica', isCID = name(d.Subtype) === 'Type0', descendant = isCID ? await src.resolve((await src.resolve(d.DescendantFonts))[0]) : d;
        let family = /Times|Serif/i.test(base) ? 'Georgia, "Times New Roman", serif' : /Courier|Mono/i.test(base) ? '"Courier New", monospace' : 'Arial, Helvetica, sans-serif', weight = /Bold|Black|Heavy/i.test(base) ? 'bold' : 'normal', style = /Italic|Oblique/i.test(base) ? 'italic' : 'normal';
        const descriptor = await src.resolve(descendant.FontDescriptor);
        if (descriptor?.FontFile2 && typeof FontFace !== 'undefined') {
            try {
                const data = await decodeStream(await src.resolve(descriptor.FontFile2)), fam = `FolioFont${src.fonts.size}_${key}`.replace(/[^\w]/g, '');
                const face = new FontFace(fam, data.buffer);
                await face.load();
                document.fonts.add(face);
                family = `"${fam}"`;
                weight = 'normal';
                style = 'normal';
            }
            catch {
                src.warnings.add(`Font substitution: ${base}`);
            }
        }
        else if (descriptor?.FontFile3)
            src.warnings.add(`CFF font substitution: ${base}`);
        const unicode = new Map();
        let codeBytes = isCID ? 2 : 1;
        if (d.ToUnicode) {
            try {
                const cmap = latin1(await decodeStream(await src.resolve(d.ToUnicode)));
                for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
                    for (const m of block[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>/gi)) {
                        unicode.set(parseInt(m[1], 16), hexUnicode(m[2]));
                        codeBytes = Math.max(codeBytes, m[1].length / 2);
                    }
                for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
                    for (const m of block[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>\s*(<([\da-f]+)>|\[([^\]]*)\])/gi)) {
                        const a = parseInt(m[1], 16), b = parseInt(m[2], 16);
                        if (b - a > 65535)
                            throw Error('Oversized character mapping');
                        if (m[4]) {
                            let u = hexUnicode(m[4]);
                            for (let n = a; n <= b; n++)
                                unicode.set(n, u.slice(0, -1) + String.fromCharCode(u.charCodeAt(u.length - 1) + n - a));
                        }
                        else {
                            const list = [...m[5].matchAll(/<([\da-f]+)>/gi)];
                            for (let n = a; n <= b; n++)
                                unicode.set(n, hexUnicode(list[n - a]?.[1] ?? '003f'));
                        }
                    }
            }
            catch (e) {
                src.warnings.add('Some character mappings could not be decoded');
            }
        }
        const enc = await src.resolve(d.Encoding);
        const differences = new Map();
        if (enc && typeof enc === 'object' && !enc.kind) {
            let n = 0;
            for (const v of enc.Differences ?? []) {
                if (typeof v === 'number')
                    n = v;
                else
                    differences.set(n++, glyphName(name(v) || ''));
            }
        }
        const widths = new Map();
        if (isCID) {
            const w = await src.deep(descendant.W) || [];
            for (let i = 0; i < w.length;) {
                const first = w[i++], next = w[i++];
                if (Array.isArray(next))
                    next.forEach((x, j) => widths.set(first + j, x));
                else {
                    const val = w[i++];
                    if (next - first > 65535)
                        throw Error('Font width range is too large');
                    for (let j = first; j <= next; j++)
                        widths.set(j, val);
                }
            }
        }
        else {
            const ws = await src.resolve(d.Widths) || [], first = d.FirstChar ?? 0;
            ws.forEach((v, i) => widths.set(first + i, v));
        }
        const decoder = new TextDecoder(name(enc) === 'MacRomanEncoding' ? 'macintosh' : 'windows-1252');
        return { family, weight, style, widths, defaultWidth: isCID ? (descendant.DW ?? 1000) : null, decode(bytes) {
                const out = [];
                for (let i = 0; i < bytes.length; i += codeBytes) {
                    let code = 0;
                    for (let j = 0; j < codeBytes; j++)
                        code = (code << 8) + (bytes[i + j] ?? 0);
                    const text = unicode.get(code) ?? differences.get(code) ?? (isCID ? String.fromCharCode(code) : decoder.decode(new Uint8Array([code])));
                    out.push({ text, code, width: widths.get(code) });
                }
                return out;
            } };
    })();
    src.fonts.set(key, promise);
    return promise;
}
async function imageFor(src, ref) {
    const key = ref?.id ?? ref;
    if (src.images.has(key))
        return src.images.get(key);
    const promise = (async () => {
        const stream = await src.resolve(ref), d = stream.dict, width = d.Width, height = d.Height;
        if (!(width > 0 && height > 0) || width * height > 40e6)
            throw Error('PDF image exceeds pixel limit');
        const decoded = await decodeStream(stream, { image: true });
        if (decoded.encoded) {
            if (decoded.encoded === 'JPXDecode')
                throw Error('JPEG 2000 requires PDF.js compatibility rendering');
            return createImageBitmap(new Blob([decoded.bytes], { type: 'image/jpeg' }));
        }
        let cs = await src.resolve(d.ColorSpace), components = 1, indexed = null;
        if (Array.isArray(cs)) {
            const n = name(cs[0]);
            if (n === 'ICCBased') {
                const profile = await src.resolve(cs[1]);
                components = profile.dict.N;
            }
            else if (n === 'Indexed' || n === 'I') {
                const base = await src.resolve(cs[1]), lookup = await src.resolve(cs[3]);
                components = 1;
                indexed = { channels: name(base) === 'DeviceRGB' ? 3 : 1, data: lookup?.kind === 'stream' ? await decodeStream(lookup) : lookup.bytes };
            }
            else
                throw Error(`Image colorspace ${n} requires PDF.js compatibility rendering`);
        }
        else
            components = name(cs) === 'DeviceRGB' ? 3 : name(cs) === 'DeviceCMYK' ? 4 : 1;
        if (d.ImageMask)
            throw Error('Stencil images require PDF.js compatibility rendering');
        const bits = d.BitsPerComponent ?? 8;
        if (![1, 2, 4, 8].includes(bits))
            throw Error('High bit-depth images require compatibility rendering');
        const bytes = decoded.bytes, rowBytes = Math.ceil(width * components * bits / 8), out = new Uint8ClampedArray(width * height * 4), max = (1 << bits) - 1, decode = d.Decode;
        function sample(x, y, c) {
            const bit = (x * components + c) * bits, b = bytes[y * rowBytes + (bit >> 3)] ?? 0;
            let v = ((b >> (8 - bits - (bit & 7))) & max) / max;
            if (decode)
                v = decode[c * 2] + v * (decode[c * 2 + 1] - decode[c * 2]);
            return v;
        }
        let mask = null;
        if (d.SMask) {
            const m = await src.resolve(d.SMask);
            if (m.dict.Width !== width || m.dict.Height !== height)
                throw Error('Differently sized soft mask requires compatibility rendering');
            mask = (await decodeStream(m, { image: true })).bytes;
        }
        for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
                const at = (y * width + x) * 4;
                let r, g, b;
                if (indexed) {
                    const n = Math.round(sample(x, y, 0) * max) * indexed.channels;
                    r = indexed.data[n] ?? 0;
                    g = indexed.data[n + (indexed.channels === 3 ? 1 : 0)] ?? 0;
                    b = indexed.data[n + (indexed.channels === 3 ? 2 : 0)] ?? 0;
                }
                else if (components === 4) {
                    const c = sample(x, y, 0), m = sample(x, y, 1), yy = sample(x, y, 2), k = sample(x, y, 3);
                    r = 255 * (1 - c) * (1 - k);
                    g = 255 * (1 - m) * (1 - k);
                    b = 255 * (1 - yy) * (1 - k);
                }
                else {
                    r = 255 * sample(x, y, 0);
                    g = components === 3 ? 255 * sample(x, y, 1) : r;
                    b = components === 3 ? 255 * sample(x, y, 2) : r;
                }
                out[at] = r;
                out[at + 1] = g;
                out[at + 2] = b;
                out[at + 3] = mask ? mask[y * width + x] : 255;
            }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').putImageData(new ImageData(out, width, height), 0, 0);
        return canvas;
    })();
    src.images.set(key, promise);
    return promise;
}
const cssRGB = a => `rgb(${a.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(',')})`;
function cmyk(a) {
    return cssRGB([(1 - a[0]) * (1 - a[3]), (1 - a[1]) * (1 - a[3]), (1 - a[2]) * (1 - a[3])]);
}
function initialText() {
    return { font: null, size: 12, tm: identity(), tlm: identity(), charSpace: 0, wordSpace: 0, hscale: 1, leading: 0, rise: 0, mode: 0, fillAlpha: 1, strokeAlpha: 1, fillCS: 'DeviceGray', strokeCS: 'DeviceGray' };
}
export class NativePDFRenderer {
    constructor() {
        this.name = 'Folio PDF · offline';
        this.pool = new TaskPool(2);
    }
    async render(source, pageIndex, scale = 1, { signal } = {}) {
        const page = source.pages[pageIndex];
        const pixels = Math.ceil(page.width * scale) * Math.ceil(page.height * scale);
        if (pixels > 24e6)
            scale *= Math.sqrt(24e6 / pixels);
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(page.width * scale);
        canvas.height = Math.ceil(page.height * scale);
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#000';
        ctx.strokeStyle = '#000';
        ctx.setTransform(...page.transform.map(v => v * scale));
        const text = [];
        await this.execute(source, await source.content(page), page.resources, ctx, text, scale, signal, 0);
        await this.renderAnnotations(source, page, ctx, text, scale, signal);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        return { canvas, text, width: page.width, height: page.height, scale, warnings: [...source.warnings] };
    }
    async renderAnnotations(source, page, ctx, text, scale, signal) {
        for (const a of await source.annotations(page)) {
            if ((a.F ?? 0) & (1 | 2 | 32))
                continue;
            const ap = await source.resolve(a.AP);
            let normal = await source.resolve(ap?.N);
            if (normal && !normal.kind)
                normal = await source.resolve(normal[name(a.AS) || 'Off']);
            if (normal?.kind === 'stream') {
                const rect = await source.deep(a.Rect), bbox = normal.dict.BBox ?? [0, 0, 1, 1], matrix = normal.dict.Matrix ?? identity();
                const pts = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]].map(p => transform(matrix, ...p)), xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
                ctx.save();
                ctx.transform((rect[2] - rect[0]) / (bb[2] - bb[0] || 1), 0, 0, (rect[3] - rect[1]) / (bb[3] - bb[1] || 1), rect[0], rect[1]);
                ctx.translate(-bb[0], -bb[1]);
                ctx.transform(...matrix);
                await this.execute(source, await decodeStream(normal), await source.resolve(normal.dict.Resources) ?? page.resources, ctx, text, scale, signal, 1);
                ctx.restore();
            }
            else if (name(a.Subtype) === 'Highlight' && a.QuadPoints) {
                ctx.save();
                ctx.fillStyle = cssRGB(a.C ?? [1, 1, 0]);
                ctx.globalAlpha = a.CA ?? .3;
                for (let i = 0; i < a.QuadPoints.length; i += 8) {
                    const p = a.QuadPoints.slice(i, i + 8);
                    ctx.beginPath();
                    ctx.moveTo(p[0], p[1]);
                    ctx.lineTo(p[2], p[3]);
                    ctx.lineTo(p[6], p[7]);
                    ctx.lineTo(p[4], p[5]);
                    ctx.closePath();
                    ctx.fill();
                }
                ctx.restore();
            }
            else if (name(a.Subtype) === 'Widget') {
                source.warnings.add('A form widget has no appearance stream');
            }
        }
    }
    async execute(src, bytes, resources, ctx, items, scale, signal, depth) {
        if (depth > 20)
            throw Error('Form XObject nesting limit exceeded');
        const p = new PDFSyntax(bytes), stack = [];
        let state = initialText(), states = [], clip = null, current = [0, 0], count = 0, compat = 0;
        const fonts = await src.resolve(resources.Font) ?? {}, xobjects = await src.resolve(resources.XObject) ?? {}, gs = await src.resolve(resources.ExtGState) ?? {}, colorSpaces = await src.resolve(resources.ColorSpace) ?? {};
        const stroke = () => {
            ctx.globalAlpha = state.strokeAlpha;
            ctx.stroke();
            ctx.globalAlpha = 1;
        };
        const fill = rule => {
            ctx.globalAlpha = state.fillAlpha;
            ctx.fill(rule);
            ctx.globalAlpha = 1;
        };
        const finish = () => {
            if (clip) {
                ctx.clip(clip);
                clip = null;
            }
            ctx.beginPath();
        };
        const show = (str) => {
            if (str?.kind !== 'string')
                throw Error('Invalid text string');
            if (!state.font)
                throw Error('PDF text is missing a font');
            const f = state.font, size = state.size, chars = f.decode(str.bytes), tm = state.tm;
            ctx.save();
            ctx.transform(...tm);
            ctx.translate(0, state.rise);
            ctx.scale(state.hscale, -1);
            ctx.font = `${f.style} ${f.weight} ${size}px ${f.family}`;
            ctx.textBaseline = 'alphabetic';
            let advance = 0, combined = '';
            for (const ch of chars) {
                const natural = ctx.measureText(ch.text).width, target = (ch.width ?? f.defaultWidth ?? (natural / size * 1000)) / 1000 * size, extra = state.charSpace + (ch.code === 32 ? state.wordSpace : 0);
                if (state.mode === 4 || state.mode === 5 || state.mode === 6 || state.mode === 7)
                    throw Error('Text clipping requires PDF.js compatibility rendering');
                if (ch.text && state.mode !== 3) {
                    ctx.save();
                    ctx.translate(advance, 0);
                    if (natural > 0)
                        ctx.scale(target / natural, 1);
                    if (state.mode === 0 || state.mode === 2) {
                        ctx.globalAlpha = state.fillAlpha;
                        ctx.fillText(ch.text, 0, 0);
                    }
                    if (state.mode === 1 || state.mode === 2) {
                        ctx.globalAlpha = state.strokeAlpha;
                        ctx.strokeText(ch.text, 0, 0);
                    }
                    ctx.restore();
                }
                advance += target + extra;
                combined += ch.text;
            }
            const m = ctx.getTransform(), pt = transform([m.a, m.b, m.c, m.d, m.e, m.f], 0, 0);
            if (combined.trim())
                items.push({ text: combined, x: pt[0] / scale, y: pt[1] / scale - Math.hypot(m.c, m.d) * size / scale * .82, w: Math.abs(advance * Math.hypot(m.a, m.b) / scale), h: Math.hypot(m.c, m.d) * size / scale, fontSize: size, angle: Math.atan2(m.b, m.a) });
            ctx.restore();
            state.tm = multiply(tm, [1, 0, 0, 1, advance * state.hscale, 0]);
        };
        ctx.beginPath();
        while (p.pos < p.s.length) {
            if (signal?.aborted)
                throw new DOMException('Cancelled', 'AbortError');
            if (++count > 1e6)
                throw Error('Page operator limit exceeded');
            if (count % 10000 === 0)
                await new Promise(r => setTimeout(r, 0));
            p.skip();
            if (p.pos >= p.s.length)
                break;
            const value = p.value();
            if (value?.kind !== 'operator') {
                stack.push(value);
                if (stack.length > 20000)
                    throw Error('PDF operand stack limit exceeded');
                continue;
            }
            const op = value.value, a = stack.splice(0), last = () => a.at(-1);
            switch (op) {
                case 'q':
                    ctx.save();
                    states.push({ ...state, tm: [...state.tm], tlm: [...state.tlm] });
                    break;
                case 'Q':
                    if (states.length) {
                        ctx.restore();
                        state = states.pop();
                    }
                    break;
                case 'cm':
                    ctx.transform(...a);
                    break;
                case 'w':
                    ctx.lineWidth = a[0];
                    break;
                case 'J':
                    ctx.lineCap = ['butt', 'round', 'square'][a[0]] ?? 'butt';
                    break;
                case 'j':
                    ctx.lineJoin = ['miter', 'round', 'bevel'][a[0]] ?? 'miter';
                    break;
                case 'M':
                    ctx.miterLimit = a[0];
                    break;
                case 'd':
                    ctx.setLineDash(a[0]);
                    ctx.lineDashOffset = a[1];
                    break;
                case 'm':
                    ctx.moveTo(a[0], a[1]);
                    current = a;
                    break;
                case 'l':
                    ctx.lineTo(a[0], a[1]);
                    current = a;
                    break;
                case 'c':
                    ctx.bezierCurveTo(...a);
                    current = a.slice(4);
                    break;
                case 'v':
                    ctx.bezierCurveTo(...current, ...a);
                    current = a.slice(2);
                    break;
                case 'y':
                    ctx.bezierCurveTo(...a, ...a.slice(2));
                    current = a.slice(2);
                    break;
                case 'h':
                    ctx.closePath();
                    break;
                case 're':
                    ctx.rect(...a);
                    current = a.slice(0, 2);
                    break;
                case 'S':
                    stroke();
                    finish();
                    break;
                case 's':
                    ctx.closePath();
                    stroke();
                    finish();
                    break;
                case 'f':
                case 'F':
                    fill('nonzero');
                    finish();
                    break;
                case 'f*':
                    fill('evenodd');
                    finish();
                    break;
                case 'B':
                case 'B*':
                    fill(op === 'B' ? 'nonzero' : 'evenodd');
                    stroke();
                    finish();
                    break;
                case 'b':
                case 'b*':
                    ctx.closePath();
                    fill(op === 'b' ? 'nonzero' : 'evenodd');
                    stroke();
                    finish();
                    break;
                case 'n':
                    finish();
                    break;
                case 'W':
                    clip = 'nonzero';
                    break;
                case 'W*':
                    clip = 'evenodd';
                    break;
                case 'g':
                    ctx.fillStyle = cssRGB([a[0], a[0], a[0]]);
                    break;
                case 'G':
                    ctx.strokeStyle = cssRGB([a[0], a[0], a[0]]);
                    break;
                case 'rg':
                    ctx.fillStyle = cssRGB(a);
                    break;
                case 'RG':
                    ctx.strokeStyle = cssRGB(a);
                    break;
                case 'k':
                    ctx.fillStyle = cmyk(a);
                    break;
                case 'K':
                    ctx.strokeStyle = cmyk(a);
                    break;
                case 'cs':
                    state.fillCS = name(a[0]);
                    break;
                case 'CS':
                    state.strokeCS = name(a[0]);
                    break;
                case 'sc':
                case 'scn':
                case 'SC':
                case 'SCN': {
                    let cs = op[0] === 's' ? state.fillCS : state.strokeCS;
                    let def = await src.resolve(colorSpaces[cs]);
                    if (def) {
                        if (Array.isArray(def) && name(def[0]) === 'ICCBased') {
                            const profile = await src.resolve(def[1]);
                            cs = profile.dict.N === 3 ? 'DeviceRGB' : profile.dict.N === 4 ? 'DeviceCMYK' : 'DeviceGray';
                        }
                        else
                            throw Error('Pattern or spot colors require PDF.js compatibility rendering');
                    }
                    let col;
                    if (cs === 'DeviceGray' || cs === 'G')
                        col = cssRGB([a[0], a[0], a[0]]);
                    else if (cs === 'DeviceRGB' || cs === 'RGB')
                        col = cssRGB(a);
                    else if (cs === 'DeviceCMYK' || cs === 'CMYK')
                        col = cmyk(a);
                    else
                        throw Error(`Colorspace ${cs} requires PDF.js compatibility rendering`);
                    if (op[0] === 's')
                        ctx.fillStyle = col;
                    else
                        ctx.strokeStyle = col;
                    break;
                }
                case 'gs': {
                    const d = await src.resolve(gs[name(a[0])]);
                    if (!d)
                        throw Error('Missing graphics state');
                    if (d.SMask && name(d.SMask) !== 'None')
                        throw Error('Soft-mask graphics require PDF.js compatibility rendering');
                    if (d.ca !== undefined)
                        state.fillAlpha = d.ca;
                    if (d.CA !== undefined)
                        state.strokeAlpha = d.CA;
                    if (d.LW !== undefined)
                        ctx.lineWidth = d.LW;
                    if (d.BM) {
                        const bm = name(Array.isArray(d.BM) ? d.BM[0] : d.BM);
                        const map = { Normal: 'source-over', Compatible: 'source-over', Multiply: 'multiply', Screen: 'screen', Overlay: 'overlay', Darken: 'darken', Lighten: 'lighten', ColorDodge: 'color-dodge', ColorBurn: 'color-burn', HardLight: 'hard-light', SoftLight: 'soft-light', Difference: 'difference', Exclusion: 'exclusion', Hue: 'hue', Saturation: 'saturation', Color: 'color', Luminosity: 'luminosity' };
                        if (!map[bm])
                            throw Error('Unsupported blend mode');
                        ctx.globalCompositeOperation = map[bm];
                    }
                    break;
                }
                case 'BT':
                    state.tm = identity();
                    state.tlm = identity();
                    break;
                case 'ET': break;
                case 'Tf':
                    state.font = await fontFor(src, fonts[name(a[0])]);
                    state.size = a[1];
                    break;
                case 'Tc':
                    state.charSpace = a[0];
                    break;
                case 'Tw':
                    state.wordSpace = a[0];
                    break;
                case 'Tz':
                    state.hscale = a[0] / 100;
                    break;
                case 'TL':
                    state.leading = a[0];
                    break;
                case 'Tr':
                    state.mode = a[0];
                    break;
                case 'Ts':
                    state.rise = a[0];
                    break;
                case 'Tm':
                    state.tm = [...a];
                    state.tlm = [...a];
                    break;
                case 'Td':
                case 'TD':
                    if (op === 'TD')
                        state.leading = -a[1];
                    state.tlm = multiply(state.tlm, [1, 0, 0, 1, a[0], a[1]]);
                    state.tm = [...state.tlm];
                    break;
                case 'T*':
                    state.tlm = multiply(state.tlm, [1, 0, 0, 1, 0, -state.leading]);
                    state.tm = [...state.tlm];
                    break;
                case 'Tj':
                    show(a[0]);
                    break;
                case 'TJ':
                    for (const v of a[0])
                        if (typeof v === 'number')
                            state.tm = multiply(state.tm, [1, 0, 0, 1, -v / 1000 * state.size * state.hscale, 0]);
                        else
                            show(v);
                    break;
                case "'":
                    state.tlm = multiply(state.tlm, [1, 0, 0, 1, 0, -state.leading]);
                    state.tm = [...state.tlm];
                    show(a[0]);
                    break;
                case '"':
                    state.wordSpace = a[0];
                    state.charSpace = a[1];
                    state.tlm = multiply(state.tlm, [1, 0, 0, 1, 0, -state.leading]);
                    state.tm = [...state.tlm];
                    show(a[2]);
                    break;
                case 'Do': {
                    const ref = xobjects[name(a[0])], obj = await src.resolve(ref);
                    if (!obj)
                        throw Error('Missing XObject');
                    if (name(obj.dict.Subtype) === 'Image') {
                        const image = await imageFor(src, ref);
                        ctx.save();
                        ctx.globalAlpha = state.fillAlpha;
                        ctx.transform(1, 0, 0, -1, 0, 1);
                        ctx.drawImage(image, 0, 0, 1, 1);
                        ctx.restore();
                    }
                    else if (name(obj.dict.Subtype) === 'Form') {
                        if (obj.dict.Group && name((await src.resolve(obj.dict.Group)).S) === 'Transparency')
                            (() => {
                                throw Error('Transparency groups require PDF.js compatibility rendering');
                            })();
                        ctx.save();
                        if (obj.dict.Matrix)
                            ctx.transform(...obj.dict.Matrix);
                        const b = obj.dict.BBox;
                        if (b) {
                            ctx.beginPath();
                            ctx.rect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
                            ctx.clip();
                        }
                        await this.execute(src, await decodeStream(obj), await src.resolve(obj.dict.Resources) ?? resources, ctx, items, scale, signal, depth + 1);
                        ctx.restore();
                    }
                    else
                        throw Error('Unsupported XObject');
                    break;
                }
                case 'BX':
                    compat++;
                    break;
                case 'EX':
                    compat = Math.max(0, compat - 1);
                    break;
                case 'BMC':
                case 'BDC':
                case 'EMC':
                case 'MP':
                case 'DP':
                case 'ri':
                case 'i': break;
                case 'BI': throw Error('Inline images require PDF.js compatibility rendering');
                case 'sh': throw Error('PDF shadings require PDF.js compatibility rendering');
                default: if (!compat)
                    throw Error(`Unsupported PDF operator "${op}". Enable PDF.js compatibility rendering.`);
            }
        }
        while (states.length) {
            ctx.restore();
            states.pop();
        }
    }
}
export class PDFJSRenderer {
    constructor(lib) {
        this.lib = lib;
        this.name = `PDF.js ${lib.version}`;
        this.docs = new WeakMap();
    }
    async document(src) {
        if (!this.docs.has(src)) {
            const promise = this.lib.getDocument({ data: src.bytes.slice(), isEvalSupported: false, enableXfa: false, stopAtErrors: true, cMapUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${this.lib.version}/cmaps/`, cMapPacked: true, standardFontDataUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${this.lib.version}/standard_fonts/`, wasmUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${this.lib.version}/wasm/` }).promise;
            this.docs.set(src, promise);
        }
        return this.docs.get(src);
    }
    async render(src, index, scale = 1, { signal } = {}) {
        const doc = await this.document(src), page = await doc.getPage(index + 1), vp = page.getViewport({ scale }), canvas = document.createElement('canvas');
        if (vp.width * vp.height > 24e6)
            return this.render(src, index, scale * Math.sqrt(24e6 / (vp.width * vp.height)), { signal });
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        const ctx = canvas.getContext('2d', { alpha: false }), task = page.render({ canvasContext: ctx, viewport: vp });
        const cancel = () => task.cancel();
        signal?.addEventListener('abort', cancel, { once: true });
        try {
            await task.promise;
        }
        finally {
            signal?.removeEventListener('abort', cancel);
        }
        const content = await page.getTextContent(), base = page.getViewport({ scale: 1 }), text = content.items.filter(i => i.str).map(i => {
            const m = multiply(base.transform, i.transform), h = Math.hypot(m[2], m[3]);
            return { text: i.str, x: m[4], y: m[5] - h * .82, w: i.width, h, fontSize: h, angle: Math.atan2(m[1], m[0]) };
        });
        return { canvas, text, width: base.width, height: base.height, scale, warnings: [] };
    }
    static async load() {
        const version = '6.3.289';
        const lib = await import(`https://cdn.jsdelivr.net/npm/pdfjs-dist@${version}/build/pdf.mjs`);
        lib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${version}/build/pdf.worker.mjs`;
        return new PDFJSRenderer(lib);
    }
}
