# Crate → NakliOS setup handoff v1

Status: NakliOS receiver implemented. The Crate sender is intentionally parked
until its dirty source checkout is reconciled.

The handoff removes the credentials file as a required intermediate step. It
does not remove encryption, the user's passphrase, or explicit consent.

## Security properties

- NakliOS starts every handoff and creates a 192-bit random nonce.
- The nonce lives in memory for at most two minutes and is consumed once.
- Crate runs in a cross-origin sandboxed iframe. NakliOS requires the canonical
  `https://crate.naklios.dev` origin and that exact iframe window as the source.
- The only accepted payload is the existing encrypted `.crate-creds` v1 JSON.
  Raw account IDs, access keys, secret keys, and passphrases are not protocol
  fields.
- NakliOS validates the outer envelope, KDF, sizes, and base64 shapes before
  asking the user whether to store it.
- A handoff never overwrites an existing connection. The user must disconnect
  the existing Crate first.
- The user enters the passphrase only in NakliOS after import. It is never sent
  to Crate through this protocol and is never persisted.

## Receiver launch

NakliOS loads:

```text
https://crate.naklios.dev/
  ?naklios-handoff=v1
  &parentOrigin=https%3A%2F%2Fnaklios.dev
  &nonce=<48 lowercase hexadecimal characters>
```

Crate must treat `parentOrigin` as an allowlisted value, not a general
postMessage target. Sender v1 supports only `https://naklios.dev` (and an
explicit localhost development origin in development builds).

## Sender message

After the user explicitly chooses **Send to NakliOS**, Crate posts to its
parent:

```js
window.parent.postMessage({
  type: "crate:naklios-setup:v1",
  nonce,
  senderVersion: "1.0.0",
  encryptedCreds: JSON.stringify(encryptedEnvelope),
}, parentOrigin);
```

`encryptedEnvelope` is the byte-equivalent JSON represented by a
`.crate-creds` v1 file:

```json
{
  "v": 1,
  "type": "crate-creds",
  "hint": "bucket-name",
  "kdf": { "algo": "PBKDF2-SHA256", "iter": 600000 },
  "salt": "<base64 16 bytes>",
  "iv": "<base64 12 bytes>",
  "ct": "<base64 authenticated ciphertext>"
}
```

No decrypted credential fields may appear alongside this envelope.

## Acknowledgement

NakliOS replies to the exact Crate origin and iframe:

```js
{
  type: "naklios:crate-setup:ack:v1",
  nonce,
  status: "stored"
}
```

Other terminal statuses are `declined`, `rejected`, `already-connected`,
`failed`, and `expired`. The acknowledgement contains no credentials or
passphrase.

## Sender acceptance gate

The Crate-side implementation must prove:

1. It sends only after a direct user action in handoff mode.
2. It accepts only the NakliOS production origin (plus explicit localhost in
   development), echoes the exact nonce, and targets that origin rather than
   `*`.
3. It serializes the already-encrypted v1 envelope; it never decrypts for the
   handoff and never sends raw credential fields or a passphrase.
4. It handles every acknowledgement state and clears its in-memory handoff
   state after a terminal result.
5. Ordinary standalone Crate setup and `.crate-creds` download remain
   unchanged.

