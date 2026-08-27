// Integration — the structured-memory flow as Anvil runs it, over the real Rig
// fileops (MemoryBackend). remember → fact file; index build; recall → body.
//   node sys/ai/test/memory-store-integration.test.mjs
import { createFileops, MemoryBackend } from '../../rig/fileops/index.mjs';
import { MEMORY_DIR, parseFact, buildMemoryIndex, noteToFact } from '../memory-store.mjs';

let passed = 0; const failures = [];
async function test(n, fn){ try { await fn(); passed++; } catch (e){ failures.push({ n, message: e.message }); } }
function assert(c, m){ if (!c) throw new Error(m || 'assertion failed'); }

// Mirror Anvil: write a fact, choosing a unique slug on collision.
async function remember(fs, note, type){
  const f = noteToFact(note, type);
  let slug = f.slug, n = 1, path = `${MEMORY_DIR}/${slug}.md`;
  while ((await fs.stat(path)).ok){ n++; slug = `${f.slug}-${n}`; path = `${MEMORY_DIR}/${slug}.md`; }
  const file = f.file.replace(`name: ${f.slug}\n`, `name: ${slug}\n`);
  await fs.write(path, file);
  return slug;
}
async function buildIndex(fs){
  const facts = [];
  const dir = await fs.list(MEMORY_DIR, { recursive:false });
  if (dir && dir.ok){
    for (const e of (dir.entries || [])){
      if (e.type === 'dir' || !e.name.endsWith('.md')) continue;
      const r = await fs.read(e.path, { encoding:'utf-8' });
      if (r && r.ok){ const f = parseFact(r.data); facts.push({ name: f.name || e.name.replace(/\.md$/, ''), description: f.description, type: f.type }); }
    }
  }
  return { index: buildMemoryIndex(facts), facts };
}
async function recall(fs, name){
  const r = await fs.read(`${MEMORY_DIR}/${name}.md`, { encoding:'utf-8' });
  if (r && r.ok) return parseFact(r.data).body;
  return null;
}

await test('empty store → empty index, no crash', async () => {
  const fs = createFileops({ backend: new MemoryBackend() });
  const { index, facts } = await buildIndex(fs);
  assert(index === '' && facts.length === 0, 'empty');
});

await test('remember writes one fact file per call; index lists them; recall loads body', async () => {
  const fs = createFileops({ backend: new MemoryBackend() });
  const s1 = await remember(fs, 'The API lives in api/routes.js', 'reference');
  const s2 = await remember(fs, 'User prefers tabs, not spaces', 'user');
  const { index, facts } = await buildIndex(fs);
  assert(facts.length === 2, 'two fact files');
  assert(index.includes('(reference): The API lives in api/routes.js'), 'fact 1 indexed with type');
  assert(index.includes('(user): User prefers tabs, not spaces'), 'fact 2 indexed with type');
  const body = await recall(fs, s1);
  assert(body.includes('api/routes.js'), 'recall loads the full body');
  assert(s1 !== s2, 'distinct slugs');
});

await test('duplicate notes get distinct files (no clobber)', async () => {
  const fs = createFileops({ backend: new MemoryBackend() });
  const a = await remember(fs, 'Same summary line here', 'project');
  const b = await remember(fs, 'Same summary line here — but more detail', 'project');
  assert(a !== b, `distinct slugs on same first-6-words: ${a} vs ${b}`);
  const { facts } = await buildIndex(fs);
  assert(facts.length === 2, 'both facts kept');
});

if (failures.length){
  console.error(`memory-store-integration: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`memory-store-integration conformance: ${passed}/${passed} passed`);
