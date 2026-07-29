import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

for (const retiredId of ['bahi', 'fretlocal']) {
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
