// Identity — the FIF (handoff P0.2): the encrypted local store the rest of P0
// has been referencing but that did not exist. Three modules already name it as
// their storage owner:
//   principal.mjs:5  "storage of the private key is the FIF's job"
//   grant.mjs:10     the enforcement point "holds the root key in its FIF"
//   assay/roles.mjs  "rootKey is the issuer secret (FIF)"
// Until now every mintPrincipal()/newRootKey() was ephemeral, so an agent minted
// in one page load could not be verified in the next. This makes identity durable.
//
// Holds exactly three things, because that is what P0 needs and nothing more:
//   rootKey     the issuer secret grants are HMAC-chained from
//   principals  descriptor + keypair (private key as pkcs8), by principal id
//   grants      issued grants + the revocation list verifyGrant demands at
//               EVERY call (grant.mjs:120-124 — an omitted list means "no
//               revocations", so the list must have a durable home)
//
// Encrypted at rest with AES-256-GCM under a passphrase-derived key; the whole
// vault is one record, so a write is atomic. Storage is INJECTED (`backend`), so
// the same store runs over memory in tests, OPFS in the browser, and — when the
// fabric's own FIF lands — over that, without the callers changing. The vault
// carries its own `kdf` params, so a KDF upgrade re-wraps rather than breaks.
//
// Sovereign: no account, no server, no key ever leaves the device.

import { randomBytes, b64uEncode, b64uDecode, deriveKey, aesGcmEncrypt, aesGcmDecrypt, PBKDF2_ITERATIONS } from './crypto.mjs';
import { exportKeypair, importKeypair } from './principal.mjs';

export const FIF_VERSION = 1;
const RECORD = 'fif.v1';
// The vault record is bound to its own version+salt, so a body cannot be lifted
// into a vault with different KDF params and still authenticate.
const aadFor = (vault) => `naklios.fif.v${vault.version}:${vault.kdf.salt}`;

const emptyBody = () => ({ rootKey: null, principals: {}, grants: [], revoked: [] });

// ---------------------------------------------------------------- backends ---

export function memoryBackend(seed = null) {
  let cell = seed;
  return {
    async read() { return cell; },
    async write(v) { cell = v; },
    async clear() { cell = null; },
  };
}

// OPFS — the browser's origin-private filesystem. Durable (subject to eviction
// unless navigator.storage.persist() was granted; the host requests it at boot).
export function opfsBackend(filename = 'naklios-fif.json') {
  const dir = async () => navigator.storage.getDirectory();
  return {
    async read() {
      try {
        const fh = await (await dir()).getFileHandle(filename);
        const text = await (await fh.getFile()).text();
        return text ? JSON.parse(text) : null;
      } catch (_) { return null; } // absent file is "no vault", not an error
    },
    async write(v) {
      const fh = await (await dir()).getFileHandle(filename, { create: true });
      const w = await fh.createWritable();
      await w.write(JSON.stringify(v));
      await w.close();
    },
    async clear() {
      try { await (await dir()).removeEntry(filename); } catch (_) { /* already gone */ }
    },
  };
}

// ------------------------------------------------------------------ store ---

export class FifLockedError extends Error {
  constructor() { super('FIF is locked — unlock(passphrase) first'); this.code = 'ELOCKED'; }
}
export class FifPassphraseError extends Error {
  constructor() { super('wrong passphrase (or the vault is corrupt)'); this.code = 'EPASS'; }
}

export function createFifStore({ backend = memoryBackend(), iterations = PBKDF2_ITERATIONS } = {}) {
  let key = null;   // the derived AES key while unlocked (non-extractable)
  let vault = null; // the on-disk envelope (kdf params + ciphertext)
  let body = null;  // the decrypted contents, in memory only while unlocked

  const requireOpen = () => { if (!body) throw new FifLockedError(); };

  async function persist() {
    requireOpen();
    vault.body = await aesGcmEncrypt(key, JSON.stringify(body), aadFor(vault));
    await backend.write(vault);
  }

  return {
    get locked() { return body === null; },

    async exists() { return (await backend.read()) !== null; },

    // Create a new vault. Refuses to clobber an existing one unless `force` —
    // overwriting a FIF destroys every principal's private key irrecoverably.
    async create(passphrase, { force = false } = {}) {
      if (!passphrase) throw new Error('a FIF needs a passphrase');
      if (!force && (await backend.read()) !== null) throw new Error('a FIF already exists here — unlock it, or pass { force: true } to destroy it');
      const salt = b64uEncode(randomBytes(16));
      vault = { version: FIF_VERSION, kdf: { algo: 'PBKDF2-SHA256', iterations, salt }, body: null };
      key = await deriveKey(passphrase, b64uDecode(salt), iterations);
      body = emptyBody();
      body.rootKey = b64uEncode(randomBytes(32)); // the issuer secret, generated once and never re-derived
      await persist();
      return true;
    },

    async unlock(passphrase) {
      const stored = await backend.read();
      if (!stored) throw new Error('no FIF at this backend — create(passphrase) first');
      if (stored.version !== FIF_VERSION) throw new Error(`unsupported FIF version ${stored.version}`);
      const k = await deriveKey(passphrase, b64uDecode(stored.kdf.salt), stored.kdf.iterations);
      let plain;
      // A GCM auth failure IS the wrong-passphrase signal — there is no separate
      // verifier to check, and adding one would only leak a cheaper oracle.
      try { plain = await aesGcmDecrypt(k, stored.body, aadFor(stored)); }
      catch (_) { throw new FifPassphraseError(); }
      vault = stored; key = k;
      body = { ...emptyBody(), ...JSON.parse(new TextDecoder().decode(plain)) };
      return true;
    },

    lock() { key = null; body = null; vault = null; },

    // The issuer secret. Callers pass it straight to issueGrant/verifyGrant.
    rootKey() { requireOpen(); return b64uDecode(body.rootKey); },

    // ---- principals ----
    // Stores the descriptor plus the keypair. `mintPrincipal` returns exactly
    // { descriptor, keypair }, so a mint round-trips through here unchanged.
    async putPrincipal({ descriptor, keypair }) {
      requireOpen();
      if (!descriptor || !descriptor.id) throw new Error('putPrincipal needs a descriptor');
      body.principals[descriptor.id] = {
        descriptor,
        keypair: keypair ? await exportKeypair(keypair) : null, // an imported external principal has no private key
      };
      await persist();
      return descriptor.id;
    },
    async getPrincipal(id) {
      requireOpen();
      const rec = body.principals[id];
      if (!rec) return null;
      return { descriptor: rec.descriptor, keypair: rec.keypair ? await importKeypair(rec.keypair) : null };
    },
    listPrincipals() {
      requireOpen();
      return Object.values(body.principals).map((r) => r.descriptor);
    },

    // ---- grants ----
    async putGrant(grant, { label = '', principal = null } = {}) {
      requireOpen();
      if (!grant || !grant.identifier) throw new Error('putGrant needs a grant');
      body.grants = body.grants.filter((g) => g.grant.identifier !== grant.identifier);
      body.grants.push({ grant, label: String(label), principal });
      await persist();
      return grant.identifier;
    },
    listGrants() { requireOpen(); return body.grants.map((g) => ({ ...g })); },
    getGrant(id) { requireOpen(); const g = body.grants.find((x) => x.grant.identifier === id); return g ? g.grant : null; },

    // Revocation. verifyGrant treats an omitted list as "nothing revoked", so
    // this list is the one every enforcement point must pass.
    async revoke(grantId) {
      requireOpen();
      if (!body.revoked.includes(grantId)) body.revoked.push(grantId);
      await persist();
      return true;
    },
    revocationList() { requireOpen(); return new Set(body.revoked); },
  };
}
