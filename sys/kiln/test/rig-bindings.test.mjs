// K2 (A1) conformance — the `rig` Python bindings are generated from the
// registry, headlessly. No Pyodide: we assert the generated manifest + source
// against registry metadata.
//
//   node sys/kiln/test/rig-bindings.test.mjs

import { createFileops, MemoryBackend } from '../../rig/fileops/index.mjs';
import { createGitCore } from '../../rig/git/git-core.mjs';
import { buildRigRegistry } from '../../rig/registry/index.mjs';
import { generateRigModule } from '../rig-bindings.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; } catch (e) { failures.push({ name, message: e.message }); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

function build() {
  const fs = createFileops({ backend: new MemoryBackend() });
  const git = createGitCore({ fs, dir: '/' });
  const registry = buildRigRegistry({ fs, git });
  return { registry, gen: generateRigModule(registry) };
}

await test('every registry command has exactly one generated binding', async () => {
  const { registry, gen } = build();
  eq(gen.manifest.length, registry.commands.length, 'one binding per command');
  const cmds = new Set(registry.commands.map((c) => c.name));
  for (const b of gen.manifest) assert(cmds.has(b.command), `binding for unknown command ${b.command}`);
  for (const c of registry.commands) assert(gen.manifest.some((b) => b.command === c.name), `missing binding for ${c.name}`);
});

await test('naming: fs.* flattens, other namespaces nest', async () => {
  const { gen } = build();
  const by = Object.fromEntries(gen.manifest.map((b) => [b.command, b]));
  eq(by['fs.read'].pyName, 'read', 'fs.read → rig.read');
  eq(by['fs.read'].nested, false, 'fs flattens');
  eq(by['git.status'].pyName, 'git.status', 'git.status → rig.git.status');
  eq(by['git.status'].nested, true, 'git nests');
  eq(by['git.commit'].namespace, 'git', 'git namespace');
});

await test('generated signatures match the declared inputSchema', async () => {
  const { registry, gen } = build();
  const byName = new Map(registry.commands.map((c) => [c.name, c]));
  for (const b of gen.manifest) {
    const cmd = byName.get(b.command);
    const props = Object.keys((cmd.inputSchema && cmd.inputSchema.properties) || {});
    const required = (cmd.inputSchema && cmd.inputSchema.required) || [];
    const paramKeys = b.params.map((p) => p.key).sort();
    eq(JSON.stringify(paramKeys), JSON.stringify(props.slice().sort()), `${b.command}: params match schema properties`);
    const reqParams = b.params.filter((p) => p.required).map((p) => p.key).sort();
    eq(JSON.stringify(reqParams), JSON.stringify(required.slice().sort()), `${b.command}: required params match`);
  }
});

await test('docstrings are the registry text (no hand-written help)', async () => {
  const { registry, gen } = build();
  const byName = new Map(registry.commands.map((c) => [c.name, c]));
  for (const b of gen.manifest) {
    const cmd = byName.get(b.command);
    eq(b.doc, cmd.description || cmd.summary || '', `${b.command}: doc is registry text`);
  }
});

await test('destructive commands are flagged in the binding + docstring', async () => {
  const { registry, gen } = build();
  const byName = new Map(registry.commands.map((c) => [c.name, c]));
  for (const b of gen.manifest) eq(b.destructive, !!byName.get(b.command).destructive, `${b.command}: destructive flag`);
  // and the source annotates them
  const { gen: g2 } = build();
  assert(/Destructive — returns a staged proposal/.test(g2.source), 'source notes destructive staging');
});

await test('Python reserved-word params are escaped (fs.move from → from_)', async () => {
  const { gen } = build();
  const move = gen.manifest.find((b) => b.command === 'fs.move');
  const fromParam = move.params.find((p) => p.key === 'from');
  assert(fromParam, 'fs.move has a `from` param');
  eq(fromParam.py, 'from_', 'from → from_ in the Python signature');
  // and the call maps it back to the real key
  assert(/"from": from_/.test(gen.source), 'source maps from_ back to "from"');
});

await test('source structure: top-level defs, a git class, and rig.git binding', async () => {
  const { gen } = build();
  assert(/^def read\(/m.test(gen.source), 'def read(');
  assert(/^def write\(/m.test(gen.source), 'def write(');
  assert(/class _Git:/.test(gen.source), 'class _Git');
  assert(/^\s+def status\(self/m.test(gen.source), 'git.status method with self');
  assert(/^git = _Git\(\)/m.test(gen.source), 'git = _Git()');
  assert(/class RigGrantError\(RigError\)/.test(gen.source), 'RigGrantError defined');
  assert(/_rig_call\(/.test(gen.source), 'forwards to _rig_call');
});

const total = passed + failures.length;
if (failures.length === 0) { console.log(`K2/rig-bindings conformance: ${passed}/${total} passed`); process.exit(0); }
else { console.log(`K2/rig-bindings conformance: ${passed}/${total} passed, ${failures.length} FAILED`); for (const f of failures) console.log(`  ✗ ${f.name}: ${f.message}`); process.exit(1); }
