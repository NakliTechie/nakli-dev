import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const booksEntry = html.match(/\{\s*id:'books'[\s\S]*?svg:`[\s\S]*?`\s*\},/);

assert.ok(booksEntry, 'Lorewell app entry exists under the stable books id');
assert.match(booksEntry[0], /name:'Lorewell'/, 'the launcher uses the Lorewell product name');
assert.match(booksEntry[0], /kind:'system'/, 'Lorewell always stays hosted in Basic and Immersive modes');
assert.match(booksEntry[0], /Folder or Crate/, 'Lorewell launcher copy names both storage backends');
assert.match(
  booksEntry[0],
  /localhost\|127\\\.0\\\.0\\\.1/,
  'local development loads the local Books checkout for browser validation',
);
assert.match(html, /op === 'selectBackend'[\s\S]*fsHostSelectBackend/, 'host handles explicit app backend selection');
assert.match(html, /switching copies or deletes nothing/, 'host keeps backend switching non-destructive (scoped to apps/<id>/)');

console.log('NakliOS ↔ Lorewell storage bridge contract: PASS');
