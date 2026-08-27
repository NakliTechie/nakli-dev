// Per-project tool hooks — the "policy/format without core changes" lever. A
// workspace config at .anvil/hooks.json (roams with the workspace) declares
// shell commands to run around the agent's tool calls:
//
//   {
//     "postTool": [ { "on": "write|edit", "pathMatch": "*.py", "run": "python -m black {file}" } ],
//     "preTool":  [ { "on": "shell", "commandMatch": "rm -rf /", "block": "Refusing dangerous rm." } ]
//   }
//
// A postTool hook runs AFTER a matching tool succeeds (its output is fed back to
// the agent). A preTool hook with `block` REFUSES a matching tool before it runs
// (the block message goes back to the agent). Pure module — the app reads the
// config, matches, and runs the commands through the Rig shell.
//
// Trust model: postTool `run` is user-authored project config — same trust as
// the verify command; substituted values are shell-quoted so an agent-controlled
// path can't inject extra statements. preTool `block` is a POLICY guard that
// deters an honest agent, not a hard sandbox — the agent already reaches the
// grant-scoped Rig shell via its own `shell` tool.

export const HOOKS_FILE = '.anvil/hooks.json';

// Parse hooks.json tolerantly → { preTool:[], postTool:[] } (never throws).
export function parseHooks(text){
  let cfg = {};
  try { cfg = JSON.parse(String(text == null ? '{}' : text)); } catch (_){ return { preTool: [], postTool: [] }; }
  if (!cfg || typeof cfg !== 'object') return { preTool: [], postTool: [] };
  const norm = (arr) => Array.isArray(arr) ? arr.filter(h => h && typeof h === 'object') : [];
  return { preTool: norm(cfg.preTool), postTool: norm(cfg.postTool) };
}

// Glob: * = one segment, ** = any, ? = one char. A pattern with no '/' also
// matches the basename (so "*.py" hits "src/app.py").
export function globMatch(pattern, path){
  if (pattern == null || pattern === '') return true;
  const p = String(pattern), s = String(path == null ? '' : path);
  const rx = '^' + p.split(/(\*\*|\*|\?)/).map(tok => {
    if (tok === '**') return '.*';
    if (tok === '*') return '[^/]*';
    if (tok === '?') return '[^/]';
    return tok.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }).join('') + '$';
  let re; try { re = new RegExp(rx); } catch (_){ return false; }
  if (re.test(s)) return true;
  if (!p.includes('/')){ const base = s.split('/').pop() || s; return re.test(base); }
  return false;
}

// Does a hook apply to this tool call? `on` is a "|"-separated tool list;
// pathMatch tests the path/file arg; commandMatch is a substring of the command.
export function hookMatches(hook, toolName, args){
  if (!hook || typeof hook !== 'object') return false;
  const ons = String(hook.on || '').split('|').map(s => s.trim()).filter(Boolean);
  if (ons.length && !ons.includes(toolName)) return false;
  const a = args || {};
  if (hook.pathMatch){ const pth = a.path || a.file || ''; if (!globMatch(hook.pathMatch, pth)) return false; }
  if (hook.commandMatch){ const cmd = String(a.command || ''); if (!cmd.includes(String(hook.commandMatch))) return false; }
  return true;
}

// Single-quote a value for safe shell substitution (neutralizes ; && | > and
// spaces from an agent-controlled path/command). Embedded quotes are escaped.
function shq(s){ return "'" + String(s == null ? '' : s).replace(/'/g, "'\\''") + "'"; }

// Build the shell command for a postTool hook, substituting {file}/{path}/{command}
// as SAFELY-QUOTED values so a crafted filename can't inject extra statements.
export function hookCommand(hook, args){
  const a = args || {};
  const file = a.path || a.file || '';
  return String((hook && hook.run) || '')
    .replace(/\{file\}|\{path\}/g, () => shq(file))
    .replace(/\{command\}/g, () => shq(a.command || ''));
}

// The pre-tool decision: the first matching preTool hook with a `block` message
// refuses the tool. Returns { blocked, message } — blocked:false when nothing matches.
export function preToolDecision(hooks, toolName, args){
  for (const h of (hooks && hooks.preTool) || []){
    if (hookMatches(h, toolName, args) && h.block){
      return { blocked: true, message: String(h.block) };
    }
  }
  return { blocked: false, message: '' };
}

// The postTool commands to run for a tool call, in order (already substituted).
export function postToolCommands(hooks, toolName, args){
  const out = [];
  for (const h of (hooks && hooks.postTool) || []){
    if (hookMatches(h, toolName, args) && h.run) out.push(hookCommand(h, args));
  }
  return out;
}
