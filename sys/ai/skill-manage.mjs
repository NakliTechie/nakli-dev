// skill_manage — the agent's write path for its own skills (C1; Hermes's
// skill_manage + skill_manager_guards, Caura's staged→active lifecycle). Pure: the
// app reads the current SKILL.md, passes the text in, gets back a PLAN — a refusal,
// or the exact bytes to write plus the native diff the P0 reviewer renders — and
// does the writing. Nothing here touches a file, a clock, a model, or a host.
//
// Three rules the plan enforces:
//   READ BEFORE WRITE — a patch or file write to a skill this run has not loaded
//   through the `skill` tool is refused. The model must see what it is changing.
//   ONE PLACE — a patch must match exactly one place in the current text.
//   STAGED, NEVER ACTIVE BY THE AGENT — every write lands with `status: staged`
//   (or `quarantined` when Sentinel says so); a person activates it. This is the
//   P0 posture (PROPOSE / write_approval / candidate→staged→active converge here).
// Plus an ADVISORY linter: incident-log shape and references sprawl are warnings
// on the card, never a block (Hermes: "lessons, not logs").

import { parseSkill, SKILL_STATUSES } from './skills.mjs';
import { scanSkill, pathViolation } from './skill-sentinel.mjs';

export const SKILL_FILE = 'SKILL.md';
export { SKILL_STATUSES };
export const SKILL_OPS = Object.freeze(['create', 'patch', 'write_file']);

const safeName = (s) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(String(s || '')) ? String(s) : null;

// Per-run memory of which skills the agent has actually read.
export function createSkillSession() {
  const read = new Set();
  return { noteRead(name) { if (name) read.add(String(name)); }, hasRead(name) { return read.has(String(name)); }, get reads() { return [...read]; } };
}

// The parser is skills.mjs's parseSkill (one parser for the index and the writer).
export function serializeSkillFile(s) {
  const lines = [`name: ${s.name || ''}`, `description: ${String(s.description || '').replace(/\r?\n/g, ' ')}`];
  if (s.status && s.status !== 'active') lines.push(`status: ${s.status}`);
  if (s.pinned) lines.push('pinned: true');
  if (s.created) lines.push(`created: ${s.created}`);
  if (s.updated) lines.push(`updated: ${s.updated}`);
  return `---\n${lines.join('\n')}\n---\n${String(s.body || '').trimEnd()}\n`;
}

// Advisory linter — warnings, never blocks.
export function lintSkill({ description = '', body = '' } = {}) {
  const warnings = [];
  if (!String(description).trim()) warnings.push('no description — the index line will be empty');
  const dated = (String(body).match(/^\s*[-*]?\s*(\d{4}-\d{2}-\d{2}|on \w+ \d{1,2})/gim) || []).length;
  if (dated >= 3) warnings.push(`incident-log shape: ${dated} dated entries — write the lesson, not the log`);
  const links = (String(body).match(/\]\([^)]+\)|https?:\/\/\S+/g) || []).length;
  const fileRefs = (String(body).match(/\b[\w./-]+\.(md|mjs|js|py|json|txt|yml|yaml)\b/g) || []).length;
  if (links > 10 || fileRefs > 15) warnings.push(`references sprawl: ${links} links, ${fileRefs} file refs — a skill is instructions, not an index`);
  if (String(body).trim().length < 40) warnings.push('body under 40 characters — is this a skill or a note?');
  return warnings;
}

// The tool the model sees.
export function skillManageTool() {
  return {
    type: 'function',
    function: {
      name: 'skill_manage',
      description: 'Create or change one of THIS project\'s skills (.anvil/skills/<name>/SKILL.md). ' +
        'Every write is STAGED for the owner to activate — it never binds on its own. ' +
        'ops: create (name + description + content), patch (name + old_string + new_string — load the ' +
        'skill with the `skill` tool first; a patch to a skill you have not read is refused), ' +
        'write_file (name + path + content — a support file inside the skill folder). ' +
        'Write lessons, not logs: what to do next time and why.',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: SKILL_OPS.slice() },
          name: { type: 'string', description: 'skill name: lowercase slug' },
          description: { type: 'string', description: 'create: one line, ≤160 bytes — the index entry' },
          content: { type: 'string', description: 'create: the SKILL.md body; write_file: the file content' },
          old_string: { type: 'string' }, new_string: { type: 'string' },
          path: { type: 'string', description: 'write_file: relative path inside the skill folder' },
        },
        required: ['op', 'name'],
      },
    },
  };
}

// Plan a write. `existing` is the current SKILL.md text (null when absent);
// `existingFiles` the support files [{path, content}] for the sentinel; `session`
// the run's read-tracker; `now` an ISO string the app supplies.
// Returns { ok:false, refusal } or { ok:true, op, name, path, before, after, status, lint, sentinel, diff }.
export function planSkillWrite(args = {}, { existing = null, existingFiles = [], session = null, now = null } = {}) {
  const op = String(args.op || '');
  const name = safeName(args.name);
  if (!SKILL_OPS.includes(op)) return { ok: false, refusal: `Refused: unknown op "${op}" — use create | patch | write_file.` };
  if (!name) return { ok: false, refusal: 'Refused: a skill name is a lowercase slug (letters, digits, . _ -), at most 64 characters.' };
  const cur = existing != null ? parseSkill(existing) : null;

  if (op === 'create') {
    if (cur) return { ok: false, refusal: `Refused: skill "${name}" already exists — load it with the \`skill\` tool and patch it.` };
    const body = String(args.content || '').trim();
    if (!body) return { ok: false, refusal: 'Refused: create needs content.' };
    const next = { name, description: String(args.description || '').trim(), status: 'staged', pinned: false, created: now, updated: now, body };
    if (session) session.noteRead(name); // the author has seen it: support files may follow in the same run
    return finish(op, name, SKILL_FILE, '', next, existingFiles);
  }

  if (!cur) return { ok: false, refusal: `Refused: no skill named "${name}" — create it first.` };
  if (!session || !session.hasRead(name)) return { ok: false, refusal: `Refused: read skill "${name}" with the \`skill\` tool before changing it — a change to text you have not seen is a guess.` };

  if (op === 'patch') {
    const oldS = String(args.old_string ?? ''), newS = String(args.new_string ?? '');
    if (!oldS) return { ok: false, refusal: 'Refused: patch needs old_string.' };
    const n = cur.body.split(oldS).length - 1;
    if (n !== 1) return { ok: false, refusal: `Refused: old_string matches ${n} places in "${name}" — it must match exactly one.` };
    const next = { ...cur, status: cur.status === 'quarantined' ? 'quarantined' : 'staged', updated: now, body: cur.body.replace(oldS, newS) };
    return finish(op, name, SKILL_FILE, existing, next, existingFiles);
  }

  // write_file: a support file inside the skill folder; the SKILL.md itself is re-staged
  const rel = String(args.path || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const pv = pathViolation(rel); if (pv) return { ok: false, refusal: `Refused: ${pv} — a support file lives inside the skill folder.` };
  // Case-insensitively: on a case-insensitive folder (the macOS FSA rung) 'skill.md' IS SKILL.md,
  // and a raw write there would land an agent-authored file that parses as ACTIVE.
  if (rel.toLowerCase() === SKILL_FILE.toLowerCase() || rel.toLowerCase().endsWith('/' + SKILL_FILE.toLowerCase())) return { ok: false, refusal: 'Refused: change SKILL.md with patch, not write_file.' };
  const content = String(args.content ?? '');
  const files = [...(existingFiles || []).filter((f) => f.path !== rel), { path: rel, content }];
  const next = { ...cur, status: cur.status === 'quarantined' ? 'quarantined' : 'staged', updated: now };
  const before = ((existingFiles || []).find((f) => f.path === rel) || {}).content ?? '';
  return finish(op, name, rel, before, next, files, content);
}

function finish(op, name, path, before, next, files, fileContent) {
  const sentinel = scanSkill({ name, description: next.description, body: next.body, files });
  if (sentinel.state === 'refused') return { ok: false, refusal: `Refused by Sentinel: ${sentinel.findings.filter((f) => f.severity === 'fatal').map((f) => `${f.check} (${f.where}: ${f.detail})`).join('; ')}.`, sentinel };
  if (sentinel.state === 'quarantined') next.status = 'quarantined';
  const skillText = serializeSkillFile(next);
  const after = path === SKILL_FILE ? skillText : String(fileContent ?? '');
  const diff = { skill: name, op, path, before: String(before ?? ''), after, status: next.status, sentinel: sentinel.findings, lint: lintSkill(next) };
  return { ok: true, op, name, path, before: diff.before, after, skillText, status: next.status, lint: diff.lint, sentinel, diff };
}
