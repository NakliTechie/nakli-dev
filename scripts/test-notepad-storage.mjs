import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.equal(html.includes('\0'), false, 'NakliOS source must not contain literal NUL bytes');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]);
assert.equal(scripts.length, 1, 'expected one NakliOS application script');
new Function(scripts[0]);

const markdownStart = html.indexOf('function mdToHtml(src)');
const markdownEnd = html.indexOf('Classics.notepad =', markdownStart);
const mdToHtml = new Function(
  html.slice(markdownStart, markdownEnd) + '\nreturn mdToHtml;',
)();
assert.equal(
  mdToHtml('```\n<tag>&\n```'),
  '<pre><code>&lt;tag&gt;&amp;\n</code></pre>',
  'fenced Markdown code must be escaped exactly once',
);

const start = html.indexOf('Classics.notepad =');
const end = html.indexOf('// ── Calculator', start);
assert.ok(start >= 0 && end > start, 'Notepad implementation must be present');
const notepad = html.slice(start, end);

assert.match(notepad, /documents\/\$\{doc\.id\}\.json/,
  'hosted documents must use independent app-scoped files');
assert.match(notepad, /fsHostSelectBackend\(APP_ID, choice\)/,
  'Notepad must use the host-confirmed backend switch');
assert.match(notepad, /Nothing is copied or deleted/,
  'the location picker must explain backend isolation');
assert.match(notepad, /The v1 key is deliberately preserved/,
  'legacy scratchpad migration must be non-destructive');
assert.doesNotMatch(notepad, /removeItem\(LEGACY_KEY\)/,
  'legacy migration must never delete the original scratchpad');

for (const id of [
  'pad-doc-list',
  'pad-tab-list',
  'pad-tab-new',
  'pad-find-query',
  'pad-replace-query',
  'pad-go-line',
  'pad-import-input',
  'pad-save-as',
  'pad-download',
]) {
  assert.match(notepad, new RegExp(`id="${id}"`), `Notepad must include #${id}`);
}
for (const mode of ['edit', 'split', 'preview']) {
  assert.match(notepad, new RegExp(`data-mode="${mode}"`), `Notepad must include ${mode} mode`);
}
assert.match(notepad, /let openIds = \[\]/,
  'Notepad must track an open-tab session separately from stored documents');
assert.match(notepad, /async function closeTab\(id\)/,
  'Notepad tabs must be closable without deleting the stored document');
assert.match(notepad, /openIds\.splice\(index, 1\)/,
  'closing a tab must remove only the open-session entry');
assert.match(notepad, /WORKSPACE_PREFIX = 'notepad\.workspace\.v3\.'/,
  'Notepad must keep a durable IndexedDB workspace journal');
assert.match(notepad, /dirtyIds: Array\.from\(dirtyIds\)/,
  'the recovery journal must remember unsaved canonical writes');
assert.match(notepad, /recovered\.updatedAt === canonical\.updatedAt && recoveryDiffers/,
  'same-timestamp unsaved edits must not be discarded during recovery');
assert.match(notepad, /window\.showOpenFilePicker/,
  'local fallback must support durable browser file handles');
assert.match(notepad, /window\.showSaveFilePicker/,
  'local fallback must support Save As to a real file');
assert.match(notepad, /await idbSet\(doc\.localHandleKey, handle\)/,
  'local file handles must persist in IndexedDB');
assert.match(
  notepad,
  /if \(bound && BACKENDS\[bound\]\?\.isConnected\(\)\)[\s\S]*?else if \(backendsAvailable\(\)\.length\)[\s\S]*?storageId = selected \|\| 'local'/,
  'connected NakliOS storage must take priority over local recovery',
);
assert.match(notepad, /window\.addEventListener\('blur', persistSession\)/,
  'Notepad must save when browser focus is lost');
assert.match(notepad, /window\.addEventListener\('pagehide', persistSession\)/,
  'Notepad must journal its session during page shutdown');
assert.match(notepad, /win\._beforeClose = \(\) => \{[\s\S]*?persistSession\(\);[\s\S]*?\}/,
  'closing the classic window must flush canonical autosave and recovery');

console.log('NakliOS Notepad v2 storage contract: PASS');
