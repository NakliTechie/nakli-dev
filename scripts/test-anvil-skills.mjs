// Guards the skill_manage seam in Anvil (C1): the agent can write its own skills only
// through a plan that enforces read-before-write and a Sentinel scan, every write is a
// P0 envelope, and a staged or quarantined skill never reaches the injected index.
// Grep-based, like the other app-contract tests. Pins the seam, not the shape.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSkillsIndex, parseSkill } from '../sys/ai/skills.mjs';

const anvil = await readFile(new URL('../apps/anvil/index.html', import.meta.url), 'utf8');

assert.match(anvil, /import \{[^}]*\bplanSkillWrite\b[^}]*\} from '\.\.\/\.\.\/sys\/ai\/skill-manage\.mjs'/, 'Anvil imports the skill-manage plan');
assert.match(anvil, /registerAppDiffTypes\(\['anvil'\]\)/, 'the anvil-skill diff type is registered in Anvil\'s realm');
assert.match(anvil, /const skillSession=createSkillSession\(\);/, 'one read-session per run');
assert.match(anvil, /skillSession\.noteRead\(name\)/, 'the skill tool records a read');
assert.match(anvil, /planSkillWrite\(ar\|\|\{\}, \{ existing, existingFiles, session: skillSession, now: new Date\(\)\.toISOString\(\) \}\)/, 'skill_manage plans with the session (read-before-write), the folder\'s support files, and a stamp');
assert.match(anvil, /makeEnvelope\(\{ app:'anvil', tool:'skill_manage', diff: plan\.diff/, 'every skill write is a P0 envelope');
assert.match(anvil, /if\(mode==='code'\) tools\.push\(skillManageTool\(\)\);/, 'skill_manage is offered in code mode');
assert.match(anvil, /nm==='skill_manage'\)\)\{/, 'skill_manage is refused outside code mode');
assert.match(anvil, /metas\.push\(\{ name, description: sk\.description, status: sk\.status \}\)/, 'the index push carries status (a staged skill must not bind)');
assert.match(anvil, /if\(!INJECTED_STATUSES\.includes\(sk\.status\)\) return 'Skill/, 'the skill tool refuses to serve a staged or quarantined skill');
assert.equal((anvil.match(/Object\.keys\(skillMap\)\.filter\(n=>INJECTED_STATUSES\.includes\(skillStatus\[n\]\|\|'active'\)\)/g) || []).length, 2, 'both listings hide non-binding skills');

// The contract the app depends on, in the pure module: staged / quarantined never injected.
const staged = parseSkill('---\nname: s\ndescription: d\nstatus: staged\n---\nbody');
const quarantined = parseSkill('---\nname: q\ndescription: d\nstatus: quarantined\n---\nbody');
const active = parseSkill('---\nname: a\ndescription: d\n---\nbody');
const idx = buildSkillsIndex([staged, quarantined, active]);
assert.ok(!/\*\*s\*\*/.test(idx) && !/\*\*q\*\*/.test(idx) && /\*\*a\*\*/.test(idx), 'only the active skill is injected');
// The regression: dropping status re-admits a staged skill.
assert.ok(/\*\*s\*\*/.test(buildSkillsIndex([{ name: staged.name, description: staged.description }])), 'sanity: without status the filter cannot engage — which is why the app must pass it');

console.log('anvil-skills: skill writes are planned, scanned, staged through P0, and never injected until activated');
