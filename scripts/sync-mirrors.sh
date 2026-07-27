#!/usr/bin/env bash
# Mirror upstream apps' index.html into apps/<id>/index.html.
#
# Resolves each requested branch/tag to an immutable Git commit, downloads its
# declared artifacts, and records their SHA-256 hashes in manifest.lock.json.
#
# Run via .github/workflows/sync-mirrors.yml (scheduled + manual dispatch),
# or locally:  bash scripts/sync-mirrors.sh [--app <id>]
#
# Why same-origin mirroring: FSA picker and similar capability-gated APIs
# are blocked in cross-origin iframes. Apps that need them are mirrored
# under naklios.dev/apps/<id>/ so NakliOS can embed them same-origin.

set -euo pipefail
exec node scripts/sync-mirrors.mjs "$@"
