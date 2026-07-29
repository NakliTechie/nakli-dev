import { readdir } from 'node:fs/promises';
import path from 'node:path';

function appObjectsFromHtml(html) {
  const start = html.indexOf('const APPS = [');
  const end = html.indexOf('const FOLDERS = [', start);
  if (start < 0 || end < 0) throw new Error('could not find the static APPS catalog');
  const source = html.slice(start, end);
  const objects = [];
  let quote = null;
  let escaped = false;
  let depth = 0;
  let objectStart = -1;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') {
      if (depth === 0) objectStart = index;
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        objects.push(source.slice(objectStart, index + 1));
        objectStart = -1;
      }
    }
  }
  return objects.map(sourceObject => ({
    id: sourceObject.match(/\bid\s*:\s*'([^']+)'/)?.[1] || null,
    kind: sourceObject.match(/\bkind\s*:\s*'([^']+)'/)?.[1] || null,
    embedUrl: sourceObject.match(/\bembedUrl\s*:\s*'([^']+)'/)?.[1] || null,
  })).filter(app => app.id);
}

async function filesUnder(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await filesUnder(path.join(directory, entry.name), relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files.sort();
}

export async function auditAppInventory(rootDir, html, manifest, lock) {
  const errors = [];
  const apps = appObjectsFromHtml(html);
  const byId = new Map(apps.map(app => [app.id, app]));
  if (byId.size !== apps.length) errors.push('static app catalog contains duplicate ids');

  const mirrors = new Map((manifest?.apps || []).map(app => [app.id, app]));
  const lockedIds = new Set((lock?.apps || []).map(app => app.id));
  if (mirrors.size !== (manifest?.apps || []).length) errors.push('mirror manifest contains duplicate ids');
  if (lockedIds.size !== (lock?.apps || []).length) errors.push('mirror lock contains duplicate ids');

  for (const [id, mirror] of mirrors) {
    const app = byId.get(id);
    if (!app) {
      errors.push(`${id}: mirror is not present in the NakliOS app catalog`);
      continue;
    }
    if (!lockedIds.has(id)) errors.push(`${id}: mirror has no immutable lock entry`);
    let mirrorPath = '';
    try {
      mirrorPath = new URL(app.embedUrl || '', 'https://naklios.dev/').pathname;
    } catch {}
    if (mirrorPath !== `/apps/${id}/`) {
      errors.push(`${id}: catalog embedUrl must resolve to /apps/${id}/`);
    }
    const expected = (mirror.files || [])
      .map(file => typeof file === 'string' ? path.posix.basename(file) : file.destination || path.posix.basename(file.source))
      .sort();
    const actual = await filesUnder(path.join(rootDir, 'apps', id));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      errors.push(`${id}: mirrored files differ from manifest (expected ${expected.join(', ') || 'none'}; found ${actual.join(', ') || 'none'})`);
    }
  }

  for (const id of lockedIds) {
    if (!mirrors.has(id)) errors.push(`${id}: stale lock entry is not present in the mirror manifest`);
  }

  for (const app of apps) {
    if (!app.embedUrl) continue;
    let embedded = null;
    try { embedded = new URL(app.embedUrl, 'https://naklios.dev/'); } catch {}
    const sameOriginAppPath = embedded?.origin === 'https://naklios.dev'
      && embedded.pathname === `/apps/${app.id}/`;
    if (sameOriginAppPath && app.kind !== 'system' && !mirrors.has(app.id)) {
      errors.push(`${app.id}: same-origin catalog app is neither a system app nor a declared mirror`);
    }
  }

  const directories = await readdir(path.join(rootDir, 'apps'), { withFileTypes: true });
  for (const entry of directories.filter(item => item.isDirectory())) {
    const files = await filesUnder(path.join(rootDir, 'apps', entry.name));
    if (files.length === 0) continue;
    const app = byId.get(entry.name);
    if (!app) errors.push(`${entry.name}: on-disk app has no catalog entry`);
    else if (app.kind !== 'system' && !mirrors.has(entry.name)) {
      errors.push(`${entry.name}: on-disk app is neither a system app nor a declared mirror`);
    }
  }
  return errors;
}

