// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const spec = readFileSync(new URL('../docs/crate-setup-handoff.md', import.meta.url), 'utf8');

for (const [index, match] of [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)].entries()) {
  if (!match[1].trim()) continue;
  assert.doesNotThrow(
    () => new vm.Script(match[1], { filename:`NakliOS-inline-${index + 1}.js` }),
    `NakliOS inline script ${index + 1} parses`,
  );
}

assert.match(html, /const CRATE_SETUP_ORIGIN = 'https:\/\/crate\.naklios\.dev'/,
  'receiver pins the canonical Crate origin');
assert.match(html, /crypto\.getRandomValues\(new Uint8Array\(24\)\)/,
  'receiver creates a 192-bit random nonce');
assert.match(html, /const CRATE_SETUP_TTL_MS = 2 \* 60 \* 1000/,
  'handoff is short lived');
assert.match(
  html,
  /event\.origin !== CRATE_SETUP_ORIGIN[\s\S]*?event\.source !== session\.iframe\.contentWindow[\s\S]*?data\.nonce !== session\.nonce/,
  'origin, source window, and nonce must all match',
);
assert.match(
  html,
  /sandbox="allow-scripts allow-forms allow-downloads allow-same-origin"[\s\S]*?referrerpolicy="no-referrer"/,
  'Crate runs in a bounded cross-origin iframe without top-navigation permission',
);
assert.doesNotMatch(
  html.match(/async function handleCrateSetupMessage[\s\S]*?window\.addEventListener\('message'/)?.[0] || '',
  /accessKey|secretKey|passphrase\s*:/,
  'receiver has no raw-key or passphrase protocol field',
);
assert.match(
  html,
  /const allowed = new Set\(\['v','type','hint','kdf','salt','iv','ct'\]\)[\s\S]*?unexpected fields/,
  'encrypted envelope rejects unrecognised plaintext fields',
);
assert.match(
  html,
  /envelope\.kdf\.algo !== 'PBKDF2-SHA256'[\s\S]*?envelope\.kdf\.iter !== 600000/,
  'receiver accepts only the current credentials KDF',
);
assert.match(html, /crateSetupBase64Length\(envelope\.salt[\s\S]*?!== 16/,
  'salt length is validated');
assert.match(html, /crateSetupBase64Length\(envelope\.iv[\s\S]*?!== 12/,
  'IV length is validated');
assert.match(
  html,
  /state\.crate \|\| await crateLoadCredsBlob\(\)[\s\S]*?Disconnect them before importing/,
  'handoff never silently replaces an existing connection',
);
assert.match(
  html,
  /await nakliosConfirm\([\s\S]*?Store encrypted setup[\s\S]*?await crateSaveCredsBlobCreateOnly\(validated\.bytes\)/,
  'validated encrypted bytes require explicit consent before storage',
);
assert.match(
  html,
  /crateSetupSession !== session \|\| Date\.now\(\) > session\.expiresAt[\s\S]*?crateSaveCredsBlobCreateOnly/,
  'expiry is revalidated after consent and before storage',
);
assert.match(
  html,
  /function crateSaveCredsBlobCreateOnly[\s\S]*?\.add\(bytes, 'crateCreds'\)[\s\S]*?ConstraintError/,
  'handoff storage atomically refuses to overwrite an existing credential blob',
);
assert.match(html, /await crateInteractiveUnlock\(\)/,
  'passphrase entry stays in NakliOS after import');
assert.match(html, /id="crate-connect-handoff"[\s\S]*?Set up Crate/,
  'Settings exposes the receiver as the primary connect action');

for (const phrase of [
  'The only accepted payload is the existing encrypted `.crate-creds` v1 JSON',
  'No decrypted credential fields',
  'Sender acceptance gate',
  'targets that origin rather than',
  'Ordinary standalone Crate setup',
]) {
  assert.ok(spec.includes(phrase), `handoff standard documents: ${phrase}`);
}

console.log('NakliOS Crate setup handoff receiver: PASS');
