// ShowRoom — injects the catalog (and, when served, the token) into the web/index.html template.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.mjs';

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html');
const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

// `exec` is for the server only: the browser doesn't need it. `setup` powers the first-run screen.
export const publicCatalog = (catalog) => ({
  ...catalog,
  setup: {
    roots: CONFIG.roots,
    missingRoots: CONFIG.missingRoots,
    rootsSource: CONFIG.rootsSource,
    configFile: CONFIG.configFile,
  },
  projects: catalog.projects.map((p) => ({ ...p, actions: p.actions.map(({ exec, ...a }) => ({ ...a, runnable: !!exec })) })),
});

export function renderPage(catalog, token) {
  return fs.readFileSync(TEMPLATE, 'utf8')
    .replace('/*__CATALOG__*/null', () => json(publicCatalog(catalog)))
    .replace('/*__LIVE__*/null', () => json(token ? { token } : null));
}
