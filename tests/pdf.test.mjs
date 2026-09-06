import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { PDFSyntax, PDFSource, PDFWriter, N, R, S, ST, decodeStream, deflate, serialize, stringText, unicodeString, name } from '../src/pdf-kernel.mjs';
import { ascii, latin1, concatBytes } from '../src/core.mjs';
import { blankState, makePage, exportVector, exportRaster, getWidgets } from '../src/documents.mjs';
import { createSample } from '../src/sample.mjs';
const parse = s => new PDFSyntax(ascii(s)).value();
async function sample() {
    const source = await PDFSource.load(await createSample(), 'sample.pdf'), sources = new Map([['source', source]]), state = { name: 'sample.pdf', metadata: source.metadata, fieldValues: {}, pages: source.pages.map(p => makePage('source', p.index, p)) };
    return { source, sources, state };
}
async function minimal(extra = {}) {
    const w = new PDFWriter(), root = w.reserve(), tree = w.reserve(), contents = await w.stream({}, ascii('BT /F 12 Tf 10 20 Td (Hello) Tj ET'));
    const page = w.add({ Type: N('Page'), Parent: tree, MediaBox: [10, 20, 310, 420], Resources: { Font: { F: w.font() } }, Contents: contents, ...extra.page });
    w.set(tree, { Type: N('Pages'), Kids: [page], Count: 1, ...extra.tree });
    w.set(root, { Type: N('Catalog'), Pages: tree, ...extra.catalog });
    return { w, root, page, bytes: w.save(root) };
}
test('Lexer names, escaped/nested literal strings, hex and references', () => {
    assert.equal(name(parse('/A#20B')), 'A B');
    assert.equal(stringText(parse('(a\\(b\\)\\n\\101)')), 'a(b)\nA');
    assert.equal(stringText(parse('(a(b)c)')), 'a(b)c');
    assert.deepEqual(parse('17 2 R'), R(17, 2));
    assert.equal(stringText(parse('<4142F>')), 'ABð');
    assert.equal(parse('1.5'), 1.5);
});
test('Lexer dictionaries and array parsing', () => {
    const d = parse('<< /A [1 -2 .5 true false null] /B (ok) >>');
    assert.deepEqual(d.A, [1, -2, .5, true, false, null]);
    assert.equal(stringText(d.B), 'ok');
});
test('Unicode PDF string encoding round trip', () => {
    assert.equal(stringText(unicodeString('Folio — Zażółć 日本語')), 'Folio — Zażółć 日本語');
});
test('Parser rejects malformed syntax', () => {
    for (const s of ['(unfinished', '[1 2', '<< /A 1', '<AB'])
        assert.throws(() => parse(s));
});
test('Serializer preserves escaping and rejects non-finite values', () => {
    assert.equal(name(parse(serialize(N('A/B C')))), 'A/B C');
    assert.throws(() => serialize(Infinity));
});
test('Flate stream round trip', async () => {
    const input = ascii('PDF stream\n'.repeat(1000));
    assert.deepEqual(await decodeStream(ST({ Filter: N('FlateDecode') }, await deflate(input))), input);
});
test('ASCII85 zero shortcut and known payload', async () => {
    assert.equal(latin1(await decodeStream(ST({ Filter: N('ASCII85Decode') }, ascii('87cURD_*#TDfTZ)+T~>')))), 'Hello, world!');
    assert.deepEqual(await decodeStream(ST({ Filter: N('ASCII85Decode') }, ascii('z~>'))), new Uint8Array(4));
});
test('ASCIIHex and RunLength streams', async () => {
    assert.equal(latin1(await decodeStream(ST({ Filter: N('ASCIIHexDecode') }, ascii('48 65 6c6c6f>')))), 'Hello');
    assert.equal(latin1(await decodeStream(ST({ Filter: N('RunLengthDecode') }, new Uint8Array([2, 65, 66, 67, 254, 90, 128])))), 'ABCZZZ');
});
test('PNG predictor reconstructs Sub and Up rows', async () => {
    const raw = new Uint8Array([1, 10, 10, 10, 2, 1, 2, 3]);
    const result = await decodeStream(ST({ Filter: N('FlateDecode'), DecodeParms: { Predictor: 15, Columns: 3, Colors: 1, BitsPerComponent: 8 } }, await deflate(raw)));
    assert.deepEqual([...result], [10, 20, 30, 11, 22, 33]);
});
test('TIFF predictor reconstructs RGB components', async () => {
    const result = await decodeStream(ST({ Filter: N('FlateDecode'), DecodeParms: { Predictor: 2, Columns: 2, Colors: 3, BitsPerComponent: 8 } }, await deflate(new Uint8Array([10, 20, 30, 1, 2, 3]))));
    assert.deepEqual([...result], [10, 20, 30, 11, 22, 33]);
});
test('Unsupported stream codecs fail explicitly', async () => {
    await assert.rejects(() => decodeStream(ST({ Filter: N('JBIG2Decode') }, new Uint8Array())), /Unsupported/);
});
test('Sample is a real four-page PDF with metadata and bookmarks', async () => {
    const { source } = await sample();
    assert.equal(source.pages.length, 4);
    assert.match(source.metadata.title, /Northstar/);
    assert.equal((await source.outline()).length, 4);
    assert.match(latin1(await source.content(source.pages[0])), /Clear direction/);
});
test('Sample exposes genuine AcroForm widgets', async () => {
    const { source } = await sample();
    const widgets = await getWidgets(source, 3);
    assert.deepEqual(widgets.map(w => w.name), ['Reviewer', 'Department', 'Reviewed']);
    assert.deepEqual(widgets.map(w => w.type), ['Tx', 'Tx', 'Btn']);
    assert.equal(widgets[2].value, false);
});
test('Concurrent lazy resolution shares objects without false cycles', async () => {
    const { source } = await sample();
    const contents = source.pages[0].node.Contents;
    source.objects.delete(contents.id);
    const all = await Promise.all(Array.from({ length: 20 }, () => source.resolve(contents)));
    assert.ok(all.every(x => x === all[0]));
});
test('Inherited geometry and UserUnit produce normalized coordinates', async () => {
    const { bytes } = await minimal({ page: { Rotate: 90, UserUnit: 2 } }), source = await PDFSource.load(bytes);
    assert.equal(source.pages[0].width, 800);
    assert.equal(source.pages[0].height, 600);
});
test('Malformed, encrypted and XFA inputs reject', async () => {
    await assert.rejects(() => PDFSource.load(ascii('not a PDF')), /not a PDF/);
    await assert.rejects(() => PDFSource.load(ascii('%PDF-1.7\n')), /cross-reference/);
    const { w, root } = await minimal();
    const encrypted = latin1(w.save(root)).replace('/Root ', '/Encrypt <<>>\n/Root ');
    await assert.rejects(() => PDFSource.load(ascii(encrypted)), /Encrypted/);
    const xfa = await minimal({ catalog: { AcroForm: { XFA: S('unsupported') } } });
    await assert.rejects(() => PDFSource.load(xfa.bytes), /XFA/);
});
test('Vector export preserves source resources and writes genuine notes', async () => {
    const { state, sources } = await sample();
    state.pages[0].annotations.push({ id: 'added', type: 'text', x: 50, y: 70, w: 140, h: 20, text: 'Added text', fontSize: 15, color: '#112233' }, { id: 'note', type: 'note', x: 30, y: 30, w: 24, h: 24, text: 'Zażółć 日本語', author: 'Reviewer' });
    const bytes = await exportVector(state, sources), out = await PDFSource.load(bytes);
    assert.equal(out.pages.length, 4);
    const content = latin1(await out.content(out.pages[0]));
    assert.match(content, /Original Do/);
    assert.match(content, /Added text/);
    const annotations = await out.annotations(out.pages[0]);
    assert.equal(stringText(annotations[0].Contents), 'Zażółć 日本語');
    await mkdir(new URL('out/', import.meta.url), { recursive: true });
    await writeFile(new URL('out/vector.pdf', import.meta.url), bytes);
});
test('Rotate, crop, extract and reorder are written into page structure', async () => {
    const { state, sources } = await sample();
    state.pages[1].crop = { x: 50, y: 40, w: 500, h: 700 };
    state.pages[1].rotation = 90;
    const out = await PDFSource.load(await exportVector(state, sources, { indices: [1, 0] }));
    assert.equal(out.pages.length, 2);
    assert.equal(out.pages[0].rotation, 90);
    assert.deepEqual(out.pages[0].box, [0, 0, 500, 700]);
    assert.equal(out.pages[0].width, 700);
});
test('Source form overrides are flattened into explicit content', async () => {
    const { state, sources } = await sample();
    state.fieldValues['source:Reviewer'] = 'Ada Lovelace';
    const out = await PDFSource.load(await exportVector(state, sources)), xo = await out.resolve(out.pages[3].resources.XObject), original = await out.resolve(xo.Original);
    assert.match(latin1(await decodeStream(original)), /Ada Lovelace/);
});
test('New text and checkbox fields remain interactive and have both states', async () => {
    const state = blankState();
    state.pages[0].annotations.push({ id: 'text', type: 'field', x: 20, y: 30, w: 100, h: 25, name: 'Name', text: 'Ada', fontSize: 12 }, { id: 'check', type: 'check', x: 20, y: 80, w: 18, h: 18, name: 'Accept', checked: false });
    const out = await PDFSource.load(await exportVector(state, new Map()));
    assert.equal((await out.resolve(out.catalog.AcroForm)).Fields.length, 2);
    const fields = await getWidgets(out, 0);
    assert.equal(fields[0].value, 'Ada');
    const ap = await out.resolve(fields[1].annotation.AP), yes = await out.resolve(ap.N.Yes), off = await out.resolve(ap.N.Off);
    assert.notDeepEqual(yes.bytes, off.bytes);
});
test('Pending redaction prevents vector export', async () => {
    const state = blankState();
    state.pages[0].annotations.push({ id: 'r', type: 'redact', x: 1, y: 1, w: 10, h: 10 });
    await assert.rejects(() => exportVector(state, new Map()), /pending redactions/);
});
test('Pending redaction requires explicit raster authorization', async () => {
    const state = blankState();
    state.pages[0].annotations.push({ id: 'r', type: 'redact', x: 1, y: 1, w: 10, h: 10 });
    await assert.rejects(() => exportRaster(state, new Map(), null), /Pending redactions/);
});
test('Unsupported vector text does not silently corrupt Unicode', async () => {
    const state = blankState();
    state.pages[0].annotations.push({ id: 't', type: 'text', x: 1, y: 1, w: 100, h: 20, text: '日本語' });
    await assert.rejects(() => exportVector(state, new Map()), /Latin-1/);
    state.pages[0].annotations = [];
    state.fieldValues = { field: 'Zażółć' };
    await assert.rejects(() => exportVector(state, new Map()), /Latin-1/);
});
test('Vector export writes opacity graphics state', async () => {
    const state = blankState();
    state.pages[0].annotations.push({ id: 't', type: 'text', x: 1, y: 1, w: 100, h: 20, text: 'DRAFT', opacity: .18 });
    const out = await PDFSource.load(await exportVector(state, new Map())), gs = await out.resolve(out.pages[0].resources.ExtGState);
    assert.equal((await out.resolve(gs.Alpha1)).ca, .18);
});
