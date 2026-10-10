#!/usr/bin/env bash
# Fetch or verify the pinned Cloud Harness MCP checkout described in deps/cloud-harness.lock.json.
#
#   scripts/bootstrap-cloud-harness.sh [destination]
#
# Default destination: <repo>/.deps/cloud-harness-mcp (ignored by Git).
# - Destination missing: shallow-clone the pinned tag, then verify the commit hash.
# - Destination present: verify only (commit hash, clean tracked files). Nothing is modified or deleted.
# Environment: CHATMCP_CH_LOCK overrides the lock file (used by the tests).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
lock="${CHATMCP_CH_LOCK:-$root/deps/cloud-harness.lock.json}"
dest="${1:-$root/.deps/cloud-harness-mcp}"

field() { node -p "const v=require(process.argv[1])[process.argv[2]]; v===undefined?'':String(v)" "$lock" "$1"; }
fail() { echo "bootstrap-cloud-harness: $*" >&2; exit 1; }

command -v git >/dev/null || fail "git is required"
command -v node >/dev/null || fail "node is required (reads the lock file)"
[ -f "$lock" ] || fail "lock file not found: $lock"

repository="$(field repository)"; tag="$(field tag)"; commit="$(field commit)"
license_file="$(field licenseFile)"; license_sha="$(field licenseSha256)"
[ -n "$repository" ] && [ -n "$tag" ] && [ -n "$commit" ] && [ -n "$license_sha" ] || fail "lock file is incomplete"

if [ -e "$dest" ]; then
  git -C "$dest" rev-parse --git-dir >/dev/null 2>&1 || fail "$dest exists but is not a Git checkout; choose another destination"
  mode="verified existing checkout"
else
  mkdir -p "$(dirname "$dest")"
  git clone --quiet --depth 1 --branch "$tag" "$repository" "$dest"
  mode="cloned"
fi

head="$(git -C "$dest" rev-parse HEAD)"
[ "$head" = "$commit" ] || fail "HEAD is $head but the lock requires $commit ($tag). Nothing was deleted; inspect or remove $dest yourself."
if [ -n "$(git -C "$dest" status --porcelain --untracked-files=no)" ]; then
  fail "tracked files in $dest were modified. ChatMCP requires an unmodified pinned checkout."
fi
actual_sha="$(sha256sum "$dest/$license_file" | cut -d' ' -f1)"
[ "$actual_sha" = "$license_sha" ] || fail "$license_file hash differs from the lock; review the license before using this checkout."

echo "OK ($mode): $(field name) $tag @ ${commit:0:12}, $(field license) license verified, at $dest"
