// Per-project memory & skills — the context an agent reads at the start of a
// task and can append to as it learns. Two files live at the project workspace
// root and roam with it (they are ordinary workspace files):
//
//   AGENTS.md  — durable, human-authored instructions/skills/conventions
//   memory.md  — learnings the agent recorded via the `remember` tool
//
// This module is PURE (no fs, no browser): the app reads the two files, passes
// their text in, and writes back what `appendMemory` returns. That keeps the
// assembly + append semantics headlessly testable.

const DEFAULT_CAP = 8192;

// Assemble the system-prompt prefix from a project's AGENTS.md + memory.md.
// Each section is trimmed and capped; returns '' when neither is present so the
// caller can concatenate unconditionally.
export function buildProjectContext({ agents, memory, cap = DEFAULT_CAP } = {}) {
  const clip = (s) => {
    const t = String(s).trim();
    return t.length > cap ? t.slice(0, cap) + '\n…(truncated)' : t;
  };
  const sections = [];
  if (agents != null && String(agents).trim()) {
    sections.push('## Project instructions (AGENTS.md)\n' + clip(agents));
  }
  if (memory != null && String(memory).trim()) {
    sections.push('## Project memory (memory.md — learnings from earlier tasks)\n' + clip(memory));
  }
  if (!sections.length) return '';
  return '\n\n# Project context\n' +
    'This workspace carries persistent context. Follow the instructions and honor ' +
    'the memory below; record any durable learning with the `remember` tool.\n\n' +
    sections.join('\n\n') + '\n';
}

// Append one note as a bullet to memory.md, creating the file body when it is
// empty/absent. Append-only — never rewrites prior content. Returns the new
// full file contents. A blank note is a no-op (returns the input unchanged).
export function appendMemory(existing, note) {
  const clean = String(note == null ? '' : note).trim().replace(/\r?\n/g, ' ');
  if (!clean) return existing == null ? '' : String(existing);
  const header = '# Project memory\n\nLearnings recorded while working in this project.\n';
  const base = (existing == null || !String(existing).trim())
    ? header
    : String(existing).replace(/\n*$/, '\n');
  return base + '- ' + clean + '\n';
}

// Count the recorded notes (bullets) in a memory.md body.
export function countMemory(body) {
  return (String(body == null ? '' : body).match(/^- /gm) || []).length;
}

// OpenAI-style tool definition for the agent to record a durable learning. Each
// call writes one fact file under the structured memory store (.anvil/memory/);
// the index of facts is injected on future tasks and full detail loads via
// `recall`. Use sparingly — facts that still matter next session, not per-step
// notes.
export function rememberTool() {
  return {
    type: 'function',
    function: {
      name: 'remember',
      description: 'Record ONE durable learning about THIS project (a convention, ' +
        'a gotcha, where something lives, a user preference) so future tasks in ' +
        'this workspace start with it. Use sparingly, for facts that still matter ' +
        'next session — not per-step notes.',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'The learning. First line is the summary shown in the memory index; add detail on following lines if useful.' },
          type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'], description: 'Kind of fact (default: project).' },
          slot: { type: 'string', description: 'Optional single-valued key this fact fills (e.g. "build-tool", "db", "phase"). A new value for a slot supersedes the current holder.' },
          derived_from: { type: 'string', description: 'Optional comma-separated fact names this learning rests on. If one is later retracted, this fact drops back to hypothesis.' },
          supersedes: { type: 'string', description: 'Optional comma-separated fact names this learning replaces.' },
        },
        required: ['note'],
      },
    },
  };
}
