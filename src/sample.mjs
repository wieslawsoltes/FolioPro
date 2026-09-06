import { PDFWriter, N, S } from './pdf-kernel.mjs';
import { ascii } from './core.mjs';
import { pdfLiteral, rgbOps, num } from './pdf-kernel.mjs';
class Page {
    constructor() {
        this.ops = [];
    }
    rect(x, y, w, h, c) {
        this.ops.push(`${rgbOps(c)} rg ${x} ${792 - y - h} ${w} ${h} re f`);
        return this;
    }
    line(x, y, x2, y2, c = '#d8dde5', sw = 1) {
        this.ops.push(`${rgbOps(c)} RG ${sw} w ${x} ${792 - y} m ${x2} ${792 - y2} l S`);
        return this;
    }
    text(t, x, y, size = 12, c = '#243348', font = 'FR') {
        this.ops.push(`${rgbOps(c)} rg BT /${font} ${size} Tf 1 0 0 1 ${x} ${792 - y - size} Tm ${pdfLiteral(t)} Tj ET`);
        return this;
    }
    para(lines, x, y, size = 11, c = '#667080', leading = 17) {
        lines.forEach((t, i) => this.text(t, x, y + i * leading, size, c));
        return this;
    }
    circle(cx, cy, r, c) {
        const y = 792 - cy, k = .55228475 * r;
        this.ops.push(`${rgbOps(c)} rg ${cx + r} ${y} m ${cx + r} ${y + k} ${cx + k} ${y + r} ${cx} ${y + r} c ${cx - k} ${y + r} ${cx - r} ${y + k} ${cx - r} ${y} c ${cx - r} ${y - k} ${cx - k} ${y - r} ${cx} ${y - r} c ${cx + k} ${y - r} ${cx + r} ${y - k} ${cx + r} ${y} c f`);
        return this;
    }
    header(n, title) {
        this.text('NORTHSTAR', 48, 32, 12, '#243348', 'FB').text('STRATEGY & OUTLOOK / 2026', 355, 36, 8, '#738093');
        this.line(48, 64, 564, 64);
        this.text(title, 48, 91, 29, '#243348', 'FB');
        this.line(48, 734, 564, 734);
        this.text('NORTHSTAR  /  ILLUSTRATIVE STRATEGY BRIEF', 48, 751, 7, '#84909e').text(String(n).padStart(2, '0'), 550, 748, 10, '#243348');
        return this;
    }
    bytes() {
        return ascii(this.ops.join('\n'));
    }
}
export async function createSample() {
    const w = new PDFWriter(), root = w.reserve(), pr = w.reserve(), fonts = { FR: w.font('Helvetica'), FB: w.font('Helvetica-Bold'), FI: w.font('Times-Italic') }, pages = [];
    const p1 = new Page().rect(0, 0, 612, 792, '#ffffff');
    p1.text('NORTHSTAR', 48, 40, 15, '#25334a', 'FB').text('STRATEGY & OUTLOOK', 395, 45, 8, '#7a8493').line(48, 82, 564, 82);
    p1.rect(48, 119, 93, 23, '#f3eee8').text('THE 2026 EDITION', 58, 126, 7, '#8c6551', 'FB');
    p1.text('Clear direction.', 48, 170, 42, '#25334a', 'FB').text('Lasting impact.', 48, 221, 42, '#25334a', 'FB');
    p1.para(['A considered approach to what comes next.', 'Our priorities, our progress, and the possibilities ahead.'], 50, 291, 12, '#697585', 20);
    p1.rect(48, 360, 516, 242, '#263449').rect(48, 580, 516, 22, '#ed7759');
    p1.circle(429, 481, 96, '#ed7759').circle(429, 481, 72, '#eea284').circle(429, 481, 49, '#f6c7ad');
    p1.rect(301, 479, 263, 101, '#263449');
    for (let i = 0; i < 7; i++)
        p1.line(291 + i * 34, 480, 215 + i * 48, 580, '#7c8797', .6);
    for (let i = 0; i < 4; i++)
        p1.line(276, 497 + i * 24, 564, 497 + i * 24, '#7c8797', .6);
    p1.text('A clearer view', 74, 395, 23, '#ffffff', 'FB').text('of tomorrow.', 74, 425, 23, '#ffffff', 'FB').para(['Built on purpose.', 'Designed for progress.'], 76, 476, 10, '#b7c1cf', 17);
    p1.text('2026', 48, 642, 32, '#25334a', 'FB').text('ANNUAL STRATEGY BRIEF', 180, 652, 9, '#25334a', 'FB').text('Prepared for the leadership team', 180, 674, 10, '#7a8593');
    p1.line(48, 731, 564, 731).text('NORTHSTAR  /  EXAMPLE DOCUMENT', 48, 751, 7, '#84909e').text('01', 550, 748, 10, '#25334a');
    pages.push(p1);
    const p2 = new Page().header(2, 'Progress with purpose.').text('EXECUTIVE SUMMARY', 48, 140, 8, '#e47c60', 'FB');
    p2.para(['Strong foundations create room for bold decisions. This year, our focus is', 'on doing fewer things exceptionally well: serving our customers, investing', 'in our people, and building a business that is ready for the future.'], 48, 164, 12, '#5c6b7d', 20);
    for (const [k, v, label] of [[0, '24%', 'Revenue growth'], [1, '92%', 'Customer satisfaction'], [2, '18', 'Markets served']]) {
        const x = 48 + k * 176;
        p2.rect(x, 246, 164, 106, '#f3f5f7').text(v, x + 16, 263, 32, '#25334a', 'FB').text(label, x + 16, 313, 9, '#758092');
    }
    p2.text('A year of steady momentum', 48, 386, 19, '#25334a', 'FB').text('Illustrative performance index', 48, 417, 10, '#758092');
    for (let i = 0; i < 4; i++) {
        const y = 455 + i * 48;
        p2.line(70, y, 558, y, '#e5e9ee', .6).text(String(160 - i * 40), 48, y - 5, 7, '#8993a0');
    }
    const vals = [63, 84, 109, 126, 142, 174];
    vals.forEach((v, i) => {
        const x = 92 + i * 76;
        p2.rect(x, 646 - v, 32, v, i === 5 ? '#ed7759' : '#8094ad').text(['JAN', 'MAR', 'MAY', 'JUL', 'SEP', 'NOV'][i], x + 1, 657, 7, '#7a8493');
    });
    p2.text('All figures are fictional and shown for demonstration.', 48, 701, 8, '#98a0ac');
    pages.push(p2);
    const p3 = new Page().header(3, 'Three priorities. One direction.').para(['Our next chapter is defined by focused investment, measurable outcomes,', 'and a shared commitment to making work better.'], 48, 143, 11, '#667384', 18);
    const priorities = [['01', 'Put customers first.', 'Listen closely. Deliver consistently.', ['Expand customer research across every market.', 'Make product journeys simpler and more useful.', 'Measure success through long-term relationships.']], ['02', 'Build for what is next.', 'Turn ambition into durable capability.', ['Invest in resilient systems and shared platforms.', 'Create space for experimentation and learning.', 'Bring the best ideas into everyday operations.']], ['03', 'Grow together.', 'Make progress a team sport.', ['Develop leaders at every level of the organization.', 'Make knowledge easier to share and discover.', 'Connect individual growth with business impact.']]];
    priorities.forEach(([n, title, sub, ls], i) => {
        const y = 211 + i * 154;
        p3.rect(48, y, 39, 36, '#fbece5').text(n, 56, y + 8, 15, '#d66b4f', 'FB').text(title, 107, y, 19, '#25334a', 'FB').text(sub, 107, y + 31, 11, '#7b8796');
        ls.forEach((s, j) => p3.text('-  ' + s, 107, y + 61 + j * 18, 10, '#59687a'));
        if (i < 2)
            p3.line(107, y + 135, 564, y + 135);
    });
    pages.push(p3);
    const p4 = new Page().header(4, 'From intention to action.').text('2026 DELIVERY ROADMAP', 48, 144, 8, '#e47c60', 'FB');
    const cols = [48, 218, 339, 458, 564];
    p4.rect(48, 176, 516, 35, '#263449').text('WORKSTREAM', 61, 187, 9, '#ffffff', 'FB').text('OWNER', 231, 187, 9, '#ffffff', 'FB').text('TIMING', 352, 187, 9, '#ffffff', 'FB').text('STATUS', 471, 187, 9, '#ffffff', 'FB');
    [['Customer discovery', 'Product team', 'Q1 - Q2', 'On track'], ['Platform foundations', 'Engineering', 'Q1 - Q3', 'On track'], ['Leadership program', 'People team', 'Q2 - Q4', 'Planning'], ['Market expansion', 'Strategy', 'Q3 - Q4', 'Planning']].forEach((row, i) => {
        const y = 211 + i * 44;
        p4.rect(48, y, 516, 44, i % 2 ? '#ffffff' : '#f3f5f7');
        row.forEach((t, j) => p4.text(t, cols[j] + 13, y + 15, 9, j === 3 ? '#387461' : '#5d6c7f'));
        p4.line(48, y + 44, 564, y + 44, '#e3e7ec', .6);
    });
    p4.text('Review & approval', 48, 435, 24, '#25334a', 'FB').para(['Complete the fields below and add a visual signature to confirm review.', 'This sample is not a legal agreement.'], 48, 475, 10, '#768293', 17);
    p4.text('REVIEWER NAME', 48, 531, 8, '#67768a', 'FB').text('DEPARTMENT', 320, 531, 8, '#67768a', 'FB');
    p4.text('I have reviewed the strategy and delivery priorities.', 77, 613, 11, '#5e6e80');
    p4.line(48, 692, 300, 692, '#aab6c5').text('Signature', 48, 702, 8, '#8995a4').line(360, 692, 564, 692, '#aab6c5').text('Date', 360, 702, 8, '#8995a4');
    pages.push(p4);
    const refs = [], fields = [];
    for (let i = 0; i < pages.length; i++) {
        const ref = w.reserve();
        refs.push(ref);
        const contents = await w.stream({}, pages[i].bytes());
        const d = { Type: N('Page'), Parent: pr, MediaBox: [0, 0, 612, 792], Resources: { Font: fonts }, Contents: contents };
        if (i === 3) {
            const annotations = [];
            for (const [f, x, y, width] of [['Reviewer', 48, 550, 240], ['Department', 320, 550, 244]]) {
                const height = 31, ap = await w.stream({ Type: N('XObject'), Subtype: N('Form'), BBox: [0, 0, width, height], Resources: { Font: fonts } }, ascii(`q .96 .97 .99 rg .7 .76 .84 RG .6 w 0 0 ${width} ${height} re B Q`));
                const field = w.add({ Type: N('Annot'), Subtype: N('Widget'), FT: N('Tx'), T: S(f), V: S(''), Rect: [x, 792 - y - height, x + width, 792 - y], P: ref, F: 4, DA: S('/FR 12 Tf .15 .2 .28 rg'), AP: { N: ap } });
                annotations.push(field);
                fields.push(field);
            }
            const off = await w.stream({ Type: N('XObject'), Subtype: N('Form'), BBox: [0, 0, 17, 17], Resources: { Font: fonts } }, ascii('q 1 1 1 rg .7 .76 .84 RG .6 w 0 0 17 17 re B Q')), on = await w.stream({ Type: N('XObject'), Subtype: N('Form'), BBox: [0, 0, 17, 17], Resources: { Font: fonts } }, ascii('q 1 1 1 rg .7 .76 .84 RG .6 w 0 0 17 17 re B .2 .3 .4 rg BT /FB 12 Tf 1 0 0 1 4 4 Tm (X) Tj ET Q'));
            const field = w.add({ Type: N('Annot'), Subtype: N('Widget'), FT: N('Btn'), T: S('Reviewed'), V: N('Off'), AS: N('Off'), Rect: [48, 792 - 628, 65, 792 - 611], P: ref, F: 4, AP: { N: { Off: off, Yes: on } } });
            fields.push(field);
            annotations.push(field);
            d.Annots = annotations;
        }
        w.set(ref, d);
    }
    w.set(pr, { Type: N('Pages'), Kids: refs, Count: refs.length });
    const outlineRoot = w.reserve(), outlineRefs = pages.map(() => w.reserve());
    for (let i = 0; i < pages.length; i++)
        w.set(outlineRefs[i], { Title: S(['Strategy & outlook', 'Executive summary', 'Strategic priorities', 'Review & approval'][i]), Parent: outlineRoot, Dest: [refs[i], N('Fit')], ...(i ? { Prev: outlineRefs[i - 1] } : {}), ...(i < 3 ? { Next: outlineRefs[i + 1] } : {}) });
    w.set(outlineRoot, { Type: N('Outlines'), First: outlineRefs[0], Last: outlineRefs[3], Count: 4 });
    w.set(root, { Type: N('Catalog'), Pages: pr, Outlines: outlineRoot, AcroForm: w.add({ Fields: fields, DR: { Font: fonts }, DA: S('/FR 12 Tf 0 g'), NeedAppearances: false }) });
    return w.save(root, w.add({ Title: S('Northstar - Strategy & Outlook 2026'), Author: S('Northstar Studio'), Subject: S('Illustrative strategy brief - fictional content'), Producer: S('Folio Pro demo document') }));
}
