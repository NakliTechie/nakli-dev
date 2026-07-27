#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeManifest, sha256 } from './mirror-lib.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(rootDir, 'apps', 'manifest.json');
const lockPath = path.join(rootDir, 'apps', 'manifest.lock.json');

function selectedIds(argv) {
  const ids = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--app' || !argv[i + 1]) {
      throw new Error(`usage: node scripts/sync-mirrors.mjs [--app <id>]`);
    }
    ids.add(argv[++i]);
  }
  return ids;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

async function fetchBytes(url, headers) {
  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchJson(url, headers) {
  return JSON.parse((await fetchBytes(url, headers)).toString('utf8'));
}

function encodeSourcePath(source) {
  return source.split('/').map(encodeURIComponent).join('/');
}

async function writeIfChanged(file, bytes) {
  try {
    if (Buffer.compare(await readFile(file), bytes) === 0) return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, file);
  return true;
}

const ids = selectedIds(process.argv.slice(2));
const manifest = normalizeManifest(await readJson(manifestPath));
const unknownIds = [...ids].filter(id => !manifest.apps.some(app => app.id === id));
if (unknownIds.length) throw new Error(`unknown mirror id(s): ${unknownIds.join(', ')}`);
const targets = ids.size ? manifest.apps.filter(app => ids.has(app.id)) : manifest.apps;
const oldLock = await readJson(lockPath, { version: 1, apps: [] });
const lockById = new Map((oldLock.apps || []).map(app => [app.id, app]));
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'NakliOS-mirror-sync',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

console.log(`Resolving ${targets.length} mirror(s) to immutable commits…`);
const resolved = [];
for (const app of targets) {
  const commitApi = `https://api.github.com/repos/${app.repo}/commits/${encodeURIComponent(app.requestedRef)}`;
  const commit = await fetchJson(commitApi, headers);
  if (!/^[0-9a-f]{40}$/.test(commit.sha || '')) {
    throw new Error(`${app.id}: GitHub did not return a full commit SHA`);
  }
  const files = [];
  for (const file of app.files) {
    const rawUrl = `https://raw.githubusercontent.com/${app.repo}/${commit.sha}/${encodeSourcePath(file.source)}`;
    const bytes = await fetchBytes(rawUrl, headers);
    files.push({
      ...file,
      bytes,
      sha256: sha256(bytes),
    });
  }
  resolved.push({ app, commit: commit.sha, files });
}

let changed = 0;
for (const item of resolved) {
  for (const file of item.files) {
    const destination = path.join(rootDir, 'apps', item.app.id, ...file.destination.split('/'));
    if (await writeIfChanged(destination, file.bytes)) changed += 1;
    console.log(`  ${item.app.id}/${file.destination} ← ${item.commit.slice(0, 12)}:${file.source}`);
  }
  lockById.set(item.app.id, {
    id: item.app.id,
    repo: item.app.repo,
    requestedRef: item.app.requestedRef,
    resolvedCommit: item.commit,
    files: item.files.map(file => ({
      source: file.source,
      destination: file.destination,
      sha256: file.sha256,
      bytes: file.bytes.byteLength,
    })),
  });
}

const lock = {
  version: 1,
  apps: manifest.apps.filter(app => lockById.has(app.id)).map(app => lockById.get(app.id)),
};
const lockBytes = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`);
if (await writeIfChanged(lockPath, lockBytes)) changed += 1;
console.log(`Done. ${changed} file(s) changed; validate with node scripts/validate-mirrors.mjs.`);
