import { PDFWriter, N, R, S, ST, unicodeString, decodeStream, name, stringText, annotationOps, pdfLiteral, rgbOps, num } from './pdf-kernel.mjs';
import { ascii, concatBytes, transform, identity, multiply, uid, base64ToBytes, colorRGB } from './core.mjs';
export const cropBox = p => p.crop ?? { x: 0, y: 0, w: p.width, h: p.height };
export function makePage(sourceId, sourcePage, info) {
    return { id: uid(), sourceId, sourcePage, width: info.width, height: info.height, rotation: 0, crop: null, annotations: [] };
}
export function blankState() {
    return { name: 'Untitled.pdf', metadata: { title: 'Untitled', author: '', subject: '' }, pages: [makePage(null, 0, { width: 612, height: 792 })], fieldValues: {} };
}
export async function getWidgets(source, index) {
    const page = source.pages[index], result = [];
    for (const a of await source.annotations(page)) {
        if (name(a.Subtype) !== 'Widget')
            continue;
        let d = a, chain = [], seen = new Set();
        for (let i = 0; d && i < 20; i++) {
            chain.unshift(d);
            if (!d.Parent || seen.has(d.Parent.id))
                break;
            seen.add(d.Parent.id);
            d = await source.resolve(d.Parent);
        }
        const combined = Object.assign({}, ...chain), title = chain.map(x => stringText(x.T)).filter(Boolean).join('.'), rect = await source.deep(a.Rect);
        if (!rect)
            continue;
        const corners = [[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]].map(p => transform(page.transform, ...p)), xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
        result.push({ id: a._ref?.id ?? title, name: title || `Field ${result.length + 1}`, type: name(combined.FT), flags: combined.Ff ?? 0, value: name(combined.FT) === 'Btn' ? !!((name(combined.V) && name(combined.V) !== 'Off') || (name(a.AS) && name(a.AS) !== 'Off')) : stringText(combined.V), rect, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), annotation: a, combined });
    }
    return result;
}
async function addImage(writer, data) {
    const blob = await (await fetch(data)).blob(), bitmap = await createImageBitmap(blob);
    if (bitmap.width * bitmap.height > 40e6)
        throw Error('Image exceeds pixel limit');
    const c = document.createElement('canvas');
    c.width = bitmap.width;
    c.height = bitmap.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const rgba = ctx.getImageData(0, 0, c.width, c.height).data, rgb = new Uint8Array(c.width * c.height * 3), alpha = new Uint8Array(c.width * c.height);
    let transparent = false;
    for (let p = 0; p < alpha.length; p++) {
        rgb.set(rgba.subarray(p * 4, p * 4 + 3), p * 3);
        alpha[p] = rgba[p * 4 + 3];
        if (alpha[p] !== 255)
            transparent = true;
    }
    let smask;
    if (transparent)
        smask = await writer.stream({ Type: N('XObject'), Subtype: N('Image'), Width: c.width, Height: c.height, ColorSpace: N('DeviceGray'), BitsPerComponent: 8 }, alpha);
    return writer.stream({ Type: N('XObject'), Subtype: N('Image'), Width: c.width, Height: c.height, ColorSpace: N('DeviceRGB'), BitsPerComponent: 8, ...(smask ? { SMask: smask } : {}) }, rgb);
}
function copiedDictionary(writer, value) {
    return value?.kind === 'ref' ? { ...(writer.objects[value.id] ?? {}) } : { ...(value ?? {}) };
}
async function sourceForm(writer, source, index, values = {}) {
    const page = source.pages[index], resources = await writer.copy(source, page.resources), xobjects = copiedDictionary(writer, resources.XObject), ops = [await source.content(page)];
    let n = 0;
    const widgets = await getWidgets(source, index), byId = new Map(widgets.map(w => [w.id, w]));
    for (const a of await source.annotations(page)) {
        if ((a.F ?? 0) & (1 | 2 | 32))
            continue;
        const widget = byId.get(a._ref?.id), fieldValue = widget ? values[widget.name] : undefined;
        if (widget && fieldValue !== undefined && ['Tx', 'Btn'].includes(widget.type)) {
            const [x0, y0, x1, y1] = widget.rect, w = x1 - x0, h = y1 - y0;
            resources.Font = { ...copiedDictionary(writer, resources.Font), FOLIO_FIELD: writer.font('Helvetica') };
            const value = widget.type === 'Btn' ? (fieldValue ? 'X' : '') : String(fieldValue);
            ops.push(ascii(`\nq 1 1 1 rg ${num(x0)} ${num(y0)} ${num(w)} ${num(h)} re f .25 .32 .42 RG .6 w ${num(x0)} ${num(y0)} ${num(w)} ${num(h)} re S 0 0 0 rg BT /FOLIO_FIELD ${num(Math.min(12, h * .6))} Tf 1 0 0 1 ${num(x0 + 3)} ${num(y0 + h * .32)} Tm ${pdfLiteral(value)} Tj ET Q\n`));
            continue;
        }
        const ap = await source.resolve(a.AP);
        let normal = await source.resolve(ap?.N);
        if (normal && !normal.kind)
            normal = await source.resolve(normal[name(a.AS) || 'Off']);
        if (normal?.kind === 'stream') {
            const rect = await source.deep(a.Rect), bbox = normal.dict.BBox ?? [0, 0, 1, 1], matrix = normal.dict.Matrix ?? identity(), corners = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]].map(p => transform(matrix, ...p)), xs = corners.map(p => p[0]), ys = corners.map(p => p[1]), bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], sx = (rect[2] - rect[0]) / (bb[2] - bb[0] || 1), sy = (rect[3] - rect[1]) / (bb[3] - bb[1] || 1), key = `FOLIO_AP${n++}`;
            xobjects[key] = writer.add(await writer.copy(source, normal));
            ops.push(ascii(`\nq ${num(sx)} 0 0 ${num(sy)} ${num(rect[0] - bb[0] * sx)} ${num(rect[1] - bb[1] * sy)} cm /${key} Do Q\n`));
        }
        else if (name(a.Subtype) === 'Highlight' && a.QuadPoints) {
            resources.ExtGState = { ...copiedDictionary(writer, resources.ExtGState), FOLIO_HL: writer.add({ Type: N('ExtGState'), ca: a.CA ?? .3, BM: N('Multiply') }) };
            let op = `\nq /FOLIO_HL gs ${(a.C ?? [1, 1, 0]).map(num).join(' ')} rg `;
            for (let i = 0; i < a.QuadPoints.length; i += 8) {
                const p = a.QuadPoints.slice(i, i + 8);
                op += `${p[0]} ${p[1]} m ${p[2]} ${p[3]} l ${p[6]} ${p[7]} l ${p[4]} ${p[5]} l h f `;
            }
            ops.push(ascii(op + 'Q\n'));
        }
    }
    resources.XObject = xobjects;
    return writer.stream({ Type: N('XObject'), Subtype: N('Form'), FormType: 1, BBox: page.box, Resources: resources, ...(page.node.Group ? { Group: await writer.copy(source, page.node.Group) } : {}) }, concatBytes(ops));
}
function assertLatinAnnotations(pages) {
    for (const p of pages)
        for (const a of p.annotations) {
            if (['text', 'signature', 'stamp', 'field'].includes(a.type) && /[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/.test(a.text ?? ''))
                throw Error('Vector export of new text currently supports Latin-1 characters. Use image-only PDF export to preserve other scripts.');
        }
}
export async function exportVector(state, sources, { indices = null, onProgress = () => {
} } = {}) {
    const pages = indices ? indices.map(i => state.pages[i]) : state.pages;
    if (pages.some(p => p.annotations.some(a => a.type === 'redact')))
        throw Error('There are pending redactions. Use Apply redactions to create a sanitized, image-only PDF.');
    assertLatinAnnotations(pages);
    for (const value of Object.values(state.fieldValues ?? {}))
        if (typeof value === 'string' && /[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/.test(value))
            throw Error('Vector export of filled text requires Latin-1. Use image-only export for other scripts.');
    const writer = new PDFWriter(), root = writer.reserve(), pagesRoot = writer.reserve(), refs = [], fields = [], fontResources = { FR: writer.font('Helvetica'), FB: writer.font('Helvetica-Bold'), FC: writer.font('Times-Italic') }, highlight = writer.add({ Type: N('ExtGState'), ca: .3, BM: N('Multiply') }), formCache = new Map();
    for (let i = 0; i < pages.length; i++) {
        const p = pages[i], crop = cropBox(p), pageRef = writer.reserve(), resources = { Font: { ...fontResources }, XObject: {}, ExtGState: { GH: highlight } }, ops = [], annots = [];
        refs.push(pageRef);
        if (p.sourceId) {
            const source = sources.get(p.sourceId);
            if (!source)
                throw Error('Source document is missing');
            const key = `${p.sourceId}:${p.sourcePage}`;
            if (!formCache.has(key)) {
                const values = {};
                for (const [k, v] of Object.entries(state.fieldValues ?? {}))
                    if (k.startsWith(p.sourceId + ':'))
                        values[k.slice(p.sourceId.length + 1)] = v;
                formCache.set(key, await sourceForm(writer, source, p.sourcePage, values));
            }
            resources.XObject.Original = formCache.get(key);
            const m = source.pages[p.sourcePage].transform;
            ops.push(`q ${[m[0], -m[1], m[2], -m[3], m[4] - crop.x, crop.h - m[5] + crop.y].map(num).join(' ')} cm /Original Do Q`);
        }
        ops.push(`q 1 0 0 1 ${num(-crop.x)} ${num(crop.h - p.height + crop.y)} cm`);
        let imageIndex = 0;
        for (const a of p.annotations) {
            if (a.type === 'field' || a.type === 'check') {
                const x = a.x - crop.x, y = crop.h - (a.y - crop.y) - a.h, fieldName = `${a.name || 'Field'}_${i + 1}_${fields.length + 1}`, size = a.fontSize ?? 12;
                const off = await writer.stream({ Type: N('XObject'), Subtype: N('Form'), BBox: [0, 0, a.w, a.h], Resources: { Font: fontResources } }, ascii(`q 1 1 1 rg .55 .65 .8 RG .7 w 0 0 ${num(a.w)} ${num(a.h)} re B Q`));
                let ap = off;
                const isCheck = a.type === 'check';
                {
                    const txt = isCheck ? 'X' : String(a.text ?? '');
                    ap = await writer.stream({ Type: N('XObject'), Subtype: N('Form'), BBox: [0, 0, a.w, a.h], Resources: { Font: fontResources } }, ascii(`q 1 1 1 rg .55 .65 .8 RG .7 w 0 0 ${num(a.w)} ${num(a.h)} re B 0 0 0 rg BT /FR ${num(size)} Tf 1 0 0 1 4 ${num(a.h - size - 3)} Tm ${pdfLiteral(txt)} Tj ET Q`));
                }
                const field = writer.add({ Type: N('Annot'), Subtype: N('Widget'), FT: N(isCheck ? 'Btn' : 'Tx'), T: unicodeString(fieldName), Rect: [x, y, x + a.w, y + a.h], P: pageRef, F: 4, Ff: 0, V: isCheck ? N(a.checked ? 'Yes' : 'Off') : unicodeString(String(a.text ?? '')), DA: S(`/FR ${size} Tf 0 g`), ...(isCheck ? { AS: N(a.checked ? 'Yes' : 'Off'), AP: { N: { Off: off, Yes: ap } } } : { AP: { N: ap } }) });
                fields.push(field);
                annots.push(field);
                continue;
            }
            if (a.type === 'note') {
                const x = a.x - crop.x, y = crop.h - (a.y - crop.y) - a.h;
                annots.push(writer.add({ Type: N('Annot'), Subtype: N('Text'), Rect: [x, y, x + a.w, y + a.h], Contents: unicodeString(a.text || ''), T: unicodeString(a.author || 'Reviewer'), Name: N('Comment'), F: 4, C: [1, .8, .2], Open: false }));
                continue;
            }
            let imageName = null;
            if (a.type === 'image') {
                imageName = `Image${imageIndex++}`;
                resources.XObject[imageName] = await addImage(writer, a.data);
            }
            const alphaName = `Alpha${resources.ExtGState ? Object.keys(resources.ExtGState).length : 0}`;
            resources.ExtGState[alphaName] = writer.add({ Type: N('ExtGState'), ca: a.opacity ?? 1, CA: a.opacity ?? 1 });
            ops.push(`q /${alphaName} gs\n${annotationOps(a, p.height, { imageName })}\nQ`);
        }
        ops.push('Q');
        const contents = await writer.stream({}, ascii(ops.join('\n')));
        writer.set(pageRef, { Type: N('Page'), Parent: pagesRoot, MediaBox: [0, 0, crop.w, crop.h], Rotate: p.rotation, Resources: resources, Contents: contents, ...(annots.length ? { Annots: annots } : {}) });
        onProgress((i + 1) / pages.length);
    }
    writer.set(pagesRoot, { Type: N('Pages'), Kids: refs, Count: refs.length });
    writer.set(root, { Type: N('Catalog'), Pages: pagesRoot, ...(fields.length ? { AcroForm: writer.add({ Fields: fields, DR: { Font: fontResources }, DA: S('/FR 12 Tf 0 g'), NeedAppearances: false }) } : {}) });
    const metadata = writer.add({ Title: unicodeString(state.metadata?.title || state.name), Author: unicodeString(state.metadata?.author || ''), Subject: unicodeString(state.metadata?.subject || ''), Creator: S('Folio Pro'), Producer: S('Folio PDF Kernel 0.1'), ModDate: S('D:' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + 'Z') });
    return writer.save(root, metadata);
}
export async function drawAnnotations(ctx, page, { redactions = false, images = new Map() } = {}) {
    for (const a of page.annotations) {
        if (a.type === 'redact')
            continue;
        ctx.save();
        ctx.globalAlpha = a.opacity ?? 1;
        ctx.strokeStyle = a.color || '#24344a';
        ctx.fillStyle = a.color || '#24344a';
        ctx.lineWidth = a.strokeWidth || 1.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        if (a.type === 'image') {
            let im = images.get(a.data);
            if (!im) {
                im = await createImageBitmap(await (await fetch(a.data)).blob());
                images.set(a.data, im);
            }
            ctx.drawImage(im, a.x, a.y, a.w, a.h);
        }
        else if (a.type === 'highlight') {
            ctx.globalAlpha = .3 * (a.opacity ?? 1);
            ctx.globalCompositeOperation = 'multiply';
            ctx.fillRect(a.x, a.y, a.w, a.h);
        }
        else if (a.type === 'rect') {
            if (a.fill && a.fill !== 'none') {
                ctx.fillStyle = a.fill;
                ctx.fillRect(a.x, a.y, a.w, a.h);
            }
            ctx.strokeRect(a.x, a.y, a.w, a.h);
        }
        else if (a.type === 'ellipse') {
            ctx.beginPath();
            ctx.ellipse(a.x + a.w / 2, a.y + a.h / 2, a.w / 2, a.h / 2, 0, 0, Math.PI * 2);
            ctx.stroke();
        }
        else if (a.type === 'ink' || a.type === 'line') {
            ctx.beginPath();
            for (const [i, p] of (a.points ?? [[a.x, a.y], [a.x + a.w, a.y + a.h]]).entries())
                ctx[i ? 'lineTo' : 'moveTo'](...p);
            ctx.stroke();
        }
        else if (a.type === 'note') {
            ctx.fillStyle = '#ffe082';
            ctx.fillRect(a.x, a.y, 24, 24);
            ctx.fillStyle = '#795200';
            ctx.font = 'bold 14px Arial';
            ctx.fillText('N', a.x + 6, a.y + 18);
        }
        else {
            if (a.type === 'check' && !a.checked) {
                ctx.strokeRect(a.x, a.y, a.w, a.h);
                ctx.restore();
                continue;
            }
            const size = a.fontSize || 14;
            if (a.type === 'field') {
                ctx.fillStyle = '#fff';
                ctx.fillRect(a.x, a.y, a.w, a.h);
                ctx.strokeStyle = '#899bb8';
                ctx.strokeRect(a.x, a.y, a.w, a.h);
                ctx.fillStyle = a.color || '#24344a';
            }
            if (a.type === 'stamp')
                ctx.strokeRect(a.x, a.y, a.w, a.h);
            ctx.font = `${a.type === 'signature' ? 'italic' : a.bold ? 'bold' : ''} ${size}px ${a.type === 'signature' ? 'Georgia' : 'Arial'}`;
            ctx.textBaseline = 'alphabetic';
            for (const [i, line] of (a.type === 'check' ? 'X' : a.text ?? '').split('\n').entries())
                ctx.fillText(line, a.x + (a.type === 'stamp' ? 8 : 0), a.y + (a.type === 'stamp' ? a.h * .65 : size) + i * size * 1.25);
        }
        ctx.restore();
    }
    if (redactions) {
        ctx.save();
        ctx.fillStyle = '#000';
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        for (const a of page.annotations.filter(a => a.type === 'redact'))
            ctx.fillRect(a.x - .7, a.y - .7, a.w + 1.4, a.h + 1.4);
        ctx.restore();
    }
}
export async function renderComposite(page, sources, renderer, state, { scale = 2, redactions = false, rotate = true } = {}) {
    let rendered;
    if (page.sourceId)
        rendered = await renderer.render(sources.get(page.sourceId), page.sourcePage, scale);
    else {
        const c = document.createElement('canvas');
        c.width = Math.ceil(page.width * scale);
        c.height = Math.ceil(page.height * scale);
        c.getContext('2d').fillStyle = 'white';
        c.getContext('2d').fillRect(0, 0, c.width, c.height);
        rendered = { canvas: c, scale };
    }
    scale = rendered.scale;
    const full = document.createElement('canvas');
    full.width = rendered.canvas.width;
    full.height = rendered.canvas.height;
    const ctx = full.getContext('2d');
    ctx.drawImage(rendered.canvas, 0, 0);
    ctx.scale(scale, scale);
    if (page.sourceId) {
        for (const w of await getWidgets(sources.get(page.sourceId), page.sourcePage)) {
            const value = state.fieldValues?.[`${page.sourceId}:${w.name}`];
            if (value === undefined)
                continue;
            ctx.fillStyle = '#fff';
            ctx.fillRect(w.x, w.y, w.w, w.h);
            ctx.strokeStyle = '#789';
            ctx.lineWidth = .6;
            ctx.strokeRect(w.x, w.y, w.w, w.h);
            ctx.fillStyle = '#24344a';
            ctx.font = `${Math.min(12, w.h * .6)}px Arial`;
            ctx.fillText(w.type === 'Btn' ? (value ? 'X' : '') : String(value), w.x + 3, w.y + w.h * .7);
        }
    }
    await drawAnnotations(ctx, page, { redactions });
    const crop = cropBox(page), sw = Math.max(1, Math.ceil(crop.w * scale)), sh = Math.max(1, Math.ceil(crop.h * scale)), out = document.createElement('canvas'), r = rotate ? page.rotation : 0;
    out.width = r % 180 ? sh : sw;
    out.height = r % 180 ? sw : sh;
    const o = out.getContext('2d');
    if (r === 90) {
        o.translate(sh, 0);
        o.rotate(Math.PI / 2);
    }
    if (r === 180) {
        o.translate(sw, sh);
        o.rotate(Math.PI);
    }
    if (r === 270) {
        o.translate(0, sw);
        o.rotate(-Math.PI / 2);
    }
    o.drawImage(full, crop.x * scale, crop.y * scale, crop.w * scale, crop.h * scale, 0, 0, sw, sh);
    return out;
}
export async function exportRaster(state, sources, renderer, { redactions = false, onProgress = () => {
}, scale = 2, indices = null } = {}) {
    if (!redactions && state.pages.some(p => p.annotations.some(a => a.type === 'redact')))
        throw Error('Pending redactions require explicit sanitized export');
    const writer = new PDFWriter(), root = writer.reserve(), pagesRoot = writer.reserve(), refs = [], pages = indices ? indices.map(i => state.pages[i]) : state.pages;
    for (let i = 0; i < pages.length; i++) {
        const page = pages[i], canvas = await renderComposite(page, sources, renderer, state, { scale, redactions, rotate: false }), crop = cropBox(page), pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, rgb = new Uint8Array(canvas.width * canvas.height * 3);
        for (let p = 0; p < canvas.width * canvas.height; p++)
            rgb.set(pixels.subarray(p * 4, p * 4 + 3), p * 3);
        const img = await writer.stream({ Type: N('XObject'), Subtype: N('Image'), Width: canvas.width, Height: canvas.height, ColorSpace: N('DeviceRGB'), BitsPerComponent: 8 }, rgb), content = await writer.stream({}, ascii(`q ${num(crop.w)} 0 0 ${num(crop.h)} 0 0 cm /PageImage Do Q`));
        refs.push(writer.add({ Type: N('Page'), Parent: pagesRoot, MediaBox: [0, 0, crop.w, crop.h], Rotate: page.rotation, Resources: { XObject: { PageImage: img } }, Contents: content }));
        onProgress((i + 1) / pages.length);
        canvas.width = canvas.height = 1;
    }
    writer.set(pagesRoot, { Type: N('Pages'), Count: refs.length, Kids: refs });
    writer.set(root, { Type: N('Catalog'), Pages: pagesRoot });
    return writer.save(root, writer.add({ Title: S(redactions ? 'Sanitized document' : 'Image-only document'), Producer: S('Folio Pro image-only exporter') }));
}
