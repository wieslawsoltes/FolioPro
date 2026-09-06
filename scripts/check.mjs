import { readdir, readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = new URL('../', import.meta.url);
for (const name of await readdir(new URL('src/', root))) {
    if (!name.endsWith('.mjs'))
        continue;
    const result = spawnSync(process.execPath, ['--check', new URL(`src/${name}`, root).pathname], { stdio: 'inherit' });
    if (result.status)
        process.exit(result.status);
}
const dir = await mkdtemp(path.join(tmpdir(), 'folio-check-'));
try {
    const html = await readFile(new URL('dist/folio-pro.html', root), 'utf8');
    const code = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
    if (!code)
        throw Error('Missing standalone entry point');
    const file = path.join(dir, 'standalone.mjs');
    await writeFile(file, code);
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status)
        process.exit(result.status);
    console.log('All source modules and the standalone bundle pass syntax checks.');
}
finally {
    await rm(dir, { recursive: true, force: true });
}
