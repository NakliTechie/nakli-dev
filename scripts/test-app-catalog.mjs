import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

for (const retiredId of [
  'bahi',
  'fretlocal',
  'clacker',
  'mechanikon',
  'antikythera',
  'calendars',
  'karkhana',
  'tapasya',
  'dotspin',
  'hueandcry',
  'predmkt',
  'callib',
]) {
  assert.doesNotMatch(
    html,
    new RegExp(`id:'${retiredId}'`),
    `${retiredId} must not be present in the NakliOS app catalog`,
  );
  assert.doesNotMatch(
    html,
    new RegExp(`apps:\\[[^\\]]*'${retiredId}'`),
    `${retiredId} must not remain in a NakliOS desktop folder`,
  );
}

for (const [id, name] of [
  ['fld-essentials', 'Essentials'],
  ['fld-create', 'Create & Convert'],
  ['fld-research', 'Think & Research'],
  ['fld-work', 'Work & Build'],
  ['fld-privacy', 'Privacy & Security'],
  ['fld-games', 'Play'],
]) {
  assert.match(html, new RegExp(`id:'${id}'[\\s\\S]*?name:'${name}'`),
    `${name} task folder must be present`);
}
assert.match(
  html,
  /id:'fld-create'[\s\S]*?apps:\[[^\]]*'rangrez'/,
  'Rangrez remains available under Create & Convert',
);
assert.doesNotMatch(
  html,
  /id:'fld-(?:fun|utilities)'/,
  'legacy portfolio-style folders must not return',
);
assert.match(
  html,
  /state\.layout\.pinned = \['files','notes','notepad','books'\]/,
  'new profiles pin the four Essentials apps',
);
assert.match(
  html,
  /function getDesktopItems\(\)[\s\S]*?for \(const folder of FOLDERS\)[\s\S]*?if \(isInFolder\(app\.id\)\) continue/,
  'the cold desktop is task folders plus deliberate user pull-outs',
);

const appsBlock = html.slice(html.indexOf('const APPS = ['), html.indexOf('const FOLDERS = ['));
const foldersBlock = html.slice(html.indexOf('const FOLDERS = ['), html.indexOf('// Build a Set of all app ids'));
const activeAppIds = [...appsBlock.matchAll(/\{ id:'([^']+)'/g)].map(match => match[1]);
for (const appId of activeAppIds) {
  const homes = [...foldersBlock.matchAll(new RegExp(`'${appId}'`, 'g'))];
  assert.equal(homes.length, 1, `${appId} must have exactly one task-folder home`);
}

assert.match(
  html,
  /function sanitizeLayout\(layout\)[\s\S]*?filterMap\('positions', itemIds\)[\s\S]*?filterMap\('windowPositions', appIds\)/,
  'saved layouts discard orphaned desktop and window positions',
);
assert.match(
  html,
  /layout: sanitizeLayout\(JSON\.parse\(localStorage\.getItem\(LS_KEY\.layout\)/,
  'local saved layouts are sanitized on startup',
);
assert.match(
  html,
  /state\.layout = sanitizeLayout\(remote\.layout\)/,
  'newer folder-backed layouts are sanitized before hydration',
);

console.log('NakliOS app catalog exclusions: PASS');
