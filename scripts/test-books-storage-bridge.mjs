import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const booksEntry = html.match(/\{\s*id:'books'[\s\S]*?svg:`[\s\S]*?`\s*\},/);

assert.ok(booksEntry, 'Books app entry exists');
assert.match(booksEntry[0], /kind:'system'/, 'Books always stays hosted in Basic and Immersive modes');
assert.match(booksEntry[0], /Folder or Crate/, 'Books launcher copy names both storage backends');
assert.match(
  booksEntry[0],
  /localhost\|127\\\.0\\\.0\\\.1/,
  'local development loads the local Books checkout for browser validation',
);
assert.match(html, /op === 'selectBackend'[\s\S]*fsHostSelectBackend/, 'host handles explicit app backend selection');
assert.match(html, /Nothing is copied or deleted when you switch/, 'host confirms backend isolation');

console.log('NakliOS ↔ Books storage bridge contract: PASS');
