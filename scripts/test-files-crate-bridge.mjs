// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const hostSource = await readFile(new URL("../index.html", import.meta.url), "utf8");
const filesSource = await readFile(
  new URL("../apps/files/index.html", import.meta.url),
  "utf8",
);

assert.match(hostSource, /<title>NakliOS —/);
assert.doesNotMatch(
  filesSource,
  /\b(?:naklOS|nakliOS|Naklios)\b/,
  "Files must use the NakliOS product spelling",
);
assert.match(
  hostSource,
  /\{\s*id:'files',[\s\S]*?kind:'system',/,
  "Files must be marked as a host-dependent system app",
);
assert.match(
  hostSource,
  /if \(app\.kind === 'system'\) return spawnIframeWindow\(app, options\);/,
  "system apps must stay inside NakliOS in Basic mode",
);
assert.match(
  filesSource,
  /<script src="\.\.\/\.\.\/sdk\/naklios\.js(?:\?[^\"]+)?"><\/script>/,
  "Files must load the full naklios.fs SDK",
);
assert.match(filesSource, /const fs = window\.naklios\?\.fs;/);
for (const method of ["list", "readBinary", "write", "delete"]) {
  assert.match(
    filesSource,
    new RegExp(`\\bfs\\.${method}\\(`),
    `Files must use naklios.fs.${method}()`,
  );
}
assert.doesNotMatch(
  filesSource,
  /host\.nakliOS|state\.fsHandle|walkToFile/,
  "Files must not bypass the backend abstraction or depend on an FSA handle",
);
assert.match(filesSource, /id="delete-dialog"/,
  "Files deletion must use an app-styled confirmation dialog");
assert.doesNotMatch(filesSource, /\bconfirm\s*\(/,
  "Files deletion must not use the browser confirm popup");

console.log("OK: Files stays hosted and uses the Crate-capable naklios.fs bridge");
