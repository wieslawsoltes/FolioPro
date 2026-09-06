import { escapeHTML } from './core.mjs';
const paths = {
    menu: 'M4 6h16M4 12h16M4 18h16', file: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z M14 3v6h6M8 14h8M8 17h5', plus: 'M12 5v14M5 12h14', minus: 'M5 12h14', more: 'M5 12h.01M12 12h.01M19 12h.01', search: 'M21 21l-4.4-4.4M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0', undo: 'M3 10h12a6 6 0 0 1 0 12M3 10l5-5M3 10l5 5', redo: 'M21 10H9a6 6 0 0 0 0 12M21 10l-5-5M21 10l-5 5', folder: 'M3 7h7l2-3h8a1 1 0 0 1 1 1v14H3zM3 7V4h6l3 3', download: 'M12 3v12M7 10l5 5 5-5M4 16v4h16v-4', print: 'M6 9V3h12v6M6 17H3V9h18v8h-3M6 14h12v7H6zM17 11h1', shield: 'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6', lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4', pages: 'M8 7h12v14H8zM4 17V3h12', bookmark: 'M6 3h12v18l-6-4-6 4z', sidebar: 'M3 4h18v16H3zM8 4v16', panel: 'M3 4h18v16H3zM16 4v16', close: 'M6 6l12 12M6 18 18 6', 'chevron-left': 'M14 5l-7 7 7 7', up: 'M6 15l6-6 6 6', down: 'M6 9l6 6 6-6', rotate: 'M3 9a9 9 0 1 1 0 6M3 3v6h6', fit: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M8 8h8v8H8z', 'fit-width': 'M3 5v14M21 5v14M5 12h14M8 9l-3 3 3 3M16 9l3 3-3 3', cursor: 'M5 3l15 9-7 2-3 7z', hand: 'M7 12V6a1.5 1.5 0 0 1 3 0v5M10 11V4a1.5 1.5 0 0 1 3 0v7M13 11V5a1.5 1.5 0 0 1 3 0v7M16 11V8a1.5 1.5 0 0 1 3 0v7c0 4-3 7-7 7-3 0-5-2-7-5l-2-4a1.5 1.5 0 0 1 2.5-1.5L8 15', highlight: 'M5 13l8-9 7 6-8 9zM5 13l7 6M5 13l-2 6 6-1M3 22h16', text: 'M4 4h16M12 4v16M8 20h8M4 4v3M20 4v3', comment: 'M21 14a3 3 0 0 1-3 3H8l-5 4V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3zM7 8h10M7 12h6', pen: 'M4 20l5-1L21 7l-4-4L5 15zM14 6l4 4M4 20l1-5 4 4', square: 'M4 4h16v16H4z', ellipse: 'M21 12a9 7 0 1 1-18 0 9 7 0 0 1 18 0', line: 'M4 20 20 4M3 19l2 2M19 3l2 2', signature: 'M3 17c8-9 13-14 11-14-3 0-8 16-3 14 3-2 3-5 4-3 1 2 3 1 6-2M3 21h18', image: 'M3 4h18v16H3zM3 16l6-6 5 5 3-3 4 4M17 8h.01', combine: 'M3 5h7v14H3zM14 5h7v14h-7M8 12h8M13 9l3 3-3 3', extract: 'M4 3h10v6M4 3v18h10v-6M10 12h11M17 8l4 4-4 4', copy: 'M8 8h13v13H8zM4 16H2V2h14v2', trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7', edit: 'M4 20l5-1L21 7l-4-4L5 15zM14 6l4 4M4 20l1-5 4 4', crop: 'M6 3v15h15M3 6h15v15', redact: 'M3 5h18v5H3zM3 14h18v5H3z', stamp: 'M6 16h12l3 5H3zM8 16v-3c0-2 2-3 2-5a3 3 0 1 1 4 0c0 2 2 3 2 5v3', check: 'M5 12l4 4L20 5', checkbox: 'M4 4h16v16H4zM8 12l3 3 5-6', field: 'M3 5h18v14H3zM7 9v6M10 9h7', watermark: 'M12 3C9 8 5 12 5 16a7 7 0 0 0 14 0c0-4-4-8-7-13zM9 17c0 2 2 3 4 3', numbers: 'M8 3 6 21M17 3l-2 18M3 9h18M2 15h18', save: 'M4 3h13l4 4v14H3V3zM7 3v6h9V3M7 21v-8h10v8', info: 'M12 8h.01M11 12h1v5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', settings: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2', bolt: 'M13 2 4 14h7l-1 8 10-13h-8z', arrow: 'M5 12h14M13 6l6 6-6 6', history: 'M3 11a9 9 0 1 1 3 8M3 4v7h7M12 7v5l4 2', front: 'M8 8h13v13H8zM3 15V3h12', back: 'M3 3h13v13H3zM9 21h12V9', chevron: 'M9 5l7 7-7 7'
};
export const icon = (n, cls = '') => `<svg class="${cls}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[n] ?? paths.file}"/></svg>`;
export function icons(root = document) {
    for (const el of root.querySelectorAll('[data-icon]'))
        el.innerHTML = icon(el.dataset.icon);
}
export const toolGroups = {
    all: [['Create & edit', [['Edit a PDF', 'edit', 'tab:edit', '#fdf0e5', '#d79750'], ['Add text', 'text', 'tool:text', '#edf3ff', '#5d83c9'], ['Add an image', 'image', 'action:image', '#f1edfd', '#9675c9'], ['Combine files', 'combine', 'action:merge', '#eaf4ec', '#70a378'], ['Organize pages', 'pages', 'tab:organize', '#f2edfd', '#9b78cb']]], ['Review & approve', [['Add comments', 'comment', 'tool:note', '#fff6df', '#c9a44b'], ['Highlight text', 'highlight', 'tool:highlight', '#fff6df', '#c9a44b'], ['Fill & sign', 'signature', 'tab:sign', '#e8f3f0', '#589886'], ['Redact a PDF', 'redact', 'tool:redact', '#fbecec', '#cf7674']]], ['Document tools', [['Crop pages', 'crop', 'tool:crop', '#edf3fc', '#7896c1'], ['Export a PDF', 'download', 'tab:convert', '#eaf3fb', '#6f9fc5']]]],
    edit: [['Add content', [['Add text', 'text', 'tool:text'], ['Add an image', 'image', 'action:image'], ['Rectangle', 'square', 'tool:rect'], ['Ellipse', 'ellipse', 'tool:ellipse'], ['Line', 'line', 'tool:line'], ['Freehand drawing', 'pen', 'tool:ink']]], ['Refine document', [['Crop page', 'crop', 'tool:crop'], ['Add watermark', 'watermark', 'action:watermark'], ['Add page numbers', 'numbers', 'action:page-numbers'], ['Document properties', 'settings', 'action:properties']]]],
    convert: [['Export document', [['PDF · preserve vectors', 'file', 'action:export'], ['Image-only PDF', 'image', 'action:raster'], ['Current page as PNG', 'image', 'action:png'], ['Extract plain text', 'text', 'action:text-export'], ['Comments as JSON', 'comment', 'action:comments-export']]], ['Keep editing', [['Save Folio project', 'save', 'action:project'], ['Open a project', 'folder', 'action:open']]]],
    sign: [['Fill & sign', [['Add a signature', 'signature', 'action:signature'], ['Add typed text', 'text', 'tool:text'], ['Add a check mark', 'check', 'tool:check'], ['Approval stamp', 'stamp', 'action:stamp']]], ['Prepare a form', [['Text field', 'field', 'tool:field'], ['Checkbox field', 'checkbox', 'tool:checkbox'], ['Show form fields', 'field', 'action:forms']]]],
    organize: [['Page operations', [['Insert a PDF', 'combine', 'action:merge'], ['Insert blank page', 'plus', 'action:insert-page'], ['Duplicate page', 'copy', 'action:duplicate-page'], ['Rotate clockwise', 'rotate', 'action:rotate'], ['Rotate counterclockwise', 'rotate', 'action:rotate-left'], ['Delete page', 'trash', 'action:delete-page']]], ['Export & arrange', [['Extract pages', 'extract', 'action:extract'], ['Move page', 'pages', 'action:move-page'], ['Back to document', 'file', 'action:close-organizer']]]]
};
export const toolNames = { select: 'Select', hand: 'Hand', text: 'Add text', image: 'Add image', note: 'Add comment', highlight: 'Highlight', rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', ink: 'Freehand drawing', redact: 'Mark for redaction', crop: 'Crop page', signature: 'Place signature', stamp: 'Approval stamp', check: 'Check mark', field: 'Text field', checkbox: 'Checkbox field' };
export class DialogUI {
    constructor() {
        this.el = document.querySelector('#dialog');
        this.form = document.querySelector('#dialog-form');
        this.pending = null;
        this.el.addEventListener('close', () => {
            if (this.pending) {
                this.pending(this.el.returnValue === 'ok' ? new FormData(this.form) : null);
                this.pending = null;
            }
        });
    }
    async open(title, body, { ok = 'Apply', setup } = {}) {
        if (this.el.open)
            this.el.close('cancel');
        document.querySelector('#dialog-title').textContent = title;
        document.querySelector('#dialog-body').innerHTML = body;
        document.querySelector('#dialog-ok').textContent = ok;
        this.el.returnValue = 'cancel';
        const promise = new Promise(r => this.pending = r);
        icons(this.el);
        this.el.showModal();
        setup?.(this.el);
        requestAnimationFrame(() => this.el.querySelector('#dialog-body input:not([type=checkbox]),#dialog-body textarea')?.focus());
        return promise;
    }
}
export function toast(message, error = false, duration = 4500) {
    const el = document.createElement('div');
    el.className = 'toast' + (error ? ' error' : '');
    el.textContent = message;
    document.querySelector('#toast-container').append(el);
    setTimeout(() => el.remove(), duration);
}
export async function download(bytes, name, type = 'application/octet-stream') {
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type }), url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return blob;
}
export function field(label, name, value = '', type = 'text', extra = '') {
    return `<label class="dialog-label">${escapeHTML(label)}<input type="${type}" name="${name}" value="${escapeHTML(value)}" ${extra}></label>`;
}
export async function storage(action, payload) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('folio-pro', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('workspace');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result, tx = db.transaction('workspace', action === 'get' ? 'readonly' : 'readwrite'), store = tx.objectStore('workspace');
            let req;
            if (action === 'get')
                req = store.get('last');
            else if (action === 'put')
                req = store.put(payload, 'last');
            else
                req = store.delete('last');
            let result;
            req.onsuccess = () => result = req.result;
            tx.oncomplete = () => {
                db.close();
                resolve(result);
            };
            tx.onerror = () => {
                db.close();
                reject(tx.error);
            };
        };
    });
}
