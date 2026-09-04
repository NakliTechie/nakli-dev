// Conformance — structured project memory (pure).
//   node sys/ai/test/memory-store.test.mjs
import { parseFact, buildMemoryIndex, noteToFact, recallTool, MEMORY_DIR, MEMORY_TYPES,
         findDuplicate, duplicateReply, createRememberBudget, budgetSpentReply, MAX_REMEMBER_PER_RUN, NEAR_DUPLICATE_JACCARD }
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

// ─────────────────────────────────── search before save + per-run cap (A2) ──
const P = (name, extra = {}) => parseFact(`---\nname: ${name}\ndescription: ${extra.description || name}\ntype: project\n${extra.status ? 'status: ' + extra.status + '\n' : ''}${extra.supersedes ? 'supersedes: ' + extra.supersedes + '\n' : ''}---\n${extra.body || extra.description || name}`);

await test('findDuplicate: exact — same text (normalised) as a live fact → refused with the next move', () => {
  const facts = [P('build-tool', { description: 'The build tool is Vite.', body: 'The build tool is Vite.\nSee package.json.' })];
  const d = findDuplicate(facts, 'the build tool is vite');
  assert(d && d.reason === 'exact' && d.existing === 'build-tool', JSON.stringify(d));
  eq(d.status, null, 'plain fact → status null'); eq(d.successor, null, 'no successor');
  assert(/already exists as "build-tool"/.test(duplicateReply(d)) && /`recall`/.test(duplicateReply(d)) && /`revise`/.test(duplicateReply(d)), 'reply names the fact and both next moves');
  const full = findDuplicate(facts, 'The build tool is Vite.\nSee package.json.');
  eq(full && full.reason, 'exact', 'matching the whole body is exact too');
});

await test('findDuplicate: near — first line ≥ 0.8 Jaccard with a live fact\'s description', () => {
  const facts = [P('tests-live', { description: 'Tests live under sys/ai/test and run with plain node', status: 'hypothesis' })];
  const d = findDuplicate(facts, 'Tests live under sys/ai/test and run with plain node, no runner');
  assert(d && d.reason === 'near' && d.existing === 'tests-live', JSON.stringify(d));
  eq(d.status, 'hypothesis', 'status carried — the agent may want to revise it');
  assert(/near-identical/.test(duplicateReply(d)) && /\(hypothesis\)/.test(duplicateReply(d)), 'reply says near + status');
  eq(findDuplicate(facts, 'The database is postgres'), null, 'an unrelated note is not a duplicate');
  eq(findDuplicate(facts, ''), null, 'empty note → null');
  eq(NEAR_DUPLICATE_JACCARD, 0.8, 'threshold pinned');
});

await test('findDuplicate: superseded — a note matching a retracted or superseded fact is refused with its successor', () => {
  const facts = [
    P('cache-guess', { description: 'The cache is redis', status: 'retracted' }),
    P('old-db', { description: 'The database is mysql' }),
    P('new-db', { description: 'The database is postgres', supersedes: 'old-db' }),
  ];
  const r = findDuplicate(facts, 'The cache is redis');
  assert(r && r.reason === 'superseded' && r.status === 'retracted' && r.successor === null, JSON.stringify(r));
  assert(/disproven — do not re-derive/.test(duplicateReply(r)) && /supersedes: "cache-guess"/.test(duplicateReply(r)), 'the retracted match names the exit: record the correction with supersedes');
  // the exit works: a correction that overlaps the claim it replaces is NOT refused when it declares supersedes
  eq(findDuplicate(facts, 'The cache is redis, not memcached', { exempt: ['cache-guess'] }), null, 'exempted fact is skipped');
  eq(findDuplicate(facts, 'The database is mysql', { exempt: 'old-db, new-db' }), null, 'exempt accepts a comma list');
  assert(/supersedes: "new-db"/.test(duplicateReply(findDuplicate(facts, 'The database is postgres'))), 'a live near/exact refusal also offers the supersedes exit');
  const s = findDuplicate(facts, 'The database is mysql');
  assert(s && s.reason === 'superseded' && s.existing === 'old-db' && s.successor === 'new-db', JSON.stringify(s));
  assert(/replaced by "new-db"/.test(duplicateReply(s)), duplicateReply(s));
  // a live match wins over a stale one
  const live = findDuplicate(facts, 'The database is postgres');
  eq(live && live.reason, 'exact', 'live fact reported first'); eq(live.existing, 'new-db', 'the successor, not the stale row');
});

await test('createRememberBudget: the cap trips on the 6th (default 5), and the reply says so', () => {
  const b = createRememberBudget();
  eq(MAX_REMEMBER_PER_RUN, 5, 'default cap');
  for (let i = 1; i <= 5; i++){ const t = b.take(); assert(t.ok, `take ${i} ok`); eq(t.left, 5 - i, `left after ${i}`); }
  const sixth = b.take();
  assert(!sixth.ok && sixth.left === 0 && sixth.used === 5, JSON.stringify(sixth));
  eq(b.used, 5, 'used does not grow past the cap'); eq(b.left, 0, 'nothing left');
  assert(/recorded 5 learnings, its cap/.test(budgetSpentReply(sixth)), budgetSpentReply(sixth));
  const two = createRememberBudget(2); two.take(); two.take(); assert(!two.take().ok, 'custom cap honoured');
});

if (failures.length){
  console.error(`memory-store: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`memory-store conformance: ${passed}/${passed} passed`);
