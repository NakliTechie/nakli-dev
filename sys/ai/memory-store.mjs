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

// Parse a fact file → { name, description, type, body }. Unknown/absent type
// falls back to 'project'.
export function parseFact(text){
  const { meta, body } = parseFrontmatter(text);
  return {
    name: meta.name || '',
    description: meta.description || '',
    type: MEMORY_TYPES.includes((meta.type || '').toLowerCase()) ? meta.type.toLowerCase() : 'project',
    body,
  };
}

// Build the injected index from [{name, description, type}]. One line per fact;
// '' when there are none (caller concatenates blindly).
export function buildMemoryIndex(facts){
  const list = (facts || []).filter(f => f && (f.name || f.description));
  if (!list.length) return '';
  const lines = list.map(f =>
    `- **${f.name || '(fact)'}** (${f.type || 'project'}): ${String(f.description || '').replace(/\s+/g, ' ').trim()}`);
  return '\n\n# Project memory\n' +
    'Durable learnings recorded for THIS project — honor them. Each line is a ' +
    'fact; load a fact\'s full detail with the `recall` tool when the one-line ' +
    'entry is not enough. Record a new durable learning with `remember`.\n\n' +
    lines.join('\n') + '\n';
}

// Turn a free-text note into a fact file. Deterministic: slug + description come
// from the note's first line; body is the full note. Returns the parts + the
// serialized file text. The caller ensures the slug is unique on disk.
export function noteToFact(note, type){
  const clean = String(note == null ? '' : note).trim();
  const firstLine = (clean.split('\n')[0] || '').trim();
  const description = firstLine.length > 140 ? firstLine.slice(0, 139).trimEnd() + '…' : firstLine;
  const slug = firstLine.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .split('-').filter(Boolean).slice(0, 6).join('-') || 'fact';
  const t = MEMORY_TYPES.includes(type) ? type : 'project';
  const file = `---\nname: ${slug}\ndescription: ${description.replace(/\r?\n/g, ' ')}\ntype: ${t}\n---\n${clean}\n`;
  return { slug, description, type: t, body: clean, file };
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
