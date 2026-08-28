// Identity — machine principals (handoff P0.2). A principal is a keypair + a
// signed PrincipalDescriptor; an AGENT principal is minted by a person and carries
// the minting link, so History can always trace an agent action back to the human
// who authorised it (the attribution root). Extends the fabric FIF's keypair model;
// storage of the private key is the FIF's job (injected — see createFifStore).
//
// This module is pure over WebCrypto (crypto.mjs). No accounts, no server.

import { generateSigningKeypair, exportRawPub, exportPkcs8, importPkcs8, importRawPub, sign, verify, sha256Hex, b64uEncode, b64uDecode } from './crypto.mjs';

export const PRINCIPAL_KINDS = Object.freeze(['person', 'agent', 'system', 'external']);

// id = "prin_" + hex(sha256(rawPubkey)) — stable, derived from the public key.
export async function principalId(rawPub) {
  return 'prin_' + (await sha256Hex(rawPub instanceof Uint8Array ? rawPub : b64uDecode(rawPub)));
}

// The bytes a descriptor's signature covers — canonical, excludes `sig`.
function descriptorPayload(d) {
  return JSON.stringify({ id: d.id, kind: d.kind, pubkey: d.pubkey, label: d.label ?? '', mintedBy: d.mintedBy ?? null, mintedAt: d.mintedAt });
}

// Mint a principal. `minter` is { descriptor, keypair } of the person minting an
// agent (or null/undefined for a root person/system, which self-signs). Returns
// { descriptor, keypair } — the caller stores the private key in the FIF.
export async function mintPrincipal(minter, { kind, label = '', now = () => Date.now() } = {}) {
  if (!PRINCIPAL_KINDS.includes(kind)) throw new Error(`unknown principal kind "${kind}"`);
  if (kind === 'external') throw new Error('external principals are imported (importExternal), not minted');
  const keypair = await generateSigningKeypair();
  const rawPub = await exportRawPub(keypair.publicKey);
  const id = await principalId(rawPub);
  const descriptor = {
    id, kind, pubkey: b64uEncode(rawPub), label: String(label),
    mintedBy: minter && minter.descriptor ? minter.descriptor.id : null,
    mintedAt: new Date(now()).toISOString(),
  };
  // A minted principal is signed by its minter; a root principal self-signs.
  const signerKey = minter && minter.keypair ? minter.keypair.privateKey : keypair.privateKey;
  descriptor.sig = b64uEncode(await sign(signerKey, descriptorPayload(descriptor)));
  return { descriptor, keypair };
}

// Verify a descriptor. `minterPubkey` (raw bytes or b64u) verifies a minted
// principal; omit it (or pass null) for a root/self-signed principal, which is
// verified against its own pubkey. Also checks id === sha256(pubkey).
export async function verifyDescriptor(descriptor, minterPubkey = null) {
  if (!descriptor || !descriptor.sig || !descriptor.pubkey) return false;
  const expectId = await principalId(descriptor.pubkey);
  if (descriptor.id !== expectId) return false;
  const against = descriptor.mintedBy && minterPubkey ? minterPubkey : descriptor.pubkey; // self-signed when no minter
  try { return await verify(against, descriptor.sig, descriptorPayload(descriptor)); }
  catch (_) { return false; }
}

// Import an external principal (verify-only; may never act locally).
export async function importExternal(rawPub, { label = '' } = {}) {
  const id = await principalId(rawPub);
  return { id, kind: 'external', pubkey: b64uEncode(rawPub instanceof Uint8Array ? rawPub : b64uDecode(rawPub)), label: String(label), mintedBy: null, mintedAt: null };
}

// Serialize/restore a keypair for FIF storage (private key as pkcs8, b64u).
export async function exportKeypair(keypair) {
  return { publicKey: b64uEncode(await exportRawPub(keypair.publicKey)), privateKey: b64uEncode(await exportPkcs8(keypair.privateKey)) };
}
export async function importKeypair({ publicKey, privateKey }) {
  return { publicKey: await importRawPub(publicKey), privateKey: await importPkcs8(privateKey) };
}
