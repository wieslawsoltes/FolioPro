import { VERSION, LIMITS, uid, clone, History, ByteLRU, TaskPool, clamp, escapeHTML, bytesToBase64, base64ToBytes, parsePageRange, rectFromPoints, validateState, normalizedRotation } from './core.mjs';
import { PDFSource } from './pdf-kernel.mjs';
import { NativePDFRenderer, PDFJSRenderer } from './pdf-renderer.mjs';
import { PageCompositor } from './gpu.mjs';
import { blankState, makePage, cropBox, getWidgets, exportVector, exportRaster, renderComposite, drawAnnotations } from './documents.mjs';
import { createSample } from './sample.mjs';
import { icon, icons, toolGroups, toolNames, DialogUI, toast, download, field, storage } from './ui.mjs';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const svgNS = 'http://www.w3.org/2000/svg';
const formatBytes = n => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const displaySize = p => {
    const c = cropBox(p);
    return p.rotation % 180 ? { w: c.h, h: c.w } : { w: c.w, h: c.h };
};
export class FolioApp {
    constructor() {
        this.sources = new Map();
        this.history = null;
        this.renderer = new NativePDFRenderer();
        this.pool = new TaskPool(2);
        this.cache = new ByteLRU(128 * 1024 * 1024, x => {
            x.canvas.width = x.canvas.height = 1;
        });
        this.cachePending = new Map();
        this.views = new Map();
        this.texts = new Map();
        this.widgets = new Map();
        this.thumbs = new Map();
        this.activeIndex = 0;
        this.tool = 'select';
        this.tab = 'all';
        this.rightTab = 'comments';
        this.selected = null;
        this.zoom = .9;
        this.fitMode = 'page';
        this.draft = null;
        this.gesture = null;
        this.search = { term: '', results: [], index: 0, token: 0 };
        this.signature = null;
        this.image = null;
        this.clipboard = null;
        this.dialog = new DialogUI();
        this.revision = 0;
        this.loading = false;
        this.organizing = false;
        this.defaultColor = '#2759a1';
        this.defaultFontSize = 16;
        this.defaultStroke = 2;
        this.defaultAuthor = 'You';
        this.autoSaveTimer = 0;
        this.unloading = false;
        this.gpu = new PageCompositor($('#gpu-canvas'), (mode, reason) => {
            document.body.classList.toggle('gpu-on', mode === 'WebGPU');
            $('#engine-name').textContent = mode === 'WebGPU' ? 'WebGPU compositor' : 'Canvas 2D compositor';
            $('#engine-badge').title = `${this.renderer.name}\n${reason}`;
            this.gpuReason = reason;
            this.updateGpu();
        });
    }
    get state() {
        return this.history?.state;
    }
    get page() {
        return this.state?.pages[this.activeIndex];
    }
    get selection() {
        if (!this.selected)
            return null;
        for (const p of this.state.pages) {
            const a = p.annotations.find(a => a.id === this.selected);
            if (a)
                return { page: p, annotation: a };
        }
        return null;
    }
    async start() {
        icons();
        this.bindEvents();
        this.renderTools();
        this.renderMenu();
        const gpuInit = this.gpu.initialize();
        await this.loadDemo(false);
        await gpuInit;
        this.fit('page');
        this.ready = true;
        $('#status-text').textContent = 'Ready · Select, annotate, and make it yours';
        this.autosaveAvailable = await storage('get').catch(() => null);
        if (this.autosaveAvailable)
            toast('A saved workspace is available in File → Restore autosave.', false, 6500);
        window.dispatchEvent(new Event('folio-ready'));
    }
    async busy(label, task) {
        if (this.loading)
            throw Error('Another document operation is in progress');
        this.loading = true;
        $('#busy-label').textContent = label;
        $('#busy').hidden = false;
        $('#busy-progress').removeAttribute('value');
        await new Promise(r => requestAnimationFrame(r));
        try {
            return await task(v => $('#busy-progress').value = v);
        }
        finally {
            this.loading = false;
            $('#busy').hidden = true;
        }
    }
    async loadDemo(confirm = true) {
        if (confirm && !await this.confirmReplace())
            return;
        const bytes = await createSample(), source = await PDFSource.load(bytes, 'Northstar — Strategy 2026.pdf'), id = uid();
        this.sources = new Map([[id, source]]);
        const state = { name: source.label, metadata: source.metadata, pages: source.pages.map(p => makePage(id, p.index, p)), fieldValues: {} };
        state.pages[0].annotations.push({ id: uid(), type: 'note', x: 533, y: 310, w: 24, h: 24, text: 'The revised opening is much clearer. Let’s keep this direction.', author: 'Alex Morgan', color: '#e7b349', date: new Date().toISOString(), resolved: false });
        state.pages[1].annotations.push({ id: uid(), type: 'note', x: 535, y: 386, w: 24, h: 24, text: 'Please confirm these illustrative metrics before sharing.', author: 'Jamie Chen', color: '#e7b349', date: new Date().toISOString(), resolved: false });
        this.setState(state);
        this.history.markSaved();
        this.syncChrome();
        await this.ensurePage(this.state.pages[0].id);
    }
    async confirmReplace() {
        if (!this.history?.dirty)
            return true;
        return !!await this.dialog.open('Start a new workspace?', `<p class="dialog-copy">Your current document has changes. Export a PDF or save a Folio project before replacing it. Local autosave is not a substitute for a downloaded copy.</p>`, { ok: 'Continue' });
    }
    setState(state) {
        validateState(state);
        this.observer?.disconnect();
        this.revision++;
        this.cache.clear();
        this.cachePending.clear();
        this.texts.clear();
        this.widgets.clear();
        this.thumbs.clear();
        this.selected = null;
        this.activeIndex = 0;
        this.search = { term: '', results: [], index: 0, token: this.search.token + 1 };
        $('#find-input').value = '';
        $('#find-count').textContent = '0 matches';
        this.history = new History(state);
        this.structureSignature = '';
        this.history.subscribe((s, label) => this.onChange(label));
        this.onChange('Document opened', false);
        this.history.markSaved();
        this.syncChrome();
    }
    onChange(label, save = true) {
        const sig = this.state.pages.map(p => [p.id, p.sourceId, p.sourcePage, p.rotation, JSON.stringify(p.crop)].join(':')).join('|');
        const changed = sig !== this.structureSignature;
        this.activeIndex = clamp(this.activeIndex, 0, this.state.pages.length - 1);
        if (this.selected && !this.selection)
            this.selected = null;
        if (changed) {
            this.structureSignature = sig;
            this.buildPages();
            this.buildThumbnails();
            if (this.organizing)
                this.renderOrganizer();
        }
        else {
            for (const p of this.state.pages)
                this.renderOverlay(p.id);
            if (this.page)
                this.updateThumbnail(this.page).catch(e => console.warn(e));
        }
        this.syncChrome();
        this.renderRight();
        if (save) {
            $('#status-text').textContent = label;
            this.scheduleAutosave();
        }
        this.updateGpu();
    }
    syncChrome() {
        if (!this.history)
            return;
        $('#document-name').textContent = this.state.name;
        document.title = `${this.history.dirty ? '• ' : ''}${this.state.name} — Folio Pro`;
        $('#unsaved').hidden = !this.history.dirty;
        $('#undo').disabled = !this.history.undoStack.length;
        $('#redo').disabled = !this.history.redoStack.length;
        $('#page-number').value = this.activeIndex + 1;
        $('#page-number').max = this.state.pages.length;
        $('#page-total').textContent = `/ ${this.state.pages.length}`;
        $('#rail-count').textContent = this.state.pages.length;
        $('#breadcrumb').textContent = this.state.metadata.title || this.state.name;
        const size = displaySize(this.page);
        $('#page-dimensions').textContent = `${Math.round(size.w)} × ${Math.round(size.h)} pt`;
        $('.status-engine').title = `${this.renderer.name}; ${this.gpu.mode}. ${this.gpuReason || ''}`;
        this.highlightActive();
    }
    renderTools(filter = '') {
        const groups = toolGroups[this.tab] ?? toolGroups.all;
        $('#tools-heading').textContent = { all: 'All tools', edit: 'Edit a PDF', convert: 'Export & convert', sign: 'Fill & sign', organize: 'Organize pages' }[this.tab];
        let html = '';
        for (const [label, rows] of groups) {
            const visible = rows.filter(r => r[0].toLowerCase().includes(filter.toLowerCase()));
            if (!visible.length)
                continue;
            html += `<div class="tool-group-title">${label}</div>`;
            for (const [text, ico, command, bg, col] of visible) {
                const [kind, value] = command.split(':');
                html += `<button class="tool-row ${kind === 'tool' && this.tool === value ? 'active' : ''}" data-${kind}="${value}" style="--tool-bg:${bg || '#edf3fc'};--tool-color:${col || '#6d8ec0'}"><span>${icon(ico)}</span><span class="tool-label">${text}</span>${kind === 'tab' ? '<span class="chevron">›</span>' : ''}</button>`;
            }
        }
        $('#tools-list').innerHTML = html || '<p class="empty-caption">No matching tools.</p>';
    }
    setTab(tab) {
        this.tab = tab;
        $$('.tab').forEach(el => {
            el.classList.toggle('active', el.dataset.tab === tab);
            el.setAttribute('aria-selected', String(el.dataset.tab === tab));
        });
        $('#tool-filter').value = '';
        this.renderTools();
        if (tab === 'organize')
            this.openOrganizer();
        else if (this.organizing)
            this.closeOrganizer();
        if (tab === 'edit') {
            this.rightTab = 'properties';
            this.renderRight();
        }
        if (tab === 'sign')
            this.showForms = true;
    }
    setTool(tool) {
        this.tool = tool;
        this.draft = null;
        this.gesture = null;
        for (const p of this.state.pages) {
            const v = this.views.get(p.id);
            if (v) {
                v.paper.classList.toggle('drawing', !['select', 'hand'].includes(tool));
                v.paper.classList.toggle('hand', tool === 'hand');
                v.formLayer.style.pointerEvents = ['select'].includes(tool) ? '' : 'none';
            }
        }
        $$('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
        this.renderTools($('#tool-filter').value);
        $('#status-text').textContent = `${toolNames[tool] || tool} · ${tool === 'select' ? 'Double-click added text to edit it' : tool === 'redact' ? 'Draw a region, then apply redactions to export safely' : tool === 'crop' ? 'Drag the visible area to keep' : 'Click or drag on a page'}`;
        if (tool === 'redact') {
            this.rightTab = 'properties';
            this.renderRight();
        }
        this.selected = tool === 'select' ? this.selected : null;
        this.renderOverlay(this.page.id);
    }
    buildPages() {
        const host = $('#pages-host');
        this.observer?.disconnect();
        host.replaceChildren();
        for (const v of this.views.values())
            v.abort?.abort();
        this.views.clear();
        for (const [pindex, p] of this.state.pages.entries()) {
            const paper = document.createElement('div');
            paper.className = 'paper' + (!['select', 'hand'].includes(this.tool) ? ' drawing' : this.tool === 'hand' ? ' hand' : '');
            paper.dataset.pageId = p.id;
            paper.dataset.index = pindex;
            paper.setAttribute('role', 'group');
            paper.setAttribute('aria-label', `Page ${pindex + 1}`);
            const surface = document.createElement('div');
            surface.className = 'surface';
            const canvas = document.createElement('canvas');
            canvas.className = 'base-canvas';
            const text = document.createElement('div');
            text.className = 'text-layer';
            const svg = document.createElementNS(svgNS, 'svg');
            svg.classList.add('annotation-layer');
            const formLayer = document.createElement('div');
            formLayer.className = 'form-layer';
            surface.append(canvas, text, svg, formLayer);
            const loading = document.createElement('div');
            loading.className = 'render-loading';
            loading.innerHTML = '<span class="spinner"></span>Rendering page';
            paper.append(surface, loading);
            host.append(paper);
            const v = { paper, surface, canvas, text, svg, formLayer, result: null, loading: false, pindex, renderKey: null };
            this.views.set(p.id, v);
            this.layoutPage(p, v);
            paper.addEventListener('pointerdown', e => this.pointerDown(e, p.id));
            paper.addEventListener('pointermove', e => this.pointerMove(e, p.id));
            paper.addEventListener('pointerup', e => this.pointerUp(e, p.id));
            paper.addEventListener('pointercancel', () => this.cancelGesture());
            paper.addEventListener('dblclick', e => this.doubleClick(e, p.id));
            paper.addEventListener('contextmenu', e => {
                const group = e.target.closest?.('[data-annotation]');
                if (group) {
                    e.preventDefault();
                    this.select(group.dataset.annotation, p.id);
                    this.rightTab = 'properties';
                    this.renderRight();
                }
            });
        }
        this.observer = new IntersectionObserver(entries => {
            for (const e of entries) {
                const v = this.views.get(e.target.dataset.pageId);
                if (!v)
                    continue;
                v.visible = e.isIntersecting;
                if (e.isIntersecting)
                    this.ensurePage(e.target.dataset.pageId).catch(err => this.pageError(e.target.dataset.pageId, err));
                else if (v.result && Math.abs(v.pindex - this.activeIndex) > 3) {
                    v.canvas.width = v.canvas.height = 1;
                    v.result = null;
                    v.paper.classList.remove('ready');
                    v.text.replaceChildren();
                }
            }
            this.updateGpu();
        }, { root: $('#scroller'), rootMargin: '500px 0px' });
        for (const v of this.views.values())
            this.observer.observe(v.paper);
        requestAnimationFrame(() => this.updateGpu());
    }
    layoutPage(p, v) {
        const c = cropBox(p), size = displaySize(p), z = this.zoom;
        v.paper.style.width = `${size.w * z}px`;
        v.paper.style.height = `${size.h * z}px`;
        v.surface.style.width = `${c.w * z}px`;
        v.surface.style.height = `${c.h * z}px`;
        v.surface.style.left = `${p.rotation === 90 ? c.h * z : p.rotation === 180 ? c.w * z : 0}px`;
        v.surface.style.top = `${p.rotation === 180 ? c.h * z : p.rotation === 270 ? c.w * z : 0}px`;
        v.surface.style.transform = `rotate(${p.rotation}deg)`;
        v.svg.setAttribute('viewBox', `${c.x} ${c.y} ${c.w} ${c.h}`);
        v.svg.setAttribute('preserveAspectRatio', 'none');
    }
    async getRendered(p, scale) {
        const key = `${this.renderer.name}:${p.sourceId}:${p.sourcePage}:${scale}`;
        const hit = this.cache.get(key);
        if (hit)
            return hit;
        if (this.cachePending.has(key))
            return this.cachePending.get(key);
        const promise = this.pool.run(async () => {
            let out;
            if (p.sourceId)
                out = await this.renderer.render(this.sources.get(p.sourceId), p.sourcePage, scale);
            else {
                const canvas = document.createElement('canvas');
                canvas.width = Math.ceil(p.width * scale);
                canvas.height = Math.ceil(p.height * scale);
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                out = { canvas, text: [], scale, width: p.width, height: p.height, warnings: [] };
            }
            this.cache.set(key, out, out.canvas.width * out.canvas.height * 4);
            return out;
        }, scale > .2 ? 10 : 0);
        this.cachePending.set(key, promise);
        try {
            return await promise;
        }
        finally {
            this.cachePending.delete(key);
        }
    }
    async ensurePage(id) {
        const p = this.state.pages.find(p => p.id === id), v = this.views.get(id);
        if (!p || !v || v.loading)
            return;
        const scale = Math.min(3, Math.max(.5, Math.ceil(this.zoom * Math.min(devicePixelRatio || 1, 2) * 2) / 2)), key = `${this.revision}:${this.renderer.name}:${p.sourceId}:${p.sourcePage}:${scale}:${JSON.stringify(p.crop)}`;
        if (v.result && v.renderKey === key)
            return;
        v.loading = true;
        const epoch = this.revision;
        try {
            const result = await this.getRendered(p, scale);
            if (epoch !== this.revision || this.views.get(id) !== v)
                return;
            const c = cropBox(p);
            v.canvas.width = Math.max(1, Math.ceil(c.w * result.scale));
            v.canvas.height = Math.max(1, Math.ceil(c.h * result.scale));
            v.canvas.getContext('2d').drawImage(result.canvas, c.x * result.scale, c.y * result.scale, c.w * result.scale, c.h * result.scale, 0, 0, v.canvas.width, v.canvas.height);
            v.result = result;
            v.renderKey = key;
            v.paper.classList.add('ready');
            v.paper.querySelector('.render-error')?.remove();
            this.texts.set(id, result.text);
            this.renderText(p, v);
            if (p.sourceId && !this.widgets.has(id))
                this.widgets.set(id, await getWidgets(this.sources.get(p.sourceId), p.sourcePage));
            this.renderOverlay(id);
            this.renderForms(p, v);
            if (result.warnings.length && id === this.page.id)
                $('#status-text').textContent = `Rendered with ${result.warnings.length} compatibility note(s) · Engine details`;
            this.updateGpu();
        }
        catch (error) {
            this.pageError(id, error);
        }
        finally {
            v.loading = false;
        }
    }
    pageError(id, error) {
        const v = this.views.get(id);
        if (!v)
            return;
        v.paper.classList.remove('ready');
        v.result = null;
        v.paper.querySelector('.render-error')?.remove();
        const el = document.createElement('div');
        el.className = 'render-error';
        el.innerHTML = `${icon('info')}<h3>This page needs the compatibility engine.</h3><p>${escapeHTML(error.message)}</p><button class="primary" data-action="compatibility">Load PDF.js renderer</button><p>Requires an internet connection. Your document is processed locally.</p>`;
        v.paper.append(el);
        console.warn('Page renderer:', error.message);
        this.updateGpu();
    }
    renderText(p, v) {
        v.text.replaceChildren();
        const c = cropBox(p), ctx = document.createElement('canvas').getContext('2d');
        for (const t of (v.result?.text ?? [])) {
            if (!t.text || t.y + t.h < c.y || t.y > c.y + c.h)
                continue;
            const span = document.createElement('span');
            span.textContent = t.text;
            const size = t.h * this.zoom;
            span.style.left = `${(t.x - c.x) * this.zoom}px`;
            span.style.top = `${(t.y - c.y) * this.zoom}px`;
            span.style.fontSize = `${size}px`;
            ctx.font = `${size}px Arial`;
            const natural = ctx.measureText(t.text).width;
            span.style.transform = `rotate(${t.angle || 0}rad) scaleX(${natural > 0 ? t.w * this.zoom / natural : 1})`;
            v.text.append(span);
        }
    }
    annotationSVG(a, selected = false) {
        const e = escapeHTML, color = a.color || '#2759a1', sw = a.strokeWidth || 2, opacity = a.opacity ?? 1;
        let shape = '';
        if (['text', 'signature', 'stamp', 'field', 'check'].includes(a.type)) {
            if (a.type === 'field')
                shape += `<rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="#fff" stroke="#9aafd0" stroke-width="1"/>`;
            if (a.type === 'check')
                shape += `<rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="#fff" stroke="#8da4c6" stroke-width="1"/>`;
            if (a.type === 'stamp')
                shape += `<rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" rx="2" fill="none" stroke="${color}" stroke-width="${sw}"/>`;
            const size = a.fontSize || 16, lines = a.type === 'check' ? (a.checked ? ['X'] : []) : String(a.text || '').split('\n');
            shape += `<text fill="${color}" font-family="${a.type === 'signature' ? 'Georgia,serif' : 'Arial,sans-serif'}" font-style="${a.type === 'signature' ? 'italic' : 'normal'}" font-weight="${a.bold ? '700' : '400'}" font-size="${size}" xml:space="preserve">${lines.map((l, i) => `<tspan x="${a.x + (a.type === 'stamp' ? 8 : 0)}" y="${a.y + (a.type === 'stamp' ? a.h * .65 : size) + i * size * 1.25}">${e(l)}</tspan>`).join('')}</text><rect x="${a.x}" y="${a.y}" width="${Math.max(12, a.w)}" height="${Math.max(12, a.h)}" fill="transparent" stroke="none"/>`;
        }
        else if (a.type === 'note') {
            shape = `<rect x="${a.x}" y="${a.y}" width="24" height="24" rx="4" fill="${a.resolved ? '#cde9dc' : '#ffe39a'}" stroke="${a.resolved ? '#83ad9a' : '#d1ae61'}" stroke-width=".8"/><path d="M${a.x + 6} ${a.y + 8}h12m-12 4h12m-12 4h7" fill="none" stroke="${a.resolved ? '#558d70' : '#b38d45'}" stroke-width="1.3"/>`;
        }
        else if (a.type === 'image')
            shape = `<image href="${e(a.data)}" x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" preserveAspectRatio="none"/>`;
        else if (a.type === 'highlight')
            shape = `<rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="${color}" fill-opacity=".3" style="mix-blend-mode:multiply"/>`;
        else if (a.type === 'redact')
            shape = `<rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="#323945" fill-opacity=".8" stroke="#d8645e" stroke-width="1.2" stroke-dasharray="4 3"/>${a.w > 55 && a.h > 15 ? `<text x="${a.x + 5}" y="${a.y + Math.min(15, a.h - 3)}" font-family="Arial" font-size="9" fill="white">REDACT</text>` : ''}`;
        else if (a.type === 'rect')
            shape = `<rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="${a.fill || 'none'}" stroke="${color}" stroke-width="${sw}"/>`;
        else if (a.type === 'ellipse')
            shape = `<ellipse cx="${a.x + a.w / 2}" cy="${a.y + a.h / 2}" rx="${Math.max(.1, a.w / 2)}" ry="${Math.max(.1, a.h / 2)}" fill="none" stroke="${color}" stroke-width="${sw}"/>`;
        else if (a.type === 'ink' || a.type === 'line')
            shape = `<polyline points="${(a.points ?? [[a.x, a.y], [a.x + a.w, a.y + a.h]]).map(p => p.join(',')).join(' ')}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
        let out = `<g class="annotation" data-annotation="${e(a.id)}" opacity="${opacity}">${shape}</g>`;
        if (selected) {
            const h = 7 / this.zoom;
            out += `<rect x="${a.x - 2}" y="${a.y - 2}" width="${Math.max(a.w, 4) + 4}" height="${Math.max(a.h, 4) + 4}" fill="none" stroke="#4181ef" stroke-width="1" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/><rect class="resize-handle" data-handle="${e(a.id)}" x="${a.x + a.w - h / 2}" y="${a.y + a.h - h / 2}" width="${h}" height="${h}" rx="1" fill="white" stroke="#4181ef" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
        }
        return out;
    }
    renderOverlay(id) {
        const p = this.state.pages.find(p => p.id === id), v = this.views.get(id);
        if (!p || !v)
            return;
        let html = '';
        for (const [rindex, r] of this.search.results.entries())
            if (r.pageId === id)
                html += `<rect class="search-hit ${rindex === this.search.index ? 'current' : ''}" x="${r.item.x}" y="${r.item.y}" width="${Math.max(4, r.item.w)}" height="${r.item.h}"/>`;
        for (const a of p.annotations) {
            const displayed = this.draft?.pageId === id && this.draft.editId === a.id ? this.draft.annotation : a;
            html += this.annotationSVG(displayed, this.selected === a.id && this.tool === 'select');
        }
        if (this.draft?.pageId === id && !this.draft.editId) {
            if (this.draft.crop) {
                const a = this.draft.annotation;
                html += `<rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="#5a8ddc" fill-opacity=".12" stroke="#286ee0" stroke-width="1" stroke-dasharray="5 3"/>`;
            }
            else
                html += this.annotationSVG(this.draft.annotation);
        }
        v.svg.innerHTML = html;
        if (v.result)
            this.renderForms(p, v);
    }
    renderForms(p, v) {
        v.formLayer.replaceChildren();
        const crop = cropBox(p), native = this.widgets.get(p.id) ?? [];
        for (const w of native) {
            if (!['Tx', 'Btn'].includes(w.type) || (w.flags & 1) || (w.type === 'Btn' && (w.flags & (32768 | 65536))))
                continue;
            const value = this.state.fieldValues[`${p.sourceId}:${w.name}`] ?? w.value;
            const input = document.createElement('input');
            input.type = w.type === 'Btn' ? 'checkbox' : 'text';
            if (input.type === 'checkbox')
                input.checked = !!value;
            else
                input.value = String(value ?? '');
            input.title = w.name;
            input.setAttribute('aria-label', w.name);
            input.style.left = `${(w.x - crop.x) * this.zoom}px`;
            input.style.top = `${(w.y - crop.y) * this.zoom}px`;
            input.style.width = `${w.w * this.zoom}px`;
            input.style.height = `${w.h * this.zoom}px`;
            input.style.fontSize = `${Math.min(12, w.h * .6) * this.zoom}px`;
            input.addEventListener('pointerdown', e => e.stopPropagation());
            input.addEventListener('change', () => this.history.transact(`Fill ${w.name}`, s => s.fieldValues[`${p.sourceId}:${w.name}`] = input.type === 'checkbox' ? input.checked : input.value));
            v.formLayer.append(input);
        }
        for (const a of p.annotations.filter(a => a.type === 'field' || a.type === 'check')) {
            const input = document.createElement('input');
            input.type = a.type === 'check' ? 'checkbox' : 'text';
            if (a.type === 'check')
                input.checked = !!a.checked;
            else
                input.value = a.text ?? '';
            input.title = a.name || 'New field';
            input.setAttribute('aria-label', a.name || 'New field');
            input.style.left = `${(a.x - crop.x) * this.zoom}px`;
            input.style.top = `${(a.y - crop.y) * this.zoom}px`;
            input.style.width = `${a.w * this.zoom}px`;
            input.style.height = `${a.h * this.zoom}px`;
            input.style.fontSize = `${(a.fontSize || 12) * this.zoom}px`;
            input.addEventListener('pointerdown', e => e.stopPropagation());
            input.addEventListener('change', () => this.history.transact('Fill new field', s => {
                const x = s.pages.find(p2 => p2.id === p.id).annotations.find(x => x.id === a.id);
                if (a.type === 'check')
                    x.checked = input.checked;
                else
                    x.text = input.value;
            }));
            input.addEventListener('dblclick', e => {
                e.stopPropagation();
                this.select(a.id, p.id);
                this.rightTab = 'properties';
                this.renderRight();
            });
            v.formLayer.append(input);
        }
        v.formLayer.style.display = ['select'].includes(this.tool) ? '' : 'none';
    }
    updateGpu() {
        if (!this.views || !this.gpu)
            return;
        const wrap = $('#viewer-wrap');
        if (!wrap || wrap.hidden)
            return;
        const rect = wrap.getBoundingClientRect(), draws = [];
        for (const [id, v] of this.views) {
            if (!v.result || !v.canvas.width)
                continue;
            const p = this.state.pages.find(p => p.id === id);
            if (!p)
                continue;
            const r = v.paper.getBoundingClientRect();
            draws.push({ key: v.renderKey, canvas: v.canvas, x: r.left - rect.left, y: r.top - rect.top, w: r.width, h: r.height, rotation: p.rotation });
        }
        this.gpu.setScene(draws, wrap.clientWidth, wrap.clientHeight);
    }
    setZoom(z, anchor = null, keepFit = false) {
        if (!keepFit)
            this.fitMode = null;
        const scroller = $('#scroller'), old = this.zoom;
        z = clamp(z, .25, 4);
        if (Math.abs(z - old) < .001)
            return;
        const cx = anchor?.x ?? scroller.clientWidth / 2, cy = anchor?.y ?? scroller.clientHeight / 2, wx = (scroller.scrollLeft + cx) / old, wy = (scroller.scrollTop + cy) / old;
        this.zoom = z;
        for (const p of this.state.pages) {
            const v = this.views.get(p.id);
            this.layoutPage(p, v);
            if (v.result)
                this.renderText(p, v);
            this.renderOverlay(p.id);
        }
        scroller.scrollLeft = wx * z - cx;
        scroller.scrollTop = wy * z - cy;
        $('#zoom-range').value = Math.round(z * 100);
        $('#zoom-label').textContent = `${Math.round(z * 100)}%`;
        clearTimeout(this.zoomRenderTimer);
        this.zoomRenderTimer = setTimeout(() => {
            for (const [id, v] of this.views)
                if (v.visible)
                    this.ensurePage(id);
        }, 160);
        this.updateGpu();
    }
    fit(mode = 'page') {
        if (!this.page)
            return;
        this.fitMode = mode;
        const size = displaySize(this.page), wrap = $('#viewer-wrap'), w = wrap.clientWidth - 105, h = wrap.clientHeight - 63;
        if (w < 100 || h < 100)
            return;
        this.setZoom(mode === 'width' ? w / size.w : Math.min(w / size.w, h / size.h), null, true);
        this.goTo(this.activeIndex, false);
    }
    goTo(index, smooth = true) {
        this.activeIndex = clamp(index, 0, this.state.pages.length - 1);
        const v = this.views.get(this.page.id);
        if (v) {
            const scroller = $('#scroller');
            scroller.scrollTo({ top: v.paper.offsetTop - 25, behavior: smooth ? 'smooth' : 'auto' });
            this.ensurePage(this.page.id);
        }
        this.syncChrome();
        this.renderRight();
    }
    highlightActive() {
        $$('.thumb').forEach(t => t.classList.toggle('active', t.dataset.pageId === this.page?.id));
        $$('.page-card').forEach(t => t.classList.toggle('active', t.dataset.pageId === this.page?.id));
    }
    buildThumbnails() {
        $('#thumbnails').innerHTML = this.state.pages.map((p, i) => `<button class="thumb ${i === this.activeIndex ? 'active' : ''}" data-page-id="${p.id}" data-go-page="${i}" title="Page ${i + 1}"><span class="thumb-paper"></span><span class="thumb-label">${i + 1}</span>${p.annotations.length ? `<span class="thumb-badge">${p.annotations.length}</span>` : ''}</button>`).join('');
        const epoch = this.revision;
        for (const p of this.state.pages.slice(0, 200)) {
            this.updateThumbnail(p).catch(error => console.warn('Thumbnail:', error.message));
        }
        if (this.state.pages.length > 200)
            toast('The thumbnail rail shows placeholders after page 200 to bound memory.');
        this.loadBookmarks().catch(() => {
        });
    }
    async updateThumbnail(p) {
        const epoch = this.revision;
        let canvas;
        try {
            const result = await this.getRendered(p, .2), copy = document.createElement('canvas');
            copy.width = result.canvas.width;
            copy.height = result.canvas.height;
            const ctx = copy.getContext('2d');
            ctx.drawImage(result.canvas, 0, 0);
            ctx.scale(result.scale, result.scale);
            await drawAnnotations(ctx, p);
            const c = cropBox(p), s = result.scale, rot = p.rotation;
            canvas = document.createElement('canvas');
            canvas.width = Math.ceil((rot % 180 ? c.h : c.w) * s);
            canvas.height = Math.ceil((rot % 180 ? c.w : c.h) * s);
            const out = canvas.getContext('2d');
            if (rot === 90) {
                out.translate(canvas.width, 0);
                out.rotate(Math.PI / 2);
            }
            if (rot === 180) {
                out.translate(canvas.width, canvas.height);
                out.rotate(Math.PI);
            }
            if (rot === 270) {
                out.translate(0, canvas.height);
                out.rotate(-Math.PI / 2);
            }
            out.drawImage(copy, c.x * s, c.y * s, c.w * s, c.h * s, 0, 0, c.w * s, c.h * s);
        }
        catch (error) {
            canvas = document.createElement('canvas');
            canvas.width = 122;
            canvas.height = 158;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, 122, 158);
            ctx.fillStyle = '#a2afc1';
            ctx.font = '11px Arial';
            ctx.fillText('PDF', 47, 77);
        }
        if (epoch !== this.revision)
            return;
        this.thumbs.set(p.id, canvas);
        for (const el of $$(`[data-page-id="${p.id}"] .thumb-paper,[data-page-id="${p.id}"] .card-preview`)) {
            const c = document.createElement('canvas');
            c.width = canvas.width;
            c.height = canvas.height;
            c.getContext('2d').drawImage(canvas, 0, 0);
            el.replaceChildren(c);
        }
    }
    async loadBookmarks() {
        const first = this.state.pages.find(p => p.sourceId);
        if (!first) {
            $('#bookmarks').innerHTML = '<p class="empty-caption">This document has no bookmarks.</p>';
            return;
        }
        const source = this.sources.get(first.sourceId), out = await source.outline();
        $('#bookmarks').innerHTML = out.length ? out.map(b => {
            const i = this.state.pages.findIndex(p => p.sourceId === first.sourceId && p.sourcePage === b.page);
            return `<button data-go-page="${Math.max(0, i)}">${icon('bookmark')}${escapeHTML(b.title)}</button>`;
        }).join('') : '<p class="empty-caption">This document has no bookmarks.</p>';
    }
    renderRight() {
        $$('.right-tabs [data-right]').forEach(b => b.classList.toggle('active', b.dataset.right === this.rightTab));
        const notes = this.state.pages.flatMap((p, i) => p.annotations.filter(a => a.type === 'note').map(a => ({ p, i, a })));
        $('#comment-count').textContent = notes.length;
        const el = $('#right-content');
        if (this.rightTab === 'comments') {
            el.innerHTML = `<div class="review-toolbar"><span>${notes.filter(n => !n.a.resolved).length} open comment${notes.length === 1 ? '' : 's'}</span><button class="secondary small" data-tool="note">${icon('plus')}Add comment</button></div>` + (notes.length ? notes.map(({ p, i, a }) => `<article class="comment-card ${a.id === this.selected ? 'selected' : ''}" data-select-note="${a.id}" data-page-id="${p.id}"><div class="comment-author"><span class="comment-avatar">${escapeHTML((a.author || 'You').split(' ').map(s => s[0]).join('').slice(0, 2))}</span><span>${escapeHTML(a.author || 'You')}</span><span class="comment-date">${a.resolved ? 'Resolved' : 'Review'}</span></div><p>${escapeHTML(a.text)}</p><div class="comment-bottom"><span class="comment-page">Page ${i + 1}</span><button class="text-button" data-resolve-note="${a.id}">${a.resolved ? 'Reopen' : 'Resolve'}</button><button class="plain" data-edit-note="${a.id}" title="Edit comment" aria-label="Edit comment">${icon('edit')}</button><button class="plain" data-delete-note="${a.id}" title="Delete comment" aria-label="Delete comment">${icon('trash')}</button></div></article>`).join('') : `<div class="review-empty"><div class="empty-icon">${icon('comment')}</div><h3>A little feedback goes a long way.</h3><p>Add a comment anywhere on the page.<br>Keep the conversation close to the work.</p></div>`) + `<div class="review-hint"><strong>Keep everyone on the same page.</strong>Comments are saved in your Folio project and exported as PDF note annotations. This is a local review, not a shared cloud session.</div>`;
            return;
        }
        const sel = this.selection;
        if (sel) {
            const a = sel.annotation;
            el.innerHTML = `<div class="property-section"><h3>${escapeHTML(toolNames[a.type] || a.type)} properties</h3><div class="property-grid">${['x', 'y', 'w', 'h'].map(k => `<label>${{ x: 'X', y: 'Y', w: 'Width', h: 'Height' }[k]} · pt<input data-property="${k}" type="number" value="${Math.round(a[k] * 10) / 10}" step="1" ${k === 'w' || k === 'h' ? 'min="1"' : ''}></label>`).join('')}</div></div><div class="property-section"><h3>Appearance</h3><div class="property-grid"><label>Color<input type="color" data-property="color" value="${a.color || this.defaultColor}" style="height:33px"></label><label>Opacity<input type="number" data-property="opacity" min="0.05" max="1" step=".05" value="${a.opacity ?? 1}"></label>${['text', 'signature', 'stamp', 'field', 'check'].includes(a.type) ? `<label>Font size<input type="number" data-property="fontSize" min="4" max="240" value="${a.fontSize || 16}"></label><label>Weight<select data-property="bold"><option value="false">Regular</option><option value="true" ${a.bold ? 'selected' : ''}>Bold</option></select></label>` : `<label>Stroke width<input type="number" data-property="strokeWidth" min=".2" max="50" step=".5" value="${a.strokeWidth || 2}"></label>`}</div><div class="color-row" style="margin-top:14px">${['#2759a1', '#e06e56', '#e6b746', '#6d9f88', '#263449'].map(c => `<button class="color-swatch" data-set-color="${c}" style="--swatch:${c}" title="${c}" aria-label="Set color ${c}"></button>`).join('')}</div></div>${a.text !== undefined ? `<label class="property-field">${a.type === 'note' ? 'Comment' : 'Content'}<textarea data-property="text">${escapeHTML(a.text)}</textarea></label>` : ''}${a.type === 'field' || a.type === 'check' ? `<label class="property-field">Field name<input data-property="name" value="${escapeHTML(a.name || 'Field')}"></label>` : ''}<div class="property-grid"><button class="secondary small" data-action="duplicate-object">${icon('copy')}Duplicate</button><button class="secondary small danger" data-action="delete-object">${icon('trash')}Delete</button><button class="secondary small" data-action="bring-front">${icon('front')}Front</button><button class="secondary small" data-action="send-back">${icon('back')}Back</button></div>`;
        }
        else {
            const p = this.page, size = displaySize(p), source = p.sourceId ? this.sources.get(p.sourceId) : null;
            el.innerHTML = `<div class="property-section"><h3>Document overview</h3><div style="display:flex;gap:12px;align-items:center;margin-bottom:17px"><span style="color:#d0796b;background:#fff3ef;padding:12px;border-radius:9px">${icon('file')}</span><div style="font-size:11px;line-height:1.7;overflow:hidden"><strong>${escapeHTML(this.state.metadata.title || this.state.name)}</strong><div style="font-size:9px;color:#97a4b7">${source ? formatBytes(source.bytes.length) : 'New document'} · ${this.state.pages.length} pages</div></div></div><dl class="doc-info"><dt>Author</dt><dd>${escapeHTML(this.state.metadata.author || 'Not specified')}</dd><dt>Page size</dt><dd>${Math.round(size.w)} × ${Math.round(size.h)} pt</dd><dt>Rotation</dt><dd>${p.rotation}°</dd><dt>Renderer</dt><dd>${escapeHTML(this.renderer.name)}</dd><dt>Compositor</dt><dd>${this.gpu.mode}</dd></dl><button class="text-button" data-action="properties">Document properties ${icon('chevron')}</button></div><div class="property-section"><h3>Page ${this.activeIndex + 1}</h3><div class="property-grid"><button class="secondary small" data-action="rotate">${icon('rotate')}Rotate</button><button class="secondary small" data-tool="crop">${icon('crop')}Crop</button><button class="secondary small" data-action="duplicate-page">${icon('copy')}Duplicate</button><button class="secondary small" data-action="reset-crop">${icon('fit')}Reset crop</button></div></div><div class="property-section"><h3>Default style</h3><div class="property-grid"><label>Text color<input id="default-color" type="color" style="height:33px" value="${this.defaultColor}"></label><label>Font size<input id="default-size" type="number" min="4" max="240" value="${this.defaultFontSize}"></label></div></div><div class="review-hint"><strong>Made to be edited.</strong>Select an added object to change its size, position, style, or content. Imported PDF text is selectable; this version does not reflow or rewrite original text runs.</div>`;
        }
        const pending = this.state.pages.reduce((n, p) => n + p.annotations.filter(a => a.type === 'redact').length, 0);
        if (pending)
            el.insertAdjacentHTML('beforeend', `<div class="dialog-warning" style="margin-top:18px"><strong>${pending} pending redaction${pending === 1 ? '' : 's'}</strong><br>Marks are previews. The source PDF and editable project still contain the original content.</div><button class="primary full-width" data-action="apply-redactions">Apply redactions & export</button>`);
    }
    select(id, pageId) {
        this.selected = id;
        const i = this.state.pages.findIndex(p => p.id === pageId);
        if (i >= 0)
            this.activeIndex = i;
        for (const p of this.state.pages)
            this.renderOverlay(p.id);
        this.renderRight();
        this.syncChrome();
    }
    screenPoint(x, y, p) {
        const rect = this.views.get(p.id).paper.getBoundingClientRect(), c = cropBox(p), sx = (x - rect.left) / this.zoom, sy = (y - rect.top) / this.zoom;
        let px = sx, py = sy;
        if (p.rotation === 90) {
            px = sy;
            py = c.h - sx;
        }
        else if (p.rotation === 180) {
            px = c.w - sx;
            py = c.h - sy;
        }
        else if (p.rotation === 270) {
            px = c.w - sy;
            py = sx;
        }
        return { x: px + c.x, y: py + c.y };
    }
    eventPoint(e, p) {
        const point = this.screenPoint(e.clientX, e.clientY, p), c = cropBox(p);
        return { x: clamp(point.x, c.x, c.x + c.w), y: clamp(point.y, c.y, c.y + c.h) };
    }
    pointerDown(e, id) {
        if (this.loading || e.button !== 0 || e.target.closest('input,button,textarea'))
            return;
        const p = this.state.pages.find(p => p.id === id);
        if (!p)
            return;
        this.activeIndex = this.state.pages.indexOf(p);
        this.syncChrome();
        const point = this.eventPoint(e, p), paper = this.views.get(id).paper;
        if (this.tool === 'hand' || this.spaceDown) {
            e.preventDefault();
            this.gesture = { kind: 'pan', pageId: id, pointerId: e.pointerId, x: e.clientX, y: e.clientY, scrollTop: $('#scroller').scrollTop, scrollLeft: $('#scroller').scrollLeft };
            paper.setPointerCapture(e.pointerId);
            return;
        }
        if (this.tool === 'select') {
            const handle = e.target.closest('[data-handle]'), group = e.target.closest('[data-annotation]');
            if (handle || group) {
                e.preventDefault();
                const aid = handle?.dataset.handle || group.dataset.annotation, a = p.annotations.find(a => a.id === aid);
                if (!a)
                    return;
                this.select(aid, id);
                this.gesture = { kind: handle ? 'resize' : 'move', pageId: id, pointerId: e.pointerId, start: point, original: clone(a), moved: false };
                paper.setPointerCapture(e.pointerId);
            }
            else {
                const old = this.selected;
                this.selected = null;
                if (old)
                    for (const pg of this.state.pages)
                        this.renderOverlay(pg.id);
                this.renderRight();
            }
            return;
        }
        e.preventDefault();
        window.getSelection()?.removeAllRanges();
        if (['text', 'note', 'signature', 'image', 'stamp', 'check', 'field', 'checkbox'].includes(this.tool)) {
            this.placeAt(this.tool, point, p).catch(e => this.error(e));
            return;
        }
        const a = { id: uid(), type: this.tool === 'crop' ? 'rect' : this.tool, x: point.x, y: point.y, w: 0, h: 0, color: this.tool === 'highlight' ? '#ffd34e' : this.tool === 'redact' ? '#27313d' : this.defaultColor, strokeWidth: this.defaultStroke, opacity: 1 };
        if (['ink', 'line'].includes(this.tool))
            a.points = [[point.x, point.y]];
        this.gesture = { kind: 'draw', tool: this.tool, pageId: id, pointerId: e.pointerId, start: point, original: a };
        this.draft = { pageId: id, annotation: clone(a), crop: this.tool === 'crop' };
        paper.setPointerCapture(e.pointerId);
        this.renderOverlay(id);
    }
    pointerMove(e, id) {
        const g = this.gesture;
        if (!g || g.pageId !== id || g.pointerId !== e.pointerId)
            return;
        if (g.kind === 'pan') {
            $('#scroller').scrollTop = g.scrollTop - (e.clientY - g.y);
            $('#scroller').scrollLeft = g.scrollLeft - (e.clientX - g.x);
            return;
        }
        const p = this.state.pages.find(p => p.id === id);
        if (!p)
            return;
        const point = this.eventPoint(e, p), dx = point.x - g.start.x, dy = point.y - g.start.y;
        g.moved = Math.hypot(dx, dy) > 1;
        if (g.kind === 'move') {
            const a = clone(g.original);
            a.x += dx;
            a.y += dy;
            if (a.points)
                a.points = a.points.map(([x, y]) => [x + dx, y + dy]);
            this.draft = { pageId: id, editId: a.id, annotation: a };
        }
        else if (g.kind === 'resize') {
            const a = clone(g.original), ow = a.w || 1, oh = a.h || 1;
            a.w = Math.max(4, a.w + dx);
            a.h = Math.max(4, a.h + dy);
            if (e.shiftKey)
                a.h = a.w * oh / ow;
            if (a.points)
                a.points = a.points.map(([x, y]) => [a.x + (x - a.x) * a.w / ow, a.y + (y - a.y) * a.h / oh]);
            this.draft = { pageId: id, editId: a.id, annotation: a };
        }
        else {
            const a = this.draft.annotation;
            if (g.tool === 'ink') {
                const events = e.getCoalescedEvents?.() || [e];
                for (const ev of events) {
                    const pt = this.eventPoint(ev, p), prev = a.points.at(-1);
                    if (!prev || Math.hypot(pt.x - prev[0], pt.y - prev[1]) > .6)
                        a.points.push([pt.x, pt.y]);
                }
                const xs = a.points.map(p => p[0]), ys = a.points.map(p => p[1]);
                a.x = Math.min(...xs);
                a.y = Math.min(...ys);
                a.w = Math.max(...xs) - a.x;
                a.h = Math.max(...ys) - a.y;
            }
            else {
                let end = point;
                if (e.shiftKey && g.tool !== 'line') {
                    const m = Math.max(Math.abs(dx), Math.abs(dy));
                    end = { x: g.start.x + Math.sign(dx) * m, y: g.start.y + Math.sign(dy) * m };
                }
                Object.assign(a, rectFromPoints(g.start, end));
                if (g.tool === 'line') {
                    let x = point.x, y = point.y;
                    if (e.shiftKey) {
                        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), dist = Math.hypot(dx, dy);
                        x = g.start.x + Math.cos(angle) * dist;
                        y = g.start.y + Math.sin(angle) * dist;
                    }
                    a.points = [[g.start.x, g.start.y], [x, y]];
                    Object.assign(a, rectFromPoints(g.start, { x, y }));
                }
            }
        }
        this.renderOverlay(id);
    }
    pointerUp(e, id) {
        const g = this.gesture;
        if (!g || g.pointerId !== e.pointerId)
            return;
        try {
            this.views.get(id)?.paper.releasePointerCapture(e.pointerId);
        }
        catch {
        }
        const draft = this.draft;
        this.gesture = null;
        this.draft = null;
        if (g.kind === 'pan')
            return;
        if (!draft) {
            this.renderOverlay(id);
            return;
        }
        const a = draft.annotation;
        if (g.kind === 'move' || g.kind === 'resize') {
            if (g.moved)
                this.history.transact(g.kind === 'move' ? 'Move object' : 'Resize object', s => {
                    const p = s.pages.find(p => p.id === id), i = p.annotations.findIndex(x => x.id === a.id);
                    p.annotations[i] = a;
                });
            else
                this.renderOverlay(id);
            return;
        }
        if (g.tool === 'crop') {
            if (a.w >= 12 && a.h >= 12) {
                this.history.transact('Crop page', s => {
                    const p = s.pages.find(p => p.id === id);
                    p.crop = { x: Math.max(0, a.x), y: Math.max(0, a.y), w: Math.min(a.w, p.width - a.x), h: Math.min(a.h, p.height - a.y) };
                });
                this.setTool('select');
                this.fit(this.fitMode);
            }
            else
                this.renderOverlay(id);
            return;
        }
        if ((g.tool === 'ink' && a.points.length >= 2) || (g.tool === 'line' && Math.hypot(a.w, a.h) > 3) || (a.w > 3 && a.h > 3)) {
            this.history.transact(`Add ${toolNames[g.tool] || g.tool}`, s => s.pages.find(p => p.id === id).annotations.push(a));
            this.selected = a.id;
            if (g.tool === 'redact') {
                this.rightTab = 'properties';
                this.renderRight();
            }
        }
        else
            this.renderOverlay(id);
    }
    cancelGesture() {
        const id = this.gesture?.pageId;
        this.gesture = null;
        this.draft = null;
        if (id)
            this.renderOverlay(id);
    }
    async placeAt(type, point, p) {
        if (type === 'text' || type === 'note') {
            const result = await this.dialog.open(type === 'note' ? 'A thought worth sharing.' : 'Add your words.', `<p class="dialog-copy">${type === 'note' ? 'Leave a note attached to this position on the page.' : 'Create an editable text object. Original PDF text and layout remain untouched.'}</p><label class="dialog-label">${type === 'note' ? 'Comment' : 'Text'}<textarea name="text" required placeholder="${type === 'note' ? 'What would you like to say?' : 'Type something here…'}"></textarea></label>${type === 'note' ? field('Your name', 'author', this.defaultAuthor) : `<div class="dialog-grid">${field('Font size · pt', 'size', this.defaultFontSize, 'number', 'min="4" max="240"')}${field('Text color', 'color', this.defaultColor, 'color')}</div>`}`, { ok: type === 'note' ? 'Add comment' : 'Add text' });
            if (!result)
                return;
            const text = String(result.get('text') || '').trim();
            if (!text)
                return;
            if (type === 'note') {
                this.defaultAuthor = String(result.get('author') || 'You');
                this.addAnnotation(p.id, { type: 'note', ...point, w: 24, h: 24, text, author: this.defaultAuthor, color: '#e5b252', date: new Date().toISOString(), resolved: false });
                this.rightTab = 'comments';
                this.showRight();
            }
            else {
                const size = clamp(Number(result.get('size')) || 16, 4, 240), c = document.createElement('canvas').getContext('2d');
                c.font = `${size}px Arial`;
                const w = Math.max(...text.split('\n').map(t => c.measureText(t).width)) + 4;
                this.addAnnotation(p.id, { type: 'text', ...point, w, h: text.split('\n').length * size * 1.25, text, fontSize: size, color: String(result.get('color') || this.defaultColor) });
            }
            this.setTool('select');
            this.renderRight();
            return;
        }
        if (type === 'image' && this.image) {
            this.addAnnotation(p.id, { type: 'image', ...point, w: Math.min(220, p.width * .5), h: Math.min(220, p.width * .5) / this.image.ratio, data: this.image.data, color: this.defaultColor });
            this.setTool('select');
            return;
        }
        if (type === 'signature' && this.signature) {
            if (this.signature.data)
                this.addAnnotation(p.id, { type: 'image', ...point, w: 200, h: 200 / this.signature.ratio, data: this.signature.data, color: '#213855', label: 'Drawn signature' });
            else
                this.addAnnotation(p.id, { type: 'signature', ...point, w: Math.max(110, this.signature.text.length * 16), h: 47, text: this.signature.text, fontSize: 33, color: '#263e65' });
            this.setTool('select');
            return;
        }
        if (type === 'stamp') {
            this.addAnnotation(p.id, { type: 'stamp', ...point, w: 164, h: 37, text: this.stampText || 'APPROVED', fontSize: 20, bold: true, color: '#548d74', strokeWidth: 2 });
            this.setTool('select');
            return;
        }
        if (type === 'check') {
            this.addAnnotation(p.id, { type: 'text', ...point, w: 17, h: 22, text: 'X', fontSize: 18, color: this.defaultColor, bold: true });
            this.setTool('select');
            return;
        }
        if (type === 'field' || type === 'checkbox') {
            const count = this.state.pages.reduce((n, p) => n + p.annotations.filter(a => ['field', 'check'].includes(a.type)).length, 0);
            this.addAnnotation(p.id, { type: type === 'field' ? 'field' : 'check', ...point, w: type === 'field' ? 170 : 18, h: type === 'field' ? 28 : 18, text: '', name: `${type === 'field' ? 'Text' : 'Checkbox'} ${count + 1}`, fontSize: 12, color: this.defaultColor, checked: false });
            this.setTool('select');
            this.rightTab = 'properties';
            this.renderRight();
            return;
        }
    }
    addAnnotation(pageId, fields) {
        const a = { id: uid(), opacity: 1, strokeWidth: 2, ...fields };
        this.selected = a.id;
        this.history.transact(`Add ${toolNames[a.type] || a.type}`, s => s.pages.find(p => p.id === pageId).annotations.push(a));
        return a;
    }
    async doubleClick(e, id) {
        const aid = e.target.closest('[data-annotation]')?.dataset.annotation;
        if (!aid || this.tool !== 'select')
            return;
        const p = this.state.pages.find(p => p.id === id), a = p.annotations.find(a => a.id === aid);
        if (!a || !['text', 'note', 'signature', 'stamp', 'field'].includes(a.type))
            return;
        e.preventDefault();
        await this.editText(aid);
    }
    async editText(id) {
        const p = this.state.pages.find(p => p.annotations.some(a => a.id === id)), a = p?.annotations.find(a => a.id === id);
        if (!a)
            return;
        const result = await this.dialog.open(a.type === 'note' ? 'Edit comment' : 'Edit text', `<label class="dialog-label">Content<textarea name="text" required>${escapeHTML(a.text || '')}</textarea></label>`, { ok: 'Save changes' });
        if (!result)
            return;
        this.history.transact('Edit text', s => {
            const obj = s.pages.find(x => x.id === p.id).annotations.find(x => x.id === id);
            obj.text = String(result.get('text'));
            if (a.type === 'text') {
                const size = obj.fontSize || 16, c = document.createElement('canvas').getContext('2d');
                c.font = `${size}px Arial`;
                obj.w = Math.max(...obj.text.split('\n').map(t => c.measureText(t).width)) + 4;
                obj.h = obj.text.split('\n').length * size * 1.25;
            }
        });
    }
    updateProperty(key, value) {
        const selected = this.selection;
        if (!selected)
            return;
        const numeric = ['x', 'y', 'w', 'h', 'fontSize', 'strokeWidth', 'opacity'];
        if (numeric.includes(key)) {
            value = Number(value);
            if (!Number.isFinite(value))
                return;
            if (key === 'fontSize')
                value = clamp(value, 4, 240);
            if (key === 'strokeWidth')
                value = clamp(value, .2, 50);
            if (key === 'opacity')
                value = clamp(value, .05, 1);
            if (key === 'w' || key === 'h')
                value = Math.max(1, value);
        }
        if (key === 'bold')
            value = value === 'true';
        this.history.transact(`Change ${key}`, s => {
            const a = s.pages.find(p => p.id === selected.page.id).annotations.find(a => a.id === this.selected);
            if ((key === 'w' || key === 'h') && a.points) {
                const axis = key === 'w' ? 0 : 1, origin = axis === 0 ? a.x : a.y, ratio = value / a[key];
                a.points = a.points.map(p => p.map((v, i) => i === axis ? origin + (v - origin) * ratio : v));
            }
            if ((key === 'x' || key === 'y') && a.points) {
                const offset = key === 'x' ? 0 : 1, delta = value - a[key];
                a.points = a.points.map(p => p.map((x, i) => i === offset ? x + delta : x));
            }
            a[key] = value;
        });
    }
    deleteObject(id = this.selected) {
        if (!id)
            return;
        this.history.transact('Delete object', s => {
            for (const p of s.pages)
                p.annotations = p.annotations.filter(a => a.id !== id);
        });
        if (this.selected === id)
            this.selected = null;
        this.renderRight();
    }
    duplicateObject() {
        const sel = this.selection;
        if (!sel)
            return;
        const a = clone(sel.annotation);
        a.id = uid();
        a.x += 14;
        a.y += 14;
        if (a.points)
            a.points = a.points.map(p => [p[0] + 14, p[1] + 14]);
        this.selected = a.id;
        this.history.transact('Duplicate object', s => s.pages.find(p => p.id === sel.page.id).annotations.push(a));
    }
    highlightSelection() {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || !selection.rangeCount)
            return false;
        const node = selection.anchorNode?.parentElement;
        if (!node?.closest('.text-layer'))
            return false;
        const rects = [...selection.getRangeAt(0).getClientRects()], marks = [];
        for (const r of rects) {
            if (r.width < 1 || r.height < 1)
                continue;
            for (const p of this.state.pages) {
                const v = this.views.get(p.id), box = v.paper.getBoundingClientRect();
                if (r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && r.left >= box.left - 1 && r.right <= box.right + 1) {
                    const a = this.screenPoint(r.left, r.top, p), b = this.screenPoint(r.right, r.bottom, p);
                    marks.push({ pageId: p.id, annotation: { id: uid(), type: 'highlight', ...rectFromPoints(a, b), color: '#ffd34e', opacity: 1, strokeWidth: 1 } });
                    break;
                }
            }
        }
        if (!marks.length)
            return false;
        this.history.transact('Highlight selected text', s => {
            for (const m of marks)
                s.pages.find(p => p.id === m.pageId).annotations.push(m.annotation);
        });
        selection.removeAllRanges();
        return true;
    }
    openOrganizer() {
        this.organizing = true;
        $('#viewer-wrap').hidden = true;
        $('#organizer').hidden = false;
        $('#search-bar').hidden = true;
        this.renderOrganizer();
    }
    closeOrganizer() {
        this.organizing = false;
        $('#viewer-wrap').hidden = false;
        $('#organizer').hidden = true;
        this.updateGpu();
    }
    renderOrganizer() {
        const grid = $('#organizer-grid');
        grid.innerHTML = this.state.pages.map((p, i) => `<div class="page-card ${i === this.activeIndex ? 'active' : ''}" draggable="true" tabindex="0" data-page-id="${p.id}" data-index="${i}" role="button" aria-label="Page ${i + 1}, drag to reorder"><div class="card-preview" style="height:160px;min-width:108px"></div><div class="page-card-footer"><span>Page ${i + 1}</span><span style="display:flex"><button class="plain" data-card-rotate="${i}" title="Rotate page ${i + 1}" aria-label="Rotate page ${i + 1}">${icon('rotate')}</button><button class="plain" data-card-open="${i}" title="Open page ${i + 1}" aria-label="Open page ${i + 1}">${icon('arrow')}</button></span></div></div>`).join('');
        for (const card of grid.children) {
            const id = card.dataset.pageId, canvas = this.thumbs.get(id);
            if (canvas) {
                const c = document.createElement('canvas');
                c.width = canvas.width;
                c.height = canvas.height;
                c.getContext('2d').drawImage(canvas, 0, 0);
                card.querySelector('.card-preview').append(c);
            }
            else {
                const p = this.state.pages.find(p => p.id === id);
                this.updateThumbnail(p).catch(() => {
                });
            }
            card.addEventListener('click', e => {
                if (e.target.closest('button'))
                    return;
                this.activeIndex = +card.dataset.index;
                this.syncChrome();
                this.renderRight();
            });
            card.addEventListener('keydown', e => {
                if (e.key === 'Enter') {
                    this.closeOrganizer();
                    this.goTo(+card.dataset.index);
                }
            });
            card.addEventListener('dragstart', e => {
                this.dragPageId = id;
                e.dataTransfer.setData('text/x-folio-page', id);
                e.dataTransfer.effectAllowed = 'move';
            });
            card.addEventListener('dragover', e => {
                if (this.dragPageId) {
                    e.preventDefault();
                    card.classList.add('drag-over');
                }
            });
            card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
            card.addEventListener('drop', e => {
                if (!this.dragPageId)
                    return;
                e.preventDefault();
                e.stopPropagation();
                const from = this.state.pages.findIndex(p => p.id === this.dragPageId), to = +card.dataset.index;
                this.movePage(from, to);
                this.dragPageId = null;
            });
            card.addEventListener('dragend', () => {
                this.dragPageId = null;
                $$('.drag-over').forEach(c => c.classList.remove('drag-over'));
            });
        }
    }
    movePage(from, to) {
        if (from < 0 || to < 0 || from >= this.state.pages.length || to >= this.state.pages.length || from === to)
            return;
        const id = this.state.pages[from].id;
        this.history.transact('Reorder pages', s => {
            const [p] = s.pages.splice(from, 1);
            s.pages.splice(to, 0, p);
        });
        this.activeIndex = this.state.pages.findIndex(p => p.id === id);
        this.syncChrome();
    }
    rotatePage(delta = 90, index = this.activeIndex) {
        this.history.transact('Rotate page', s => s.pages[index].rotation = normalizedRotation(s.pages[index].rotation + delta));
        if (!this.organizing)
            this.fit(this.fitMode);
    }
    insertPage() {
        const index = this.activeIndex + 1;
        this.history.transact('Insert blank page', s => s.pages.splice(index, 0, makePage(null, 0, { width: 612, height: 792 })));
        this.activeIndex = index;
        this.goTo(index);
    }
    duplicatePage() {
        const index = this.activeIndex, p = clone(this.page);
        p.id = uid();
        p.annotations = p.annotations.map(a => ({ ...a, id: uid() }));
        this.history.transact('Duplicate page', s => s.pages.splice(index + 1, 0, p));
        this.activeIndex = index + 1;
        this.syncChrome();
    }
    async deletePage() {
        if (this.state.pages.length === 1) {
            toast('Keep at least one page in the document.', true);
            return;
        }
        const result = await this.dialog.open('Remove this page?', `<p class="dialog-copy">Page ${this.activeIndex + 1} and its annotations will be removed from this workspace. You can undo this change.</p>`, { ok: 'Remove page' });
        if (result) {
            const index = this.activeIndex;
            this.history.transact('Delete page', s => s.pages.splice(index, 1));
            this.goTo(Math.min(index, this.state.pages.length - 1));
        }
    }
    async openFiles(files, { merge = false } = {}) {
        if (!files.length)
            return;
        if (files.length === 1 && files[0].name.toLowerCase().endsWith('.folio')) {
            if (!await this.confirmReplace())
                return;
            const text = await files[0].text();
            if (text.length > 250 * 1024 * 1024)
                throw Error('Project exceeds size limit');
            await this.loadProject(JSON.parse(text));
            return;
        }
        const pdfs = [...files].filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
        if (!pdfs.length) {
            if (files[0].type.startsWith('image/'))
                return this.loadImage(files[0]);
            throw Error('Open a PDF, PNG, JPEG, or .folio project.');
        }
        if (!merge && !await this.confirmReplace())
            return;
        await this.busy(merge ? 'Combining PDF documents…' : 'Opening PDF document…', async (progress) => {
            const staged = [], map = new Map(this.sources);
            for (let i = 0; i < pdfs.length; i++) {
                const file = pdfs[i];
                if (file.size > LIMITS.fileBytes)
                    throw Error(`${file.name} exceeds the 128 MiB file limit`);
                const source = await PDFSource.load(new Uint8Array(await file.arrayBuffer()), file.name), id = uid();
                map.set(id, source);
                staged.push({ id, source });
                progress((i + 1) / pdfs.length);
            }
            const pages = staged.flatMap(({ id, source }) => source.pages.map(p => makePage(id, p.index, p)));
            if (merge) {
                if (this.state.pages.length + pages.length > LIMITS.pages)
                    throw Error('Page limit exceeded');
                this.sources = map;
                this.history.transact('Combine PDFs', s => s.pages.push(...pages));
                this.goTo(this.state.pages.length - pages.length);
                toast(`Inserted ${pages.length} page${pages.length === 1 ? '' : 's'}.`);
            }
            else {
                this.sources = new Map(staged.map(({ id, source }) => [id, source]));
                this.setState({ name: pdfs[0].name, metadata: staged[0].source.metadata, pages, fieldValues: {} });
                this.closeOrganizer();
                this.setTool('select');
                this.fit('page');
            }
        });
    }
    async loadImage(file) {
        if (!['image/png', 'image/jpeg'].includes(file.type))
            throw Error('Only PNG and JPEG images are accepted');
        if (file.size > 32 * 1024 * 1024)
            throw Error('Image exceeds the 32 MiB limit');
        const bitmap = await createImageBitmap(file);
        if (bitmap.width * bitmap.height > 32e6) {
            bitmap.close();
            throw Error('Image exceeds the 32 megapixel limit');
        }
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        this.image = { data: canvas.toDataURL(file.type), ratio: bitmap.width / bitmap.height };
        bitmap.close();
        this.setTool('image');
        toast('Click the page to place your image.');
    }
    projectPayload() {
        return { format: 'folio-pro', version: 1, createdWith: VERSION, state: clone(this.state), sources: [...this.sources].map(([id, source]) => ({ id, label: source.label, bytes: source.bytes })) };
    }
    scheduleAutosave() {
        clearTimeout(this.autoSaveTimer);
        this.autoSaveTimer = setTimeout(async () => {
            try {
                await storage('put', this.projectPayload());
                $('#status-text').textContent = 'Autosaved locally · Export to keep a separate copy';
            }
            catch (error) {
                if (!this.autosaveFailed) {
                    this.autosaveFailed = true;
                    toast('Local autosave is unavailable. Download a Folio project to keep your edits.', true, 8000);
                }
            }
        }, 1200);
    }
    async saveProject() {
        const payload = this.projectPayload();
        payload.sources = payload.sources.map(s => ({ id: s.id, label: s.label, data: bytesToBase64(s.bytes) }));
        await download(JSON.stringify(payload), this.state.name.replace(/\.[^.]+$/, '') + '.folio', 'application/json');
        this.history.markSaved();
        this.syncChrome();
        toast('Editable project saved, including the original PDFs and all edits.');
    }
    async loadProject(payload) {
        if (payload?.format !== 'folio-pro' || payload.version !== 1 || !Array.isArray(payload.sources) || payload.sources.length > 1000)
            throw Error('Invalid or unsupported Folio project');
        validateState(payload.state);
        await this.busy('Restoring editable project…', async (progress) => {
            const sources = new Map();
            let total = 0;
            for (const [index, s] of payload.sources.entries()) {
                if (typeof s.id !== 'string' || sources.has(s.id))
                    throw Error('Duplicate source ID');
                const bytes = s.bytes instanceof Uint8Array ? s.bytes : base64ToBytes(s.data);
                total += bytes.length;
                if (total > 256 * 1024 * 1024)
                    throw Error('Combined project sources exceed 256 MiB');
                sources.set(s.id, await PDFSource.load(bytes, s.label));
                progress((index + 1) / Math.max(1, payload.sources.length));
            }
            for (const p of payload.state.pages)
                if (p.sourceId && (!sources.has(p.sourceId) || p.sourcePage >= sources.get(p.sourceId).pages.length))
                    throw Error('Project has invalid page references');
            this.sources = sources;
            this.setState(payload.state);
            this.fit('page');
        });
        toast('Project restored. All objects remain editable.');
    }
    async exportPDF(indices = null) {
        await this.busy('Writing PDF document…', async (progress) => {
            const state = clone(this.state), bytes = await exportVector(state, this.sources, { indices, onProgress: progress });
            await download(bytes, state.name.replace(/\.pdf$/i, '') + (indices ? '-extracted' : '-edited') + '.pdf', 'application/pdf');
            if (!indices) {
                this.history.markSaved();
                this.syncChrome();
            }
            this.lastExport = bytes;
        });
        toast('PDF exported. Added artwork is flattened; notes and new form fields remain PDF annotations.');
    }
    async rasterPDF(redactions = false) {
        const pending = this.state.pages.some(p => p.annotations.some(a => a.type === 'redact'));
        if (pending && !redactions)
            return this.rasterPDF(true);
        const result = await this.dialog.open(redactions ? 'Apply redactions. Remove the originals.' : 'Export an image-only PDF.', `<div class="${redactions ? 'dialog-warning' : 'dialog-info'}">${redactions ? '<strong>This creates a completely new, image-only PDF.</strong><br>Marked pixels are replaced by opaque black. No original PDF objects, text, metadata, attachments, or form fields are copied into the exported file.' : 'Every page is flattened to an image. Searchable text, live form fields, and comment bodies are not preserved. This is not PDF/A conversion.'}</div><p class="dialog-copy">${redactions ? 'All pages will be rasterized. Your current workspace, source files, Folio project, and autosave still contain the original content. Do not distribute those as a redacted document.' : 'The original document in your workspace is not changed. Higher resolution improves print quality but uses more memory and storage.'}</p><label class="dialog-label">Output resolution<select name="dpi"><option value="144">144 dpi · balanced</option><option value="216">216 dpi · higher quality</option><option value="96">96 dpi · smaller output</option></select></label>${redactions ? '<label class="dialog-check"><input type="checkbox" name="ack" required>I understand that only the exported PDF is sanitized.</label>' : ''}`, { ok: redactions ? 'Apply & export' : 'Export PDF' });
        if (!result)
            return;
        if (redactions && !result.get('ack'))
            return;
        await this.busy(redactions ? 'Creating sanitized PDF…' : 'Rasterizing PDF pages…', async (progress) => {
            const bytes = await exportRaster(clone(this.state), this.sources, this.renderer, { redactions, scale: Number(result.get('dpi')) / 72, onProgress: progress });
            await download(bytes, this.state.name.replace(/\.pdf$/i, '') + (redactions ? '-redacted' : '-image-only') + '.pdf', 'application/pdf');
            this.lastExport = bytes;
        });
        toast(redactions ? 'Sanitized PDF exported. The editable workspace still contains the original document.' : 'Image-only PDF exported.');
    }
    async exportPNG() {
        await this.busy('Rendering page image…', async () => {
            const canvas = await renderComposite(this.page, this.sources, this.renderer, this.state, { scale: 2, redactions: true });
            const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
            await download(blob, `page-${this.activeIndex + 1}.png`, 'image/png');
        });
        toast('Current page exported at 144 dpi.');
    }
    async exportText() {
        await this.busy('Extracting document text…', async (progress) => {
            const blocks = [];
            for (const [index, p] of this.state.pages.entries()) {
                const result = await this.getRendered(p, 1);
                blocks.push(`--- Page ${index + 1} ---\n` + result.text.map(t => t.text).join('\n') + '\n' + p.annotations.filter(a => a.type === 'text').map(a => a.text).join('\n'));
                progress((index + 1) / this.state.pages.length);
            }
            await download(blocks.join('\n\n'), this.state.name.replace(/\.pdf$/i, '') + '.txt', 'text/plain;charset=utf-8');
        });
        toast('Text extracted in PDF painting order, not semantic reading order.');
    }
    async find(term) {
        this.search.term = term;
        const token = ++this.search.token;
        this.search.results = [];
        this.search.index = 0;
        $('#find-count').textContent = term ? 'Searching…' : '0 matches';
        if (!term) {
            for (const p of this.state.pages)
                this.renderOverlay(p.id);
            return;
        }
        for (const p of this.state.pages) {
            if (token !== this.search.token)
                return;
            let items = this.texts.get(p.id);
            if (!items) {
                try {
                    const result = await this.getRendered(p, .5);
                    items = result.text;
                    this.texts.set(p.id, items);
                }
                catch {
                    continue;
                }
            }
            for (const item of items)
                if (item.text.toLocaleLowerCase().includes(term.toLocaleLowerCase()))
                    this.search.results.push({ pageId: p.id, item });
            for (const a of p.annotations.filter(a => a.type === 'text' && a.text.toLocaleLowerCase().includes(term.toLocaleLowerCase())))
                this.search.results.push({ pageId: p.id, item: { text: a.text, x: a.x, y: a.y, w: a.w, h: a.h } });
        }
        if (token !== this.search.token)
            return;
        $('#find-count').textContent = this.search.results.length ? `1 / ${this.search.results.length}` : 'No matches';
        for (const p of this.state.pages)
            this.renderOverlay(p.id);
        if (this.search.results.length)
            this.showSearchMatch(0);
    }
    showSearchMatch(delta) {
        const results = this.search.results;
        if (!results.length)
            return;
        this.search.index = (this.search.index + delta + results.length) % results.length;
        const r = results[this.search.index], index = this.state.pages.findIndex(p => p.id === r.pageId);
        this.goTo(index, false);
        const v = this.views.get(r.pageId), crop = cropBox(this.state.pages[index]);
        if (this.state.pages[index].rotation === 0)
            $('#scroller').scrollTop = v.paper.offsetTop + (r.item.y - crop.y) * this.zoom - $('#scroller').clientHeight * .4;
        $('#find-count').textContent = `${this.search.index + 1} / ${results.length}`;
        for (const p of this.state.pages)
            this.renderOverlay(p.id);
    }
    async signatureDialog() {
        const result = await this.dialog.open('Make your mark.', `<p class="dialog-copy">Type or draw a visual signature. It is not a certificate-backed digital signature and does not verify anyone’s identity.</p>${field('Type your name', 'signature', '')}<div class="signature-preview" id="signature-preview">Your signature</div><label class="dialog-label">Or draw below<canvas class="signature-canvas" id="signature-pad" width="800" height="280"></canvas></label><button type="button" class="text-button" id="clear-signature">Clear drawing</button><input type="hidden" name="drawn" id="signature-drawn" value="">`, { ok: 'Place signature', setup: () => {
                const pad = $('#signature-pad'), ctx = pad.getContext('2d');
                let down = false, hasInk = false;
                ctx.strokeStyle = '#263e65';
                ctx.lineWidth = 3;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                const pt = e => {
                    const r = pad.getBoundingClientRect();
                    return [(e.clientX - r.left) * pad.width / r.width, (e.clientY - r.top) * pad.height / r.height];
                };
                pad.addEventListener('pointerdown', e => {
                    e.preventDefault();
                    down = true;
                    ctx.beginPath();
                    ctx.moveTo(...pt(e));
                    pad.setPointerCapture(e.pointerId);
                });
                pad.addEventListener('pointermove', e => {
                    if (!down)
                        return;
                    ctx.lineTo(...pt(e));
                    ctx.stroke();
                    hasInk = true;
                });
                pad.addEventListener('pointerup', () => {
                    down = false;
                    if (hasInk)
                        $('#signature-drawn').value = pad.toDataURL('image/png');
                });
                $('#clear-signature').onclick = () => {
                    ctx.clearRect(0, 0, pad.width, pad.height);
                    hasInk = false;
                    $('#signature-drawn').value = '';
                };
                $('[name=signature]').addEventListener('input', e => $('#signature-preview').textContent = e.target.value || 'Your signature');
            } });
        if (!result)
            return;
        const data = String(result.get('drawn') || ''), text = String(result.get('signature') || '').trim();
        if (!data && !text) {
            toast('Type a name or draw a signature first.', true);
            return;
        }
        this.signature = data ? { data, ratio: 800 / 280 } : { text };
        this.setTool('signature');
        toast('Click the page to place your signature.');
    }
    async propertiesDialog() {
        const m = this.state.metadata;
        const r = await this.dialog.open('Document properties', `${field('File name', 'name', this.state.name)}${field('Title', 'title', m.title || '')}${field('Author', 'author', m.author || '')}${field('Subject', 'subject', m.subject || '')}<p class="dialog-copy">Metadata edits apply to exported PDFs. Original source files are not modified.</p>`, { ok: 'Save properties' });
        if (r)
            this.history.transact('Update document properties', s => {
                s.name = String(r.get('name') || 'Untitled.pdf');
                if (!/\.pdf$/i.test(s.name))
                    s.name += '.pdf';
                s.metadata = { ...s.metadata, title: String(r.get('title')), author: String(r.get('author')), subject: String(r.get('subject')) };
            });
    }
    async watermarkDialog() {
        const r = await this.dialog.open('A mark on every page.', `${field('Watermark text', 'text', 'DRAFT')}<div class="dialog-grid">${field('Font size · pt', 'size', 48, 'number', 'min="8" max="160"')}${field('Opacity', 'opacity', .18, 'number', 'min=".05" max="1" step=".05"')}</div><p class="dialog-copy">Adds an editable, centered text watermark to every page.</p>`, { ok: 'Add watermark' });
        if (!r)
            return;
        const text = String(r.get('text') || '').trim();
        if (!text)
            return;
        const size = clamp(Number(r.get('size')) || 48, 8, 160), opacity = clamp(Number(r.get('opacity')) || .18, .05, 1);
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.font = `bold ${size}px Arial`;
        const w = ctx.measureText(text).width;
        this.history.transact('Add watermark', s => {
            for (const p of s.pages) {
                const c = cropBox(p);
                p.annotations.push({ id: uid(), type: 'text', text, x: c.x + (c.w - w) / 2, y: c.y + c.h / 2 - size / 2, w, h: size * 1.3, fontSize: size, color: '#708197', opacity, bold: true });
            }
        });
    }
    async engineDialog() {
        const warnings = [...new Set([...this.sources.values()].flatMap(s => [...s.warnings]))];
        const r = await this.dialog.open('Inside the document engine.', `<p class="dialog-copy">The renderer interprets PDF content; the compositor presents cached pages. They are independent so unsupported PDF features are never described as a GPU problem.</p><table class="engine-table"><tr><td>PDF renderer</td><td>${escapeHTML(this.renderer.name)}</td></tr><tr><td>Compositor</td><td>${this.gpu.mode}</td></tr><tr><td>GPU reason</td><td>${escapeHTML(this.gpuReason || 'Starting')}</td></tr><tr><td>CPU page cache</td><td>${formatBytes(this.cache.bytes)} / 128 MiB</td></tr><tr><td>GPU texture cache</td><td>${formatBytes(this.gpu.textures.bytes)} / 128 MiB</td></tr><tr><td>Last GPU encode</td><td>${this.gpu.lastFrameMs.toFixed(2)} ms (CPU submission, not GPU time)</td></tr></table><div class="dialog-info">The offline renderer supports core PDF text, paths, images, forms, and common compression. Complex shading, text clipping, Type 3 fonts, some color spaces, and inline images require the optional PDF.js renderer. Font substitution and basic CMYK conversion are not press-proof color management.</div>${warnings.length ? `<div class="dialog-warning">${warnings.map(escapeHTML).join('<br>')}</div>` : ''}<p class="dialog-copy">PDF.js 6.3.289 is loaded from jsDelivr only when requested. Document bytes are not uploaded. The native structural parser still rejects encrypted and XFA PDFs.</p>`, { ok: this.renderer instanceof PDFJSRenderer ? 'Use offline renderer' : 'Load PDF.js renderer' });
        if (r) {
            if (this.renderer instanceof PDFJSRenderer) {
                this.renderer = new NativePDFRenderer();
                this.revision++;
                this.cache.clear();
                this.buildPages();
                this.buildThumbnails();
                this.syncChrome();
                toast('Using the built-in offline PDF renderer.');
            }
            else
                await this.enableCompatibility();
        }
    }
    async enableCompatibility() {
        await this.busy('Loading PDF.js compatibility renderer…', async () => {
            const timeout = new Promise((_, reject) => setTimeout(() => reject(Error('Could not load PDF.js. Check your internet connection or continue with the built-in offline renderer.')), 15000));
            const renderer = await Promise.race([PDFJSRenderer.load(), timeout]);
            this.renderer = renderer;
            this.revision++;
            this.cache.clear();
            this.buildPages();
            this.buildThumbnails();
            this.syncChrome();
        });
        toast('PDF.js renderer enabled. GPU compositing remains independent.');
    }
    showRight() {
        const p = $('#right-panel');
        p.hidden = false;
        p.style.display = 'flex';
    }
    renderMenu() {
        const rows = [['New blank document', 'plus', 'new', '⌘/Ctrl N'], ['Open PDF or project…', 'folder', 'open', '⌘/Ctrl O'], ['Open example document', 'file', 'demo', ''], null, ['Export PDF…', 'download', 'export', '⌘/Ctrl S'], ['Save editable project…', 'save', 'project', '⌘/Ctrl ⇧ S'], ['Export image-only PDF…', 'image', 'raster', ''], ['Open printable PDF', 'print', 'print', ''], null, ['Document properties', 'settings', 'properties', ''], ['Restore autosave', 'history', 'restore', ''], ['Forget local autosave', 'trash', 'clear-autosave', ''], null, ['Engine & compatibility', 'bolt', 'engine', ''], ['Keyboard shortcuts', 'info', 'shortcuts', ''], ['About Folio Pro', 'info', 'about', '']];
        $('#file-menu').innerHTML = rows.map(r => r ? `<button data-action="${r[2]}">${icon(r[1])}${r[0]}${r[3] ? `<kbd>${r[3]}</kbd>` : ''}</button>` : '<hr>').join('');
    }
    bindEvents() {
        const run = fn => {
            try {
                Promise.resolve(fn()).catch(e => this.error(e));
            }
            catch (e) {
                this.error(e);
            }
        };
        document.addEventListener('click', e => {
            const action = e.target.closest('[data-action]'), tool = e.target.closest('[data-tool]'), tab = e.target.closest('[data-tab]'), right = e.target.closest('[data-right]'), page = e.target.closest('[data-go-page]');
            if (action) {
                e.preventDefault();
                if (action.dataset.action !== 'file-menu')
                    $('#file-menu').hidden = true;
                run(() => this.action(action.dataset.action));
            }
            else if (tool) {
                e.preventDefault();
                if (tool.dataset.tool === 'highlight' && this.highlightSelection())
                    return;
                this.setTool(tool.dataset.tool);
            }
            else if (tab)
                this.setTab(tab.dataset.tab);
            else if (right) {
                this.rightTab = right.dataset.right;
                this.renderRight();
            }
            else if (page)
                this.goTo(Number(page.dataset.goPage));
            else if (!e.target.closest('#file-menu'))
                $('#file-menu').hidden = true;
            const note = e.target.closest('[data-select-note],[data-edit-note],[data-delete-note],[data-resolve-note]');
            if (note) {
                const id = note.dataset.selectNote || note.dataset.editNote || note.dataset.deleteNote || note.dataset.resolveNote;
                this.select(id);
                const selected = this.selection;
                if (!selected)
                    return;
                this.goTo(this.state.pages.indexOf(selected.page));
                if (note.dataset.editNote)
                    run(() => this.editText(id));
                if (note.dataset.deleteNote)
                    this.deleteObject();
                if (note.dataset.resolveNote)
                    this.history.transact('Change comment status', s => {
                        const a = s.pages.find(p => p.id === selected.page.id).annotations.find(a => a.id === id);
                        a.resolved = !a.resolved;
                    });
            }
            const color = e.target.closest('[data-set-color]');
            if (color) {
                this.defaultColor = color.dataset.setColor;
                if (this.selection)
                    this.updateProperty('color', this.defaultColor);
                else
                    this.renderRight();
            }
        });
        document.addEventListener('change', e => {
            if (e.target.dataset.property)
                this.updateProperty(e.target.dataset.property, e.target.type === 'checkbox' ? String(e.target.checked) : e.target.value);
            if (e.target.id === 'default-size')
                this.defaultFontSize = clamp(Number(e.target.value) || 16, 4, 240);
            if (e.target.id === 'default-color')
                this.defaultColor = e.target.value;
            if (e.target.id === 'default-stroke')
                this.defaultStroke = clamp(Number(e.target.value) || 2, .2, 50);
        });
        $('#tool-filter').addEventListener('input', e => this.renderTools(e.target.value));
        $('#find-input').addEventListener('input', e => {
            clearTimeout(this.findTimer);
            this.findTimer = setTimeout(() => run(() => this.find(e.target.value)), 180);
        });
        $('#find-input').addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.showSearchMatch(e.shiftKey ? -1 : 1);
            }
            if (e.key === 'Escape')
                run(() => this.action('close-search'));
        });
        $('#page-number').addEventListener('change', e => this.goTo(Number(e.target.value) - 1));
        $('#zoom-range').addEventListener('input', e => this.setZoom(Number(e.target.value) / 100));
        $('#open-input').addEventListener('change', e => {
            const files = [...e.target.files];
            e.target.value = '';
            run(() => this.openFiles(files));
        });
        $('#merge-input').addEventListener('change', e => {
            const files = [...e.target.files];
            e.target.value = '';
            run(() => this.openFiles(files, { merge: true }));
        });
        $('#image-input').addEventListener('change', e => {
            const file = e.target.files[0];
            e.target.value = '';
            if (file)
                run(() => this.loadImage(file));
        });
        const scroller = $('#scroller');
        let scrollFrame = 0;
        scroller.addEventListener('scroll', () => {
            if (scrollFrame)
                return;
            scrollFrame = requestAnimationFrame(() => {
                scrollFrame = 0;
                this.updateGpu();
                if (!this.state || this.organizing)
                    return;
                const y = scroller.scrollTop + scroller.clientHeight * .35;
                let best = 0, dist = Infinity;
                this.state.pages.forEach((p, i) => {
                    const node = this.views.get(p.id)?.paper;
                    if (!node)
                        return;
                    const d = y < node.offsetTop ? node.offsetTop - y : y > node.offsetTop + node.offsetHeight ? y - node.offsetTop - node.offsetHeight : 0;
                    if (d < dist) {
                        dist = d;
                        best = i;
                    }
                });
                if (best !== this.activeIndex) {
                    this.activeIndex = best;
                    this.syncChrome();
                    if (!this.selection)
                        this.renderRight();
                }
            });
        }, { passive: true });
        scroller.addEventListener('wheel', e => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                const rect = scroller.getBoundingClientRect();
                this.setZoom(this.zoom * Math.exp(-e.deltaY * .002), { x: e.clientX - rect.left, y: e.clientY - rect.top });
            }
        }, { passive: false });
        new ResizeObserver(() => {
            clearTimeout(this.resizeTimer);
            this.resizeTimer = setTimeout(() => {
                if (this.state) {
                    if (this.fitMode)
                        this.fit(this.fitMode);
                    else
                        this.updateGpu();
                }
            }, 80);
        }).observe($('#viewer-wrap'));
        window.addEventListener('keydown', e => run(() => this.keyDown(e)));
        window.addEventListener('keyup', e => {
            if (e.code === 'Space' && this.spaceTool) {
                this.setTool(this.spaceTool);
                this.spaceTool = null;
            }
        });
        window.addEventListener('beforeunload', e => {
            if (this.history?.dirty && !this.unloading) {
                e.preventDefault();
                e.returnValue = '';
            }
        });
        let depth = 0;
        document.addEventListener('dragenter', e => {
            if ([...e.dataTransfer.types].includes('Files')) {
                e.preventDefault();
                depth++;
                $('#drop-zone').hidden = false;
            }
        });
        document.addEventListener('dragover', e => {
            if ([...e.dataTransfer.types].includes('Files'))
                e.preventDefault();
        });
        document.addEventListener('dragleave', e => {
            if ([...e.dataTransfer.types].includes('Files') && --depth <= 0) {
                depth = 0;
                $('#drop-zone').hidden = true;
            }
        });
        document.addEventListener('drop', e => {
            if (!e.dataTransfer.files.length)
                return;
            e.preventDefault();
            depth = 0;
            $('#drop-zone').hidden = true;
            run(() => this.openFiles([...e.dataTransfer.files]));
        });
    }
    async action(command) {
        switch (command) {
            case 'file-menu':
                $('#file-menu').hidden = !$('#file-menu').hidden;
                return;
            case 'open':
                $('#open-input').click();
                return;
            case 'merge':
                $('#merge-input').click();
                return;
            case 'image':
                $('#image-input').click();
                return;
            case 'demo': return this.loadDemo();
            case 'new':
                if (await this.confirmReplace()) {
                    this.sources = new Map();
                    this.setState(blankState());
                    this.closeOrganizer();
                    this.fit('page');
                }
                return;
            case 'undo':
                this.cancelGesture();
                this.history.undo();
                return;
            case 'redo':
                this.cancelGesture();
                this.history.redo();
                return;
            case 'export': return this.exportPDF();
            case 'project': return this.saveProject();
            case 'raster': return this.rasterPDF();
            case 'apply-redactions': return this.rasterPDF(true);
            case 'png': return this.exportPNG();
            case 'text-export': return this.exportText();
            case 'comments-export': return download(JSON.stringify({ document: this.state.name, comments: this.state.pages.flatMap((p, i) => p.annotations.filter(a => a.type === 'note').map(a => ({ ...a, page: i + 1 }))) }, null, 2), 'comments.json', 'application/json');
            case 'properties': return this.propertiesDialog();
            case 'signature': return this.signatureDialog();
            case 'watermark': return this.watermarkDialog();
            case 'stamp': {
                const r = await this.dialog.open('Add an approval stamp.', `<label class="dialog-label">Stamp text<select name="stamp"><option>APPROVED</option><option>DRAFT</option><option>REVIEWED</option><option>CONFIDENTIAL</option><option>FINAL</option></select></label><p class="dialog-copy">A visual mark, not a verified approval workflow.</p>`, { ok: 'Place stamp' });
                if (r) {
                    this.stampText = String(r.get('stamp'));
                    this.setTool('stamp');
                    toast('Click a page to place your stamp.');
                }
                return;
            }
            case 'forms':
                this.closeOrganizer();
                this.setTool('select');
                await this.ensurePage(this.page.id);
                for (const p of this.state.pages) {
                    const v = this.views.get(p.id);
                    if (v)
                        this.renderForms(p, v);
                }
                toast('Click a highlighted text or checkbox field to fill it.');
                return;
            case 'search':
                $('#search-bar').hidden = false;
                $('#find-input').focus();
                $('#find-input').select();
                return;
            case 'close-search':
                $('#search-bar').hidden = true;
                this.search.token++;
                this.search = { term: '', results: [], index: 0, token: this.search.token };
                $('#find-input').value = '';
                for (const p of this.state.pages)
                    this.renderOverlay(p.id);
                return;
            case 'find-prev': return this.showSearchMatch(-1);
            case 'find-next': return this.showSearchMatch(1);
            case 'prev': return this.goTo(this.activeIndex - 1);
            case 'next': return this.goTo(this.activeIndex + 1);
            case 'zoom-in': return this.setZoom(this.zoom * 1.2);
            case 'zoom-out': return this.setZoom(this.zoom / 1.2);
            case 'fit': return this.fit('page');
            case 'fit-width': return this.fit('width');
            case 'zoom-menu': {
                const r = await this.dialog.open('Find your perspective.', field('Zoom · percent', 'zoom', Math.round(this.zoom * 100), 'number', 'min="25" max="400"'), { ok: 'Set zoom' });
                if (r)
                    this.setZoom(Number(r.get('zoom')) / 100);
                return;
            }
            case 'toggle-tools':
                $('#tools-panel').hidden = !$('#tools-panel').hidden;
                return;
            case 'toggle-pages':
                $('#page-rail').hidden = !$('#page-rail').hidden;
                return;
            case 'toggle-right': {
                const p = $('#right-panel');
                p.hidden = !p.hidden;
                p.style.display = p.hidden ? 'none' : 'flex';
                return;
            }
            case 'thumbnails':
                $('#thumbnails').hidden = false;
                $('#bookmarks').hidden = true;
                $('#rail-label').innerHTML = `PAGES <span id="rail-count">${this.state.pages.length}</span>`;
                return;
            case 'bookmarks':
                $('#thumbnails').hidden = true;
                $('#bookmarks').hidden = false;
                $('#rail-label').innerHTML = `BOOKMARKS <span id="rail-count">${this.state.pages.length}</span>`;
                return this.loadBookmarks();
            case 'organize': return this.setTab('organize');
            case 'close-organizer':
                this.closeOrganizer();
                return this.setTab('all');
            case 'rotate': return this.rotatePage(90);
            case 'rotate-left': return this.rotatePage(-90);
            case 'insert-page': return this.insertPage();
            case 'duplicate-page': return this.duplicatePage();
            case 'delete-page': return this.deletePage();
            case 'reset-crop':
                this.history.transact('Reset page crop', s => s.pages[this.activeIndex].crop = null);
                return;
            case 'extract': {
                const r = await this.dialog.open('Extract exactly what you need.', `${field('Page range', 'range', String(this.activeIndex + 1))}<p class="dialog-copy">Use ranges such as 1–3, 5, 8. Original pages stay in this document. A new PDF is exported in the order specified.</p>`, { ok: 'Export pages' });
                if (r)
                    await this.exportPDF(parsePageRange(String(r.get('range')), this.state.pages.length));
                return;
            }
            case 'move-page': {
                const r = await this.dialog.open('Move this page.', field('New page position', 'position', this.activeIndex + 1, 'number', `min="1" max="${this.state.pages.length}"`), { ok: 'Move page' });
                if (r)
                    this.movePage(this.activeIndex, clamp(Number(r.get('position')) - 1, 0, this.state.pages.length - 1));
                return;
            }
            case 'delete-object': return this.deleteObject();
            case 'duplicate-object': return this.duplicateObject();
            case 'bring-front':
            case 'send-back': {
                const sel = this.selection;
                if (sel)
                    this.history.transact(command === 'bring-front' ? 'Bring to front' : 'Send to back', s => {
                        const annotations = s.pages.find(p => p.id === sel.page.id).annotations, index = annotations.findIndex(a => a.id === this.selected), [a] = annotations.splice(index, 1);
                        if (command === 'bring-front')
                            annotations.push(a);
                        else
                            annotations.unshift(a);
                    });
                return;
            }
            case 'page-numbers':
                this.history.transact('Add page numbers', s => s.pages.forEach((p, i) => {
                    const c = cropBox(p);
                    p.annotations.push({ id: uid(), type: 'text', text: `${i + 1} / ${s.pages.length}`, x: c.x + c.w / 2 - 15, y: c.y + c.h - 27, w: 70, h: 14, fontSize: 10, color: '#677489' });
                }));
                toast('Editable page numbers added to every page.');
                return;
            case 'restore': {
                const record = await storage('get');
                if (!record) {
                    toast('No autosaved workspace is available.');
                    return;
                }
                if (await this.confirmReplace())
                    await this.loadProject(record);
                return;
            }
            case 'clear-autosave':
                if (await this.dialog.open('Forget this device’s autosave?', `<p class="dialog-copy">This deletes only the locally stored recovery workspace. Your open document and downloaded files are not deleted. Future edits will create a new autosave.</p>`, { ok: 'Forget autosave' })) {
                    clearTimeout(this.autoSaveTimer);
                    await storage('delete');
                    toast('Local recovery workspace removed.');
                }
                return;
            case 'print': {
                if (this.state.pages.some(p => p.annotations.some(a => a.type === 'redact')))
                    throw Error('Apply pending redactions and print the sanitized exported PDF.');
                const popup = window.open('about:blank', '_blank');
                if (!popup)
                    throw Error('Allow a popup to open the printable PDF.');
                try {
                    popup.document.title = 'Preparing PDF…';
                    popup.document.body.textContent = 'Preparing your local PDF for the browser print viewer…';
                    const bytes = await exportVector(clone(this.state), this.sources);
                    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
                    popup.opener = null;
                    popup.location.replace(url);
                    setTimeout(() => URL.revokeObjectURL(url), 120000);
                }
                catch (e) {
                    popup.close();
                    throw e;
                }
                return;
            }
            case 'engine': return this.engineDialog();
            case 'compatibility': return this.enableCompatibility();
            case 'shortcuts': return this.dialog.open('A little less clicking.', `<table class="engine-table">${[['Ctrl / ⌘ O', 'Open document'], ['Ctrl / ⌘ S', 'Export PDF'], ['Ctrl / ⌘ Shift S', 'Save editable project'], ['Ctrl / ⌘ Z', 'Undo'], ['Ctrl / ⌘ Shift Z', 'Redo'], ['Ctrl / ⌘ F', 'Find text'], ['V / H', 'Select / hand'], ['T / N / U', 'Text / comment / highlight'], ['R / D', 'Rectangle / freehand'], ['Space + drag', 'Pan document'], ['Delete / Backspace', 'Delete selected object'], ['Arrow keys', 'Move selected object · Shift = 10 pt'], ['Ctrl / ⌘ D', 'Duplicate selected object'], ['Escape', 'Cancel drawing / deselect']].map(([a, b]) => `<tr><td>${escapeHTML(a)}</td><td>${b}</td></tr>`).join('')}</table>`, { ok: 'Done' });
            case 'about': return this.dialog.open('Documents, thoughtfully done.', `<div class="about-mark">f</div><h3>Folio Pro <small>${VERSION}</small></h3><p class="dialog-copy">An independent, local-first PDF workspace built with plain JavaScript, HTML, CSS, a native PDF parser/writer, and an actual WebGPU page compositor.</p><div class="dialog-info">Real PDF viewing, additive editing, annotation, forms, page organization, and export. This is a functional engineering release, not feature parity with Adobe Acrobat Pro.</div><p class="dialog-copy">No account or document upload. Editable source files and annotations are autosaved in this browser’s IndexedDB. Use File → Forget local autosave to remove that recovery copy.</p><p class="dialog-copy">Source text reflow, OCR, encrypted PDFs, certificate signatures, PDF/A validation, and prepress color workflows are not implemented. PDF.js compatibility is optional and requires an internet connection. The included Northstar document and reviews are fictional.</p>`, { ok: 'Back to work' });
            default: throw Error(`Unknown command: ${command}`);
        }
    }
    async keyDown(e) {
        if (!this.state || this.loading)
            return;
        const editing = e.target.closest('input,textarea,select,[contenteditable=true]');
        if ($('#dialog').open)
            return;
        const mod = e.metaKey || e.ctrlKey, key = e.key.toLowerCase();
        if (mod && ['o', 's', 'f', 'z', 'y', 'n', 'd'].includes(key) && (!editing || ['o', 's', 'f', 'n'].includes(key))) {
            e.preventDefault();
            if (key === 'o')
                return this.action('open');
            if (key === 's')
                return this.action(e.shiftKey ? 'project' : 'export');
            if (key === 'f')
                return this.action('search');
            if (key === 'n')
                return this.action('new');
            if (key === 'z')
                return this.action(e.shiftKey ? 'redo' : 'undo');
            if (key === 'y')
                return this.action('redo');
            if (key === 'd')
                return this.duplicateObject();
        }
        if (editing)
            return;
        if (e.key === 'Escape') {
            this.cancelGesture();
            this.selected = null;
            this.setTool('select');
            for (const p of this.state.pages)
                this.renderOverlay(p.id);
            this.renderRight();
            $('#file-menu').hidden = true;
            return;
        }
        if (e.code === 'Space' && !e.repeat) {
            e.preventDefault();
            this.spaceTool = this.tool;
            this.setTool('hand');
            return;
        }
        if (mod)
            return;
        if (['Delete', 'Backspace'].includes(e.key)) {
            if (this.selected) {
                e.preventDefault();
                this.deleteObject();
            }
            return;
        }
        if (this.selection && e.key.startsWith('Arrow')) {
            e.preventDefault();
            const dx = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0, dy = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0, d = e.shiftKey ? 10 : 1, sel = this.selection;
            this.history.transact('Nudge object', s => {
                const a = s.pages.find(p => p.id === sel.page.id).annotations.find(a => a.id === this.selected);
                a.x += dx * d;
                a.y += dy * d;
                if (a.points)
                    a.points = a.points.map(([x, y]) => [x + dx * d, y + dy * d]);
            });
            return;
        }
        const tools = { v: 'select', h: 'hand', t: 'text', n: 'note', u: 'highlight', r: 'rect', d: 'ink' };
        if (tools[key]) {
            if (key === 'u' && this.highlightSelection())
                return;
            this.setTool(tools[key]);
        }
        if (key === '/') {
            e.preventDefault();
            $('#tools-panel').hidden = false;
            $('#tool-filter').focus();
        }
        if (e.key === 'PageDown') {
            e.preventDefault();
            this.goTo(this.activeIndex + 1);
        }
        if (e.key === 'PageUp') {
            e.preventDefault();
            this.goTo(this.activeIndex - 1);
        }
    }
    error(error) {
        console.error(error);
        this.lastError = String(error?.message || error);
        toast(this.lastError, true, 7500);
        $('#status-text').textContent = this.lastError;
    }
}
const folioApp = new FolioApp();
window.folio = folioApp;
folioApp.start().catch(error => folioApp.error(error));
