// Conformance — structured project memory (pure).
//   node sys/ai/test/memory-store.test.mjs
import { parseFact, buildMemoryIndex, noteToFact, recallTool, MEMORY_DIR, MEMORY_TYPES }
  from '../memory-store.mjs';

let passed = 0; const failures = [];
async function test(n, fn){ try { await fn(); passed++; } catch (e){ failures.push({ n, message: e.message }); } }
function assert(c, m){ if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m){ if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

await test('parseFact: frontmatter + type + body', () => {
  const f = parseFact('---\nname: api-home\ndescription: The API lives in api/\ntype: reference\n---\nRoutes are in api/routes.js');
  eq(f.name, 'api-home', 'name');
  eq(f.description, 'The API lives in api/', 'description');
  eq(f.type, 'reference', 'type');
  assert(f.body.includes('Routes are in api/routes.js'), 'body');
});

await test('parseFact: unknown/absent type → project', () => {
  eq(parseFact('---\nname: x\ntype: bogus\n---\nb').type, 'project', 'bogus → project');
  eq(parseFact('---\nname: x\n---\nb').type, 'project', 'absent → project');
});

await test('buildMemoryIndex: empty when no facts', () => {
  eq(buildMemoryIndex([]), '', 'empty');
  eq(buildMemoryIndex(null), '', 'null');
  eq(buildMemoryIndex([{}]), '', 'no name/desc → skipped');
});

await test('buildMemoryIndex: name + type + description, mentions recall + remember', () => {
  const out = buildMemoryIndex([
    { name: 'api-home', description: 'API in api/', type: 'reference' },
    { name: 'tabs', description: 'Use tabs not spaces', type: 'project' },
  ]);
  assert(out.includes('# Project memory'), 'header');
  assert(out.includes('**api-home** (reference): API in api/'), 'fact 1 with type');
  assert(out.includes('**tabs** (project): Use tabs not spaces'), 'fact 2');
  assert(/`recall`/.test(out) && /`remember`/.test(out), 'names both tools');
});

await test('noteToFact: deterministic slug + description + serialized file', () => {
  const f = noteToFact('The build script is scripts/build.sh not make', 'reference');
  eq(f.slug, 'the-build-script-is-scripts-build', 'slug = first 6 kebab tokens');
  eq(f.type, 'reference', 'type honored');
  eq(f.description, 'The build script is scripts/build.sh not make', 'description = first line');
  assert(f.file.startsWith('---\nname: ' + f.slug + '\n'), 'frontmatter name matches slug');
  assert(f.file.includes('type: reference'), 'frontmatter type');
  assert(f.file.includes('The build script is scripts/build.sh not make'), 'body in file');
  // round-trips through parseFact
  const p = parseFact(f.file);
  eq(p.name, f.slug, 'round-trip name');
  eq(p.type, 'reference', 'round-trip type');
});

await test('noteToFact: multi-line — description is first line, body is full', () => {
  const f = noteToFact('Auth uses JWT.\nTokens expire in 1h; refresh at /auth/refresh.', 'project');
  eq(f.description, 'Auth uses JWT.', 'description = first line only');
  assert(f.body.includes('refresh at /auth/refresh'), 'body keeps the rest');
});

await test('noteToFact: default type + long-first-line truncation', () => {
  eq(noteToFact('a fact', undefined).type, 'project', 'default type');
  const long = 'x'.repeat(200);
  const f = noteToFact(long, 'project');
  assert(f.description.length <= 141 && f.description.endsWith('…'), 'truncated with ellipsis');
});

await test('noteToFact: empty note → fact slug, no crash', () => {
  const f = noteToFact('', 'project');
  eq(f.slug, 'fact', 'fallback slug');
});

await test('recallTool + constants', () => {
  const t = recallTool();
  eq(t.function.name, 'recall', 'name');
  assert(t.function.parameters.required.includes('name'), 'name required');
  eq(MEMORY_DIR, '.anvil/memory', 'dir');
  assert(MEMORY_TYPES.includes('user') && MEMORY_TYPES.includes('reference'), 'types');
});

if (failures.length){
  console.error(`memory-store: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`memory-store conformance: ${passed}/${passed} passed`);
