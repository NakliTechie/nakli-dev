import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(html, /const LAUNCH_DIAGNOSTIC_THRESHOLDS = Object\.freeze\(\{/);
assert.match(html, /loadWarningMs:\s*4000/);
assert.match(html, /readyWarningMs:\s*8000/);
assert.match(html, /fallbackMs:\s*15000/);
assert.match(
  html,
  /function launchDiagnosticsSnapshot\(\)[\s\S]*?Object\.values\(openWindows\)[\s\S]*?location:\s*`\$\{origin\}\$\{locationPath\}`[\s\S]*?sandboxed[\s\S]*?loadMs[\s\S]*?readyMs[\s\S]*?fallbackMs[\s\S]*?status/,
  'launch snapshots expose app identity, isolation, timings, and health without document data',
);
assert.match(
  html,
  /readyMs == null && loadMs != null && loadMs > LAUNCH_DIAGNOSTIC_THRESHOLDS\.loadWarningMs/,
  'a late load event does not override an earlier healthy cooperative ready signal',
);
assert.match(
  html,
  /parsed\.pathname[\s\S]*?location:\s*`\$\{origin\}\$\{locationPath\}`/,
  'query strings and fragments are omitted from machine-readable launch diagnostics',
);
assert.match(html, /return Object\.freeze\(snapshots\)/, 'the snapshot array is immutable too');
assert.match(html, /launchDiagnostics:\s*launchDiagnosticsSnapshot/);
assert.match(html, /launchDiagnosticThresholds:\s*LAUNCH_DIAGNOSTIC_THRESHOLDS/);
assert.doesNotMatch(
  html.match(/function launchDiagnosticsSnapshot\(\)\{[\s\S]*?\n\}/)?.[0] || '',
  /credential|passphrase|content|document|localStorage/i,
  'launch diagnostics do not collect app content or secrets',
);

console.log('NakliOS read-only launch diagnostics contract: PASS');
