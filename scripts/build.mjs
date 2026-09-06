import { readFile, writeFile, mkdir } from 'node:fs/promises';
const root = new URL('../', import.meta.url), order = ['core', 'pdf-kernel', 'pdf-renderer', 'gpu', 'documents', 'sample', 'ui', 'app'];
let bundle = '';
for (const name of order) {
    let source = await readFile(new URL(`src/${name}.mjs`, root), 'utf8');
    source = source.replace(/^import\s+.*?\s+from\s+['"][^'"]+['"];?\s*$/gm, '').replace(/^export\s+(?=(?:async\s+)?(?:class|function|const|let|var)\b)/gm, '');
    bundle += `\n// ---- ${name}.mjs ----\n${source}\n`;
}
let html = await readFile(new URL('index.html', root), 'utf8'), css = await readFile(new URL('src/styles.css', root), 'utf8');
html = html.replace('<link rel="stylesheet" href="./src/styles.css">', `<style>\n${css}\n</style>`).replace('<script type="module" src="./src/app.mjs"></script>', () => `<script type="module">\n${bundle.replace(/<\/script/gi, '<\\/script')}\n</script>`);
await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/folio-pro.html', root), html);
await writeFile(new URL('dist/index.html', root), html);
await writeFile(new URL('dist/.nojekyll', root), '');
console.log(`Built dist/folio-pro.html (${new TextEncoder().encode(html).length} bytes, no external runtime dependencies).`);
