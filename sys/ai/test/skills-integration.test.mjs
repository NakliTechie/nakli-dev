// Integration — the skills flow exactly as Anvil runs it, over the real Rig
// fileops (MemoryBackend). Validates the fs.list/read shapes the app relies on.
//   node sys/ai/test/skills-integration.test.mjs
import { createFileops, MemoryBackend } from '../../rig/fileops/index.mjs';
import { SKILLS_DIR, parseSkill, buildSkillsIndex } from '../skills.mjs';

let passed = 0; const failures = [];
async function test(name, fn){ try { await fn(); passed++; } catch (e){ failures.push({ name, message: e.message }); } }
function assert(c, m){ if (!c) throw new Error(m || 'assertion failed'); }

// Mirror Anvil's runTask skills block + the `skill` tool interception.
async function buildSkills(fs){
  const skillMap = {};
  let skillsIndex = '';
  const dir = await fs.list(SKILLS_DIR, { recursive:false });
  if (dir && dir.ok){
    const metas = [];
    for (const e of (dir.entries || [])){
      if (e.type !== 'dir') continue;
      const r = await fs.read(e.path + '/SKILL.md', { encoding:'utf-8' });
      if (r && r.ok){ const sk = parseSkill(r.data); const name = sk.name || e.name;
        metas.push({ name, description: sk.description }); skillMap[name] = e.path + '/SKILL.md'; }
    }
    skillsIndex = buildSkillsIndex(metas);
  }
  return { skillsIndex, skillMap };
}
async function loadSkill(fs, skillMap, name){
  const p = skillMap[name] || (SKILLS_DIR + '/' + name + '/SKILL.md');
  const r = await fs.read(p, { encoding:'utf-8' });
  if (r && r.ok){ const sk = parseSkill(r.data); return 'Skill: ' + (sk.name || name) + '\n\n' + sk.body; }
  return 'No skill named "' + name + '".';
}

await test('no skills dir → empty index, no crash', async () => {
  const fs = createFileops({ backend: new MemoryBackend() });
  const { skillsIndex, skillMap } = await buildSkills(fs);
  assert(skillsIndex === '', 'empty index');
  assert(Object.keys(skillMap).length === 0, 'empty map');
});

await test('skills present → index built + bodies loadable on demand', async () => {
  const fs = createFileops({ backend: new MemoryBackend() });
  await fs.write(SKILLS_DIR + '/deploy/SKILL.md', '---\nname: deploy\ndescription: Ship to prod\n---\nStep 1. build\nStep 2. push');
  await fs.write(SKILLS_DIR + '/review/SKILL.md', '---\nname: review\ndescription: Review a diff\n---\nCheck for bugs.');
  // a non-SKILL file that must be ignored
  await fs.write(SKILLS_DIR + '/notes.txt', 'ignore me');

  const { skillsIndex, skillMap } = await buildSkills(fs);
  assert(skillsIndex.includes('# Skills'), 'has header');
  assert(skillsIndex.includes('**deploy**: Ship to prod'), 'deploy in index');
  assert(skillsIndex.includes('**review**: Review a diff'), 'review in index');
  assert(!skillsIndex.includes('ignore me'), 'non-skill ignored');
  assert(Object.keys(skillMap).length === 2, 'two skills mapped');

  // The `skill` tool loads the full body.
  const loaded = await loadSkill(fs, skillMap, 'deploy');
  assert(loaded.includes('Step 1. build') && loaded.includes('Step 2. push'), 'full body loaded');
  assert(!loaded.includes('description:'), 'body excludes frontmatter');

  // Unknown skill → graceful message.
  const missing = await loadSkill(fs, skillMap, 'nope');
  assert(/No skill named "nope"/.test(missing), 'unknown handled');
});

await test('skill folder without name frontmatter → folder name is used', async () => {
  const fs = createFileops({ backend: new MemoryBackend() });
  await fs.write(SKILLS_DIR + '/scaffold/SKILL.md', 'Just instructions, no frontmatter.');
  const { skillsIndex, skillMap } = await buildSkills(fs);
  assert(skillMap['scaffold'], 'folder name used as skill name');
  assert(skillsIndex.includes('**scaffold**'), 'appears in index');
});

if (failures.length){
  console.error(`skills-integration: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log(`skills-integration conformance: ${passed}/${passed} passed`);
