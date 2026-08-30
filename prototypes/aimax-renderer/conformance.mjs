// conformance.mjs — validate a recorded session against the structured render
// protocol (PROTOCOL.md). Give it a .jsonl captured by the renderer's ⏺ rec
// button (lines of {dt, m}) or a raw stream (one message object per line):
//
//   node prototypes/aimax-renderer/conformance.mjs aimax-session.jsonl
//
// Exit 0 if every message conforms; 1 with a per-line report otherwise. This is
// what gives PROTOCOL.md teeth: the moment svs sends a socket dump, run it
// through here to see exactly where his daemon and the strawman disagree.

import { readFileSync } from 'node:fs';

const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isArr = Array.isArray;
const isPos = (c) => c && isNum(c.line) && isNum(c.col);

// required-field checks per daemon→renderer message type. Return [] or [issues].
const RULES = {
  hello:      (m) => [ !isNum(m.proto) && 'proto: number required', m.caps && !isArr(m.caps) && 'caps: must be array' ],
  buffer:     (m) => [ !isStr(m.id) && 'id: string required', !isStr(m.name) && 'name: string required',
                       !isArr(m.lines) && 'lines: array required',
                       isArr(m.lines) && !m.lines.every(isStr) && 'lines: all entries must be strings',
                       m.cursor && !isPos(m.cursor) && 'cursor: {line,col} numbers' ],
  patch:      (m) => [ !isStr(m.id) && 'id: string required', !isArr(m.edits) && 'edits: array required',
                       isArr(m.edits) && !m.edits.every(e => isArr(e.range) && e.range.length===2 && isStr(e.text))
                         && 'edits[]: {range:[[l,c],[l,c]], text:string}',
                       m.version!=null && !isNum(m.version) && 'version: number' ],
  cursor:     (m) => [ !isStr(m.id) && 'id: string required', !isPos(m.cursor) && 'cursor: {line,col} numbers' ],
  windows:    (m) => [ !isArr(m.layout) && 'layout: array required',
                       isArr(m.layout) && !m.layout.every(w => isStr(w.id) && isStr(w.buffer)) && 'layout[]: {id, buffer} strings' ],
  agent:      (m) => [ !isStr(m.id) && 'id: string required',
                       m.state && !['streaming','idle','error','thinking'].includes(m.state) && `state: unexpected "${m.state}"` ],
  minibuffer: (m) => [ m.prompt!=null && !isStr(m.prompt) && 'prompt: string', m.text!=null && !isStr(m.text) && 'text: string' ],
  echo:       (m) => [ !isStr(m.text) && 'text: string required' ],
};
// renderer→daemon types are legal to see in a bidirectional capture; don't flag them
const CLIENT_TYPES = new Set(['key','command','resize','subscribe','focus','resync','input']);

const file = process.argv[2];
if (!file) { console.error('usage: node conformance.mjs <session.jsonl>'); process.exit(2); }

const lines = readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
let ok = 0, bad = 0, unknown = 0;
const hist = {};
const problems = [];

lines.forEach((line, i) => {
  let row; try { row = JSON.parse(line); } catch (_) { bad++; problems.push(`L${i+1}: not JSON`); return; }
  const m = row && row.m ? row.m : row;                    // unwrap {dt,m} or raw
  if (!m || !isStr(m.t)) { bad++; problems.push(`L${i+1}: missing "t" (message type)`); return; }
  hist[m.t] = (hist[m.t] || 0) + 1;
  if (CLIENT_TYPES.has(m.t)) { ok++; return; }             // outbound; not validated here
  const rule = RULES[m.t];
  if (!rule) { unknown++; problems.push(`L${i+1}: unknown type "${m.t}" (not in PROTOCOL.md)`); return; }
  const issues = rule(m).filter(Boolean);
  if (issues.length) { bad++; problems.push(`L${i+1} [${m.t}]: ${issues.join('; ')}`); }
  else ok++;
});

console.log(`conformance: ${lines.length} messages · ${ok} ok · ${bad} invalid · ${unknown} unknown-type`);
console.log('types:', Object.entries(hist).map(([k, v]) => `${k}×${v}`).join(', ') || '(none)');
if (problems.length) { console.log('\nissues:'); for (const p of problems.slice(0, 100)) console.log('  ' + p); }
process.exit(bad || unknown ? 1 : 0);
