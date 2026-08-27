// Progressive-disclosure skills for the coding agent. A skill is a folder at
// .anvil/skills/<name>/SKILL.md in the project workspace (it roams with the
// workspace, like AGENTS.md/memory.md). SKILL.md carries YAML-ish frontmatter
// (name, description) + a body of instructions; the folder may hold supporting
// files the body references.
//
// The cheap part: at task start only the skill DESCRIPTIONS are injected into
// the system context (cache-safe). The agent loads a skill's full body ON DEMAND
// via the `skill` tool when a task matches it. This module is PURE (no fs, no
// browser): the app lists/reads the files and passes the parsed skills in.

export const SKILLS_DIR = '.anvil/skills';

// Parse YAML-ish frontmatter (bare or quoted values, keys lowercased) + body.
// Tolerant: no frontmatter → {meta:{}, body:<whole trimmed text>}. Shared by
// skills and the structured memory store — they're the same progressive-
// disclosure mechanism (description-index + on-demand load).
export function parseFrontmatter(text){
  const s = String(text == null ? '' : text);
  const m = s.match(/^﻿?---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const meta = {};
  let body = s;
  if (m){
    body = m[2];
    for (const line of m[1].split('\n')){
      const kv = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (kv){
        const key = kv[1].trim().toLowerCase();
        const val = kv[2].trim().replace(/^["']|["']$/g, '');
        meta[key] = val;
      }
    }
  }
  return { meta, body: body.trim() };
}

// Parse a SKILL.md — frontmatter (name/description) + body.
export function parseSkill(text){
  const { meta, body } = parseFrontmatter(text);
  return { name: meta.name || '', description: meta.description || '', body };
}

// Build the injected index from [{name, description}]. Descriptions only, one per
// line. Returns '' when there are no named skills (caller concatenates blindly).
export function buildSkillsIndex(skills){
  const list = (skills || []).filter(s => s && s.name);
  if (!list.length) return '';
  const lines = list.map(s =>
    `- **${s.name}**: ${String(s.description || '(no description)').replace(/\s+/g, ' ').trim()}`);
  return '\n\n# Skills\n' +
    'These named skills are available for THIS project. When a task matches one, ' +
    'call the `skill` tool with its exact name to load its full instructions ' +
    'BEFORE proceeding — do not guess a skill\'s contents.\n\n' +
    lines.join('\n') + '\n';
}

// OpenAI-style tool the agent calls to pull one skill's full body on demand.
export function skillTool(){
  return {
    type: 'function',
    function: {
      name: 'skill',
      description: 'Load a project skill\'s full instructions by name (from the ' +
        'Skills list in your context). Call this before doing a task the skill ' +
        'covers, then follow the returned instructions.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The skill name, exactly as listed in the Skills section.' },
        },
        required: ['name'],
      },
    },
  };
}
