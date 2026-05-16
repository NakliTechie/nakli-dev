#!/usr/bin/env bash
# Mirror upstream apps' index.html into apps/<id>/index.html.
#
# Reads apps/manifest.json; for each entry, downloads the source file from
# raw.githubusercontent.com and writes it to apps/<id>/<basename>. Idempotent.
#
# Run via .github/workflows/sync-mirrors.yml (scheduled + manual dispatch),
# or locally:  bash scripts/sync-mirrors.sh
#
# Why same-origin mirroring: FSA picker and similar capability-gated APIs
# are blocked in cross-origin iframes. Apps that need them are mirrored
# under naklios.dev/apps/<id>/ so naklOS can embed them same-origin.

set -euo pipefail

MANIFEST="apps/manifest.json"

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required" >&2
  exit 1
fi

count=$(jq '.apps | length' "$MANIFEST")
echo "Syncing $count app(s) from manifest…"

for i in $(seq 0 $((count - 1))); do
  id=$(jq -r ".apps[$i].id" "$MANIFEST")
  repo=$(jq -r ".apps[$i].repo" "$MANIFEST")
  branch=$(jq -r ".apps[$i].branch" "$MANIFEST")
  file=$(jq -r ".apps[$i].file" "$MANIFEST")
  src="https://raw.githubusercontent.com/${repo}/${branch}/${file}"
  dst="apps/${id}/$(basename "$file")"
  mkdir -p "apps/${id}"
  echo "  ${id} ← ${src}"
  curl -fsSL "$src" -o "$dst"
done

echo "Done. Run \`git diff apps/\` to see what changed."
