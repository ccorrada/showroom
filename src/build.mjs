// ShowRoom — writes catalog.json and a self-contained index.html (no server needed).
import fs from 'node:fs';
import path from 'node:path';
import { renderPage } from './page.mjs';
import { scan, applyCuration, readCuration, CONFIG } from './scan.mjs';
import { generateThumbs, withImages } from './images.mjs';
import { readLinks, withLinks } from './links.mjs';

const t0 = Date.now();
if (!CONFIG.roots.length) {
  console.error(`No project folders found. Set "roots" in ${CONFIG.configFile} or SHOWROOM_ROOTS (see README).`);
}
const curated = applyCuration(withLinks(scan(), readLinks()), readCuration());
await generateThumbs(curated.projects);
const catalog = withImages(curated);

fs.mkdirSync(CONFIG.outDir, { recursive: true });
fs.writeFileSync(path.join(CONFIG.outDir, 'catalog.json'), JSON.stringify(catalog, null, 2));

const out = path.join(CONFIG.outDir, 'index.html');
fs.writeFileSync(out, renderPage(catalog, null));

const ps = catalog.projects;
const count = (f) => ps.filter(f).length;
console.log(`${ps.length} projects (${count((p) => !p.archived)} active, ${count((p) => p.archived)} archived) in ${Date.now() - t0} ms`);
console.log(`  roots:                    ${CONFIG.roots.join(', ') || '—'} (${CONFIG.rootsSource})`);
console.log(`  with a description:       ${count((p) => p.descriptionSource !== 'auto')}`);
console.log(`  with Claude sessions:     ${count((p) => p.sessionCount > 0)}`);
console.log(`  with an image:            ${count((p) => p.image)}`);
console.log(`  link cards:               ${count((p) => p.kind === 'link')}`);
console.log(`→ ${out}`);
