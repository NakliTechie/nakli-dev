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

// Lifecycle (C1/C4): a skill written by hand is the owner's — ACTIVE. One the agent
// writes lands STAGED until a person activates it; Sentinel can land it QUARANTINED;
// the curator ages an unused one STALE then ARCHIVED (never deleted). Only active and
// stale skills are injected; `pinned: true` exempts a skill from aging.
export const SKILL_STATUSES = Object.freeze(['active', 'staged', 'quarantined', 'stale', 'archived']);
export const INJECTED_STATUSES = Object.freeze(['active', 'stale']);

// Parse a SKILL.md — frontmatter (name/description + lifecycle fields) + body.
export function parseSkill(text){
  const { meta, body } = parseFrontmatter(text);
  return {
    name: meta.name || '', description: meta.description || '',
    status: SKILL_STATUSES.includes((meta.status || '').toLowerCase()) ? meta.status.toLowerCase() : 'active',
    pinned: /^(true|yes|1)$/i.test(String(meta.pinned || '')),
    created: meta.created || null, updated: meta.updated || null,
    body,
  };
}

// Build the injected index from [{name, description, status?}]. Descriptions only,
// one per line; a staged, quarantined or archived skill is NOT injected (it does not
// bind); a stale one is, tagged. Returns '' when nothing is injectable.
export function buildSkillsIndex(skills){
  const list = (skills || []).filter(s => s && s.name && INJECTED_STATUSES.includes(s.status || 'active'));
  if (!list.length) return '';
  const lines = list.map(s =>
    `- **${s.name}**: ${String(s.description || '(no description)').replace(/\s+/g, ' ').trim()}${s.status === 'stale' ? ' _(stale — unused for a while; still valid until archived)_' : ''}`);
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
