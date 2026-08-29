// Structured, progressive project memory — the same mechanism as skills, applied
// to FACTS. Facts live at .anvil/memory/<slug>.md in the workspace (they roam
// with it), one fact per file with frontmatter (name, description, type) + body.
//
// Only the fact INDEX (one line each: name + type + description) is injected at
// task start — cheap, and selective at scale, unlike a flat memory.md that dumps
// everything up to a cap. The agent loads a fact's full body on demand via the
// `recall` tool, and records a durable learning via `remember` (one file per
// fact). Mirrors Claude's memory: file-per-fact + frontmatter + an index.
//
// Pure module (no fs, no browser, no clock): the app lists/reads/writes files
// and passes text in. `noteToFact` is deterministic so it's headlessly testable.

import { parseFrontmatter } from './skills.mjs';

export const MEMORY_DIR = '.anvil/memory';
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'];
// Belief-revision (Agno's "learning machine" mechanism): a learning starts as a
// HYPOTHESIS, is promoted to VERIFIED when a check corroborates it, and is RETRACTED
// when an observation disproves it — so the agent stops re-paying for a wrong note.
// A fact with no status is a plain durable fact (back-compat).
export const MEMORY_STATUSES = ['hypothesis', 'verified', 'retracted'];

// Parse a fact file → { name, description, type, status, body }. Unknown/absent type
// falls back to 'project'; unknown/absent status → null (a plain fact).
export function parseFact(text){
  const { meta, body } = parseFrontmatter(text);
  return {
    name: meta.name || '',
    description: meta.description || '',
    type: MEMORY_TYPES.includes((meta.type || '').toLowerCase()) ? meta.type.toLowerCase() : 'project',
    status: MEMORY_STATUSES.includes((meta.status || '').toLowerCase()) ? meta.status.toLowerCase() : null,
    body,
  };
}

// Build the injected index from [{name, description, type}]. One line per fact;
// '' when there are none (caller concatenates blindly).
export function buildMemoryIndex(facts){
  const all = (facts || []).filter(f => f && (f.name || f.description));
  // Retracted facts are disproven — hide them from the active context (their file
  // stays for provenance), but tell the agent they exist so it doesn't re-derive them.
  const list = all.filter(f => f.status !== 'retracted');
  const retracted = all.length - list.length;
  if (!list.length) return '';
  const lines = list.map(f => {
    const tag = f.status === 'hypothesis' ? ' _(hypothesis — verify or retract with `revise`)_' : '';
    return `- **${f.name || '(fact)'}** (${f.type || 'project'}): ${String(f.description || '').replace(/\s+/g, ' ').trim()}${tag}`;
  });
  const foot = retracted ? `\n\n${retracted} fact(s) were retracted (disproven) and hidden — do not re-derive them.` : '';
  return '\n\n# Project memory\n' +
    'Durable learnings recorded for THIS project — honor them. A fact marked ' +
    '_hypothesis_ is provisional: when a check corroborates it, promote it with ' +
    '`revise`; when an observation disproves it, retract it with `revise` so you ' +
    'stop re-paying for it. Load a fact\'s full detail with the `recall` tool when ' +
    'the one-line entry is not enough; record a new durable learning with `remember`.\n\n' +
    lines.join('\n') + foot + '\n';
}

// Turn a free-text note into a fact file. Deterministic: slug + description come
// from the note's first line; body is the full note. Returns the parts + the
// serialized file text. The caller ensures the slug is unique on disk.
export function noteToFact(note, type, status){
  const clean = String(note == null ? '' : note).trim();
  const firstLine = (clean.split('\n')[0] || '').trim();
  const description = firstLine.length > 140 ? firstLine.slice(0, 139).trimEnd() + '…' : firstLine;
  const slug = firstLine.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .split('-').filter(Boolean).slice(0, 6).join('-') || 'fact';
  const t = MEMORY_TYPES.includes(type) ? type : 'project';
  // status is optional (a plain fact when omitted); the app passes 'verified' when a
  // check has corroborated the learning this run, else 'hypothesis'.
  const st = MEMORY_STATUSES.includes(status) ? status : null;
  const statusLine = st ? `status: ${st}\n` : '';
  const file = `---\nname: ${slug}\ndescription: ${description.replace(/\r?\n/g, ' ')}\ntype: ${t}\n${statusLine}---\n${clean}\n`;
  return { slug, description, type: t, status: st, body: clean, file };
}

// Belief revision: rewrite a fact file to a new status (verified | retracted) and
// append a dated-by-reason revision note to its body. Pure — the app reads the file,
// calls this, writes it back. Preserves name/description/type.
export function applyRevision(text, { status, reason } = {}){
  const st = MEMORY_STATUSES.includes(status) ? status : 'retracted';
  const { meta, body } = parseFrontmatter(text);
  const name = meta.name || '';
  const description = (meta.description || '').replace(/\r?\n/g, ' ');
  const type = MEMORY_TYPES.includes((meta.type || '').toLowerCase()) ? meta.type.toLowerCase() : 'project';
  const note = reason
    ? `\n\n**Revised → ${st}:** ${String(reason).replace(/\r?\n/g, ' ').trim()}`
    : `\n\n**Revised → ${st}.**`;
  return `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\nstatus: ${st}\n---\n${body.trimEnd()}${note}\n`;
}

// OpenAI-style tool: load one fact's full body on demand.
export function recallTool(){
  return {
    type: 'function',
    function: {
      name: 'recall',
      description: 'Load a project-memory fact\'s full detail by name (from the ' +
        'Project memory list in your context), when the one-line entry is not enough.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The fact name, exactly as listed.' } },
        required: ['name'],
      },
    },
  };
}

// OpenAI-style tool: belief revision. Promote a corroborated hypothesis to verified,
// or retract one an observation disproved — the mechanism that keeps memory from
// re-asserting a wrong note.
export function reviseTool(){
  return {
    type: 'function',
    function: {
      name: 'revise',
      description: 'Update a project-memory fact\'s confidence after new evidence: ' +
        'set status "verified" when a check corroborates it, or "retracted" when an ' +
        'observation disproves it (so you stop re-deriving a wrong note). Give the ' +
        'fact name exactly as listed, the new status, and a one-line reason.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The fact name, exactly as listed.' },
          status: { type: 'string', enum: ['verified', 'retracted'], description: 'verified (corroborated) or retracted (disproven).' },
          reason: { type: 'string', description: 'One line: what evidence changed the fact\'s status.' },
        },
        required: ['name', 'status'],
      },
    },
  };
}
