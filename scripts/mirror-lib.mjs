import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function safeRelative(value, label) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.includes('..') || parts.includes('.') || parts.includes('')) {
    throw new Error(`${label} contains an unsafe path segment`);
  }
  return parts.join('/');
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function normalizeManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.apps)) {
    throw new Error('apps/manifest.json must contain an apps array');
  }
  if (Number(manifest.version || 1) !== 1) {
    throw new Error(`unsupported mirror manifest version: ${manifest.version}`);
  }

  const ids = new Set();
  const apps = manifest.apps.map((raw, index) => {
    const label = `apps[${index}]`;
    const id = raw?.id;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new Error(`${label}.id must be a lowercase app slug`);
    }
    if (ids.has(id)) throw new Error(`duplicate mirror id: ${id}`);
    ids.add(id);

    const repo = raw.repo;
    if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      throw new Error(`${label}.repo must be an owner/repository name`);
    }
    const requestedRef = raw.ref || raw.branch;
    if (typeof requestedRef !== 'string' || !requestedRef.trim()) {
      throw new Error(`${label}.ref is required`);
    }

    const rawFiles = raw.files || (raw.file ? [{ source: raw.file }] : []);
    if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
      throw new Error(`${label}.files must contain at least one artifact`);
    }
    const destinations = new Set();
    const files = rawFiles.map((rawFile, fileIndex) => {
      const source = safeRelative(
        typeof rawFile === 'string' ? rawFile : rawFile?.source,
        `${label}.files[${fileIndex}].source`,
      );
      const destination = safeRelative(
        typeof rawFile === 'string'
          ? path.posix.basename(source)
          : rawFile.destination || path.posix.basename(source),
        `${label}.files[${fileIndex}].destination`,
      );
      if (destinations.has(destination)) {
        throw new Error(`${label} has duplicate destination: ${destination}`);
      }
      destinations.add(destination);
      return { source, destination };
    });

    return { id, repo, requestedRef, files };
  });

  return { version: Number(manifest.version || 1), apps };
}

export async function validateMirrorState(rootDir, manifest, lock) {
  const errors = [];
  const normalized = normalizeManifest(manifest);
  if (!lock || lock.version !== 1 || !Array.isArray(lock.apps)) {
    return ['apps/manifest.lock.json must be a version 1 lockfile with an apps array'];
  }
  const lockedById = new Map(lock.apps.map(app => [app.id, app]));
  if (lockedById.size !== lock.apps.length) errors.push('lockfile contains duplicate app ids');

  for (const app of normalized.apps) {
    const locked = lockedById.get(app.id);
    if (!locked) {
      errors.push(`${app.id}: missing lock entry`);
      continue;
    }
    if (locked.repo !== app.repo) errors.push(`${app.id}: repository differs from lock`);
    if (locked.requestedRef !== app.requestedRef) errors.push(`${app.id}: requested ref differs from lock`);
    if (!SHA40.test(locked.resolvedCommit || '')) errors.push(`${app.id}: invalid resolved commit`);
    if (!Array.isArray(locked.files)) {
      errors.push(`${app.id}: lock entry has no files`);
      continue;
    }
    const lockedFiles = new Map(locked.files.map(file => [file.destination, file]));
    for (const file of app.files) {
      const lockedFile = lockedFiles.get(file.destination);
      if (!lockedFile) {
        errors.push(`${app.id}/${file.destination}: missing lock entry`);
        continue;
      }
      if (lockedFile.source !== file.source) {
        errors.push(`${app.id}/${file.destination}: source differs from lock`);
      }
      if (!SHA256.test(lockedFile.sha256 || '')) {
        errors.push(`${app.id}/${file.destination}: invalid SHA-256`);
        continue;
      }
      if (!Number.isInteger(lockedFile.bytes) || lockedFile.bytes < 0) {
        errors.push(`${app.id}/${file.destination}: invalid artifact byte size`);
      }
      const artifactPath = path.join(rootDir, 'apps', app.id, ...file.destination.split('/'));
      try {
        const bytes = await readFile(artifactPath);
        if (sha256(bytes) !== lockedFile.sha256) {
          errors.push(`${app.id}/${file.destination}: artifact differs from locked SHA-256`);
        }
        if (Number.isInteger(lockedFile.bytes) && bytes.byteLength !== lockedFile.bytes) {
          errors.push(`${app.id}/${file.destination}: artifact size differs from lock`);
        }
      } catch (error) {
        errors.push(`${app.id}/${file.destination}: ${error.code === 'ENOENT' ? 'artifact is missing' : error.message}`);
      }
    }
    for (const lockedFile of locked.files) {
      if (!app.files.some(file => file.destination === lockedFile.destination)) {
        errors.push(`${app.id}/${lockedFile.destination}: stale file lock is not present in manifest`);
      }
    }
  }

  for (const locked of lock.apps) {
    if (!normalized.apps.some(app => app.id === locked.id)) {
      errors.push(`${locked.id}: stale lock entry is not present in manifest`);
    }
  }
  return errors;
}
