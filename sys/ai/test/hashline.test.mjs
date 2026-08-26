// Conformance — omp hashline edits (content-hash-anchored line edits).
//
//   node sys/ai/test/hashline.test.mjs
//
// Covers the pure engine (tag, render, parse, apply, stale rejection) and a full
// read → edit → re-read cycle with tag validation, plus the read_lines/edit_lines
// tools over a real Rig face.

import { hashTag, renderHashline, parseHashlineEdit, applyHashlineEdit, applyHashlineBlock } from '../hashline.mjs';
import { makeToolExecutor, codingToolset } from '../agent-tools.mjs';
import { createFileops, MemoryBackend } from '../../rig/fileops/index.mjs';
import { buildRigRegistry } from '../../rig/registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../rig/agent/index.mjs';
import { createShell } from '../../rig/cli/shell.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) { try { await fn(); passed++; } catch (e) { failures.push({ name, message: e.message }); } }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }

function fresh() {
  const backend = new MemoryBackend();
  const fs = createFileops({ backend });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
  const shell = createShell({ registry, face });
  return { face, shell, exec: makeToolExecutor({ shell, face }) };
}

// ── tag + render ────────────────────────────────────────────────────────
await test('hashTag is deterministic, 4 uppercase hex, and change-sensitive', () => {
  const t = hashTag('hello\nworld');
  assert(/^[0-9A-F]{4}$/.test(t), `4 uppercase hex: ${t}`);
  eq(hashTag('hello\nworld'), t, 'stable for identical content');
  assert(hashTag('hello\nworld!') !== t, 'changes when content changes');
});

await test('renderHashline emits [path#TAG] + 1-indexed rows', () => {
  const out = renderHashline('a.py', 'def f():\n    return 1');
  const lines = out.split('\n');
  assert(/^\[a\.py#[0-9A-F]{4}\]$/.test(lines[0]), `header: ${lines[0]}`);
  eq(lines[1], '1: def f():', 'row 1');
  eq(lines[2], '2:     return 1', 'row 2');
});

// ── parse ─────────────────────────────────────────────────────────────
await test('parseHashlineEdit reads header + all op kinds', () => {
  const block = ['[f.txt#0A1B]', 'PUT 1.=2:', '+new1', '+new2', 'PUT <3:', '+before', 'PUT >4:', '+after', 'PUT >$:', '+end', 'CUT 5.=6'].join('\n');
  const r = parseHashlineEdit(block);
  assert(r.ok, r.error);
  eq(r.path, 'f.txt', 'path'); eq(r.tag, '0A1B', 'tag');
  eq(r.ops.length, 5, 'five ops');
  eq(r.ops[0].kind, 'replace', 'replace'); eq(JSON.stringify(r.ops[0].body), JSON.stringify(['new1', 'new2']), 'replace body');
  eq(r.ops[1].kind, 'insert-before', 'insert-before');
  eq(r.ops[2].kind, 'insert-after', 'insert-after');
  eq(r.ops[3].kind, 'append', 'append');
  eq(r.ops[4].kind, 'cut', 'cut');
});

await test('parseHashlineEdit rejects a bad header and block mode', () => {
  assert(!parseHashlineEdit('PUT 1.=1:\n+x').ok, 'no header → rejected');
  assert(!parseHashlineEdit('[f#0A1B]\nPUT 1*:\n+x').ok, 'block mode rejected');
});

// ── apply + stale rejection ─────────────────────────────────────────────
await test('applyHashlineEdit replaces a line range against the correct tag', () => {
  const content = 'a\nb\nc\nd';
  const tag = hashTag(content);
  const r = applyHashlineEdit(content, tag, [{ kind: 'replace', a: 2, b: 3, body: ['B', 'C', 'C2'] }]);
  assert(r.ok, r.error);
  eq(r.content, 'a\nB\nC\nC2\nd', 'range replaced, numbering preserved');
});

await test('applyHashlineEdit applies multi-op against ORIGINAL line numbers', () => {
  const content = 'one\ntwo\nthree';
  const tag = hashTag(content);
  const r = applyHashlineEdit(content, tag, [
    { kind: 'replace', a: 1, b: 1, body: ['ONE'] },
    { kind: 'insert-after', a: 2, body: ['2.5'] },
    { kind: 'append', body: ['four'] },
  ]);
  assert(r.ok, r.error);
  eq(r.content, 'ONE\ntwo\n2.5\nthree\nfour', 'all ops resolved against the snapshot');
});

await test('applyHashlineEdit rejects a stale tag with a re-read diagnostic', () => {
  const content = 'x\ny';
  const r = applyHashlineEdit(content, 'FFFF', [{ kind: 'cut', a: 1, b: 1 }]);
  assert(!r.ok, 'stale tag rejected');
  assert(/stale tag/.test(r.error) && /Re-read/.test(r.error), `diagnostic: ${r.error}`);
});

await test('applyHashlineEdit rejects out-of-bounds and overlapping ops', () => {
  const content = 'a\nb\nc';
  const tag = hashTag(content);
  assert(!applyHashlineEdit(content, tag, [{ kind: 'replace', a: 2, b: 9, body: [] }]).ok, 'out of bounds');
  const overlap = applyHashlineEdit(content, tag, [
    { kind: 'replace', a: 1, b: 2, body: ['X'] },
    { kind: 'cut', a: 2, b: 3 },
  ]);
  assert(!overlap.ok && /overlap/.test(overlap.error), 'overlap rejected');
});

await test('CUT deletes a range', () => {
  const content = 'keep1\ndrop\nkeep2';
  const r = applyHashlineBlock(content, `[f#${hashTag(content)}]\nCUT 2.=2`);
  assert(r.ok, r.error);
  eq(r.content, 'keep1\nkeep2', 'middle line cut');
});

// ── full read → edit → re-read cycle through the tools ──────────────────
await test('read_lines → edit_lines → read_lines round-trip with tag validation', async () => {
  const { exec, face } = fresh();
  await face.invoke('fs.write', { path: 'src/app.js', data: 'const a = 1;\nconst b = 2;\nconst c = 3;', createParents: true });

  // 1. anchored read — grab the tag.
  const read1 = await exec('read_lines', { path: 'src/app.js' });
  const tag1 = /#([0-9A-F]{4})\]/.exec(read1)[1];
  assert(/1: const a = 1;/.test(read1), 'line-numbered read');

  // 2. edit by line ref using that tag.
  const edit = `[src/app.js#${tag1}]\nPUT 2.=2:\n+const b = 20;\nPUT >$:\n+const d = 4;`;
  const editRes = await exec('edit_lines', { edit });
  assert(/Edited/.test(editRes), `edit landed: ${editRes}`);

  // 3. re-read: the content changed and the tag rotated.
  const read2 = await exec('read_lines', { path: 'src/app.js' });
  const tag2 = /#([0-9A-F]{4})\]/.exec(read2)[1];
  assert(/2: const b = 20;/.test(read2), 'edit visible on re-read');
  assert(/4: const d = 4;/.test(read2), 'appended line present');
  assert(tag1 !== tag2, 'tag rotated after the edit');

  // 4. reusing the STALE tag now fails.
  const stale = await exec('edit_lines', { edit: `[src/app.js#${tag1}]\nCUT 1.=1` });
  assert(/stale tag/.test(stale), `stale tag rejected: ${stale}`);
});

await test('codingToolset exposes hashline tools only when opted in', () => {
  assert(!codingToolset('code').some((t) => t.function.name === 'read_lines'), 'off by default');
  const names = codingToolset('code', { hashline: true }).map((t) => t.function.name);
  assert(names.includes('read_lines') && names.includes('edit_lines'), 'added with the flag');
  assert(codingToolset('code', { completion: true }).some((t) => t.function.name === 'task_done'), 'completion flag adds task_done');
  assert(!codingToolset('code').some((t) => t.function.name === 'task_done'), 'task_done off by default');
});

if (failures.length) {
  console.error(`hashline: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log(`sys/ai/hashline conformance: ${passed}/${passed} passed`);
