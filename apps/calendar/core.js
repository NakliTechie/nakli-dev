(function (root) {
  'use strict';

  const pad = value => String(value).padStart(2, '0');
  const dateOnly = value => String(value || '').slice(0, 10);

  function localParts(value) {
    const match = String(value || '').match(
      /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/,
    );
    if (!match) throw new Error(`Invalid local date: ${value}`);
    return {
      year:Number(match[1]), month:Number(match[2]), day:Number(match[3]),
      hour:Number(match[4] || 0), minute:Number(match[5] || 0), second:Number(match[6] || 0),
    };
  }

  function partsToStamp(parts, date=false) {
    const day = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
    return date ? day : `${day}T${pad(parts.hour)}:${pad(parts.minute)}`;
  }

  function partsInZone(instant, timeZone) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone, year:'numeric', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23',
    });
    const values = {};
    for (const part of formatter.formatToParts(new Date(instant))) {
      if (part.type !== 'literal') values[part.type] = Number(part.value);
    }
    return {
      year:values.year, month:values.month, day:values.day,
      hour:values.hour === 24 ? 0 : values.hour, minute:values.minute, second:values.second,
    };
  }

  function partsAsUtc(parts) {
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  }

  function wallToUtc(value, timeZone) {
    const wanted = localParts(value);
    const target = partsAsUtc(wanted);
    let guess = target;
    for (let pass = 0; pass < 4; pass++) {
      const seen = partsAsUtc(partsInZone(guess, timeZone));
      const adjustment = target - seen;
      guess += adjustment;
      if (!adjustment) break;
    }
    return new Date(guess).toISOString();
  }

  function utcToWall(value, timeZone) {
    return partsToStamp(partsInZone(new Date(value).getTime(), timeZone));
  }

  function addLocal(value, frequency, amount=1) {
    const parts = localParts(value);
    const date = new Date(Date.UTC(
      parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second,
    ));
    if (frequency === 'daily') date.setUTCDate(date.getUTCDate() + amount);
    else if (frequency === 'weekly') date.setUTCDate(date.getUTCDate() + 7 * amount);
    else if (frequency === 'monthly') {
      const wantedDay = date.getUTCDate();
      date.setUTCDate(1);
      date.setUTCMonth(date.getUTCMonth() + amount);
      const finalDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      date.setUTCDate(Math.min(wantedDay, finalDay));
    } else if (frequency === 'yearly') {
      const month = date.getUTCMonth();
      date.setUTCFullYear(date.getUTCFullYear() + amount);
      if (date.getUTCMonth() !== month) date.setUTCDate(0);
    }
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth()+1)}-${pad(date.getUTCDate())}` +
      (String(value).includes('T') ? `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}` : '');
  }

  function eventDuration(event) {
    if (event.allDay) {
      const start = Date.parse(`${dateOnly(event.startLocal)}T00:00:00Z`);
      const end = Date.parse(`${dateOnly(event.endLocal)}T00:00:00Z`);
      return Math.max(86400000, end - start);
    }
    return Math.max(0, Date.parse(wallToUtc(event.endLocal, event.timeZone)) -
      Date.parse(wallToUtc(event.startLocal, event.timeZone)));
  }

  function occurrenceFor(event, startLocal) {
    if (event.allDay) {
      const durationDays = Math.max(1, Math.round(eventDuration(event) / 86400000));
      return {
        eventId:event.id, startLocal:dateOnly(startLocal),
        endLocal:addLocal(dateOnly(startLocal), 'daily', durationDays),
        startUtc:`${dateOnly(startLocal)}T00:00:00.000Z`,
        endUtc:`${addLocal(dateOnly(startLocal), 'daily', durationDays)}T00:00:00.000Z`,
      };
    }
    const startUtc = wallToUtc(startLocal, event.timeZone);
    return {
      eventId:event.id, startLocal, endLocal:utcToWall(
        new Date(Date.parse(startUtc) + eventDuration(event)).toISOString(), event.timeZone,
      ),
      startUtc,
      endUtc:new Date(Date.parse(startUtc) + eventDuration(event)).toISOString(),
    };
  }

  function expandEvent(event, rangeStart, rangeEnd, limit=1200) {
    const frequency = event.recurrence?.frequency || 'none';
    const interval = Math.max(1, Number(event.recurrence?.interval) || 1);
    const until = event.recurrence?.until ? dateOnly(event.recurrence.until) : null;
    const out = [];
    let cursor = event.startLocal;
    for (let index = 0; index < limit; index++) {
      const occurrence = occurrenceFor(event, cursor);
      if (Date.parse(occurrence.endUtc) > rangeStart && Date.parse(occurrence.startUtc) < rangeEnd) {
        out.push({ ...occurrence, event });
      }
      if (frequency === 'none') break;
      cursor = addLocal(cursor, frequency, interval);
      if (until && dateOnly(cursor) > until) break;
      if (Date.parse(occurrence.startUtc) >= rangeEnd && dateOnly(cursor) > dateOnly(event.startLocal)) break;
    }
    return out;
  }

  function expandEvents(events, rangeStart, rangeEnd) {
    return events.flatMap(event => expandEvent(event, rangeStart, rangeEnd))
      .sort((a,b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));
  }

  function icsEscape(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n')
      .replace(/,/g, '\\,').replace(/;/g, '\\;');
  }
  function icsUnescape(value) {
    return String(value || '').replace(/\\n/gi, '\n').replace(/\\([\\,;])/g, '$1');
  }
  function icsStamp(local, allDay=false) {
    const clean = String(local).replace(/[-:]/g, '');
    return allDay ? clean.slice(0,8) : `${clean.replace('T','T')}00`;
  }
  function parseIcsStamp(value) {
    const raw = String(value || '').trim();
    const date = `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`;
    if (raw.length <= 8) return date;
    return `${date}T${raw.slice(9,11)}:${raw.slice(11,13)}`;
  }
  function foldIcs(line) {
    const chunks = [];
    let rest = line;
    while (rest.length > 73) { chunks.push(rest.slice(0,73)); rest = ` ${rest.slice(73)}`; }
    chunks.push(rest);
    return chunks.join('\r\n');
  }

  function exportIcs(events, product='NakliOS Calendar') {
    const lines = ['BEGIN:VCALENDAR','VERSION:2.0',`PRODID:-//NakliTechie//${product}//EN`,'CALSCALE:GREGORIAN'];
    for (const event of events) {
      lines.push('BEGIN:VEVENT', `UID:${icsEscape(event.id)}`,
        `DTSTAMP:${new Date(event.updatedAt || Date.now()).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'')}`);
      if (event.allDay) {
        lines.push(`DTSTART;VALUE=DATE:${icsStamp(event.startLocal,true)}`,
          `DTEND;VALUE=DATE:${icsStamp(event.endLocal,true)}`);
      } else {
        lines.push(`DTSTART;TZID=${event.timeZone}:${icsStamp(event.startLocal)}`,
          `DTEND;TZID=${event.timeZone}:${icsStamp(event.endLocal)}`);
      }
      lines.push(`SUMMARY:${icsEscape(event.title)}`);
      if (event.location) lines.push(`LOCATION:${icsEscape(event.location)}`);
      if (event.description) lines.push(`DESCRIPTION:${icsEscape(event.description)}`);
      const recurrence = event.recurrence || {};
      if (recurrence.frequency && recurrence.frequency !== 'none') {
        let rule = `FREQ=${recurrence.frequency.toUpperCase()}`;
        if (Number(recurrence.interval) > 1) rule += `;INTERVAL=${Number(recurrence.interval)}`;
        if (recurrence.until) rule += `;UNTIL=${String(recurrence.until).replace(/-/g,'')}T235959Z`;
        lines.push(`RRULE:${rule}`);
      }
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.map(foldIcs).join('\r\n') + '\r\n';
  }

  function parseIcs(text, defaultTimeZone='UTC') {
    const unfolded = String(text || '').replace(/\r?\n[ \t]/g, '');
    const lines = unfolded.split(/\r?\n/);
    const events = [];
    let current = null;
    for (const line of lines) {
      if (line === 'BEGIN:VEVENT') { current = {}; continue; }
      if (line === 'END:VEVENT') {
        if (current?.startLocal) {
          const allDay = current.allDay === true;
          const start = current.startLocal;
          const end = current.endLocal || addLocal(start, 'daily', allDay ? 1 : 0);
          events.push({
            id:current.uid || `event-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`,
            title:current.summary || 'Untitled event', description:current.description || '',
            location:current.location || '', startLocal:start, endLocal:end,
            allDay, timeZone:current.timeZone || defaultTimeZone,
            recurrence:current.recurrence || { frequency:'none', interval:1, until:null },
            createdAt:Date.now(), updatedAt:Date.now(),
          });
        }
        current = null; continue;
      }
      if (!current) continue;
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const left = line.slice(0,colon); const value = line.slice(colon+1);
      const [name, ...params] = left.split(';');
      const paramMap = Object.fromEntries(params.map(part => {
        const at = part.indexOf('='); return at < 0 ? [part,''] : [part.slice(0,at),part.slice(at+1)];
      }));
      if (name === 'UID') current.uid = icsUnescape(value);
      else if (name === 'SUMMARY') current.summary = icsUnescape(value);
      else if (name === 'DESCRIPTION') current.description = icsUnescape(value);
      else if (name === 'LOCATION') current.location = icsUnescape(value);
      else if (name === 'DTSTART' || name === 'DTEND') {
        const allDay = paramMap.VALUE === 'DATE' || /^\d{8}$/.test(value);
        const timeZone = paramMap.TZID || current.timeZone || defaultTimeZone;
        let local;
        if (/Z$/.test(value)) local = utcToWall(
          `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(9,11)}:${value.slice(11,13)}:${value.slice(13,15)}Z`,
          timeZone,
        );
        else local = parseIcsStamp(value);
        current[name === 'DTSTART' ? 'startLocal' : 'endLocal'] = local;
        current.allDay = allDay; current.timeZone = timeZone;
      } else if (name === 'RRULE') {
        const values = Object.fromEntries(value.split(';').map(part => part.split('=')));
        current.recurrence = {
          frequency:String(values.FREQ || 'none').toLowerCase(),
          interval:Math.max(1, Number(values.INTERVAL) || 1),
          until:values.UNTIL ? `${values.UNTIL.slice(0,4)}-${values.UNTIL.slice(4,6)}-${values.UNTIL.slice(6,8)}` : null,
        };
      }
    }
    return events;
  }

  root.CalendarCore = Object.freeze({
    addLocal, dateOnly, expandEvent, expandEvents, exportIcs, parseIcs,
    utcToWall, wallToUtc,
  });
})(typeof window === 'undefined' ? globalThis : window);
