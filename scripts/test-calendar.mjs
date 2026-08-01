import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const source = await readFile(new URL('apps/calendar/core.js', root), 'utf8');
const html = await readFile(new URL('apps/calendar/index.html', root), 'utf8');
const context = vm.createContext({ Intl, Date, Math, crypto:globalThis.crypto });
vm.runInContext(source, context, { filename:'calendar/core.js' });
const Core = context.CalendarCore;

assert.equal(
  Core.wallToUtc('2026-08-01T09:30', 'Asia/Kolkata'),
  '2026-08-01T04:00:00.000Z',
  'wall time converts through the selected IANA zone',
);
assert.equal(
  Core.utcToWall('2026-08-01T04:00:00.000Z', 'Asia/Kolkata'),
  '2026-08-01T09:30',
  'UTC round-trips to the original wall time',
);

const weekly = {
  id:'weekly-1', title:'Planning', description:'', location:'',
  startLocal:'2026-03-02T09:00', endLocal:'2026-03-02T10:00',
  allDay:false, timeZone:'America/New_York',
  recurrence:{ frequency:'weekly', interval:1, until:'2026-03-23' },
  createdAt:1, updatedAt:1,
};
const occurrences = Core.expandEvent(
  weekly,
  Date.parse('2026-03-01T00:00:00Z'),
  Date.parse('2026-04-01T00:00:00Z'),
);
assert.equal(occurrences.length, 4, 'weekly recurrence respects UNTIL');
assert.equal(occurrences[0].startUtc, '2026-03-02T14:00:00.000Z');
assert.equal(
  occurrences[1].startUtc,
  '2026-03-09T13:00:00.000Z',
  'recurrence keeps 09:00 wall time across daylight-saving transition',
);

const ics = Core.exportIcs([weekly]);
assert.match(ics, /DTSTART;TZID=America\/New_York:20260302T090000/);
assert.match(ics, /RRULE:FREQ=WEEKLY;UNTIL=20260323T235959Z/);
const imported = Core.parseIcs(ics, 'UTC');
assert.equal(imported.length, 1);
assert.equal(imported[0].title, 'Planning');
assert.equal(imported[0].timeZone, 'America/New_York');
assert.equal(imported[0].recurrence.frequency, 'weekly');
assert.equal(imported[0].recurrence.until, '2026-03-23');

assert.match(html, /id="locations"/);
assert.match(html, /naklios\.fs\.useBackend/);
assert.match(html, /naklios\.beforeClose\(\(\)=>saveQueue\)/);
assert.match(html, /Import \.ics/);
assert.match(html, /Export \.ics/);
assert.doesNotMatch(html, /\b(?:alert|confirm|prompt)\s*\(/);

console.log('Calendar timezone, recurrence, ICS, and storage contract: PASS');
