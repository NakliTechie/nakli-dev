// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const host = await readFile(new URL("../index.html", import.meta.url), "utf8");

const fileConnect = host.slice(
  host.indexOf("async function crateInteractiveConnectFile()"),
  host.indexOf("async function crateInteractiveManual()"),
);
assert.match(fileConnect, /pickFile\('\.crate-creds,application\/json'\)/);
assert.match(fileConnect, /await crateConnect\(file, pass\)/);

const manualConnect = host.slice(
  host.indexOf("async function crateConnectManual("),
  host.indexOf("async function crateReconnect()"),
);
assert.match(manualConnect, /credsfile\.pack\(/);
assert.match(manualConnect, /await crateUnlock\(blob, passphrase\)/);
assert.match(manualConnect, /await crateSaveCredsBlob\(blob\)/);

for (const field of ["bucketName", "accountId", "accessKey", "secretKey", "passphrase"]) {
  assert.match(host, new RegExp(`name="${field}"`), `manual flow must expose ${field}`);
}
assert.match(host, /name="secretKey" type="password"/);
assert.match(host, /name="passphrase" type="password"/);
assert.match(host, /clearSecrets\(\)/, "manual dialog must clear secret-bearing inputs");

const chipMenu = host.slice(
  host.indexOf("function openCrateChipMenu()"),
  host.indexOf("function bindTopbarChips()"),
);
assert.match(chipMenu, /Use \.crate-creds file…/);
assert.match(chipMenu, /Enter bucket details manually…/);
assert.match(chipMenu, /crateInteractiveConnectFile\(\)/);
assert.match(chipMenu, /crateInteractiveManual\(\)/);

assert.match(host, /id="crate-connect-file"/);
assert.match(host, /id="crate-connect-manual"/);
assert.match(
  host,
  /querySelector\('#crate-connect-file'\)[\s\S]*?crateInteractiveConnectFile\(\)/,
);
assert.match(
  host,
  /querySelector\('#crate-connect-manual'\)[\s\S]*?crateInteractiveManual\(\)/,
);

console.log("OK: Crate exposes credentials-file and manual connection flows");
