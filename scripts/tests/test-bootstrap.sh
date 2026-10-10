#!/usr/bin/env bash
# Tests scripts/bootstrap-cloud-harness.sh against a local fixture repository (no network).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/../bootstrap-cloud-harness.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failures=0
check() { if [ "$1" = "0" ]; then echo "  ok - $2"; else echo "  FAIL - $2"; failures=$((failures + 1)); fi; }

up="$tmp/upstream"
mkdir "$up"
git -C "$up" init -q -b main
git -C "$up" config user.email test@example.invalid
git -C "$up" config user.name test
printf 'MIT License\n\nfixture\n' > "$up/LICENSE"
git -C "$up" add LICENSE
git -C "$up" commit -q -m init
git -C "$up" tag v0.0.1
commit="$(git -C "$up" rev-parse HEAD)"
sha="$(sha256sum "$up/LICENSE" | cut -d' ' -f1)"

write_lock() {
  printf '{"name":"fixture","repository":"file://%s","tag":"v0.0.1","commit":"%s","license":"MIT","licenseFile":"LICENSE","licenseSha256":"%s"}\n' "$up" "$1" "$2" > "$tmp/lock.json"
}
run() { CHATMCP_CH_LOCK="$tmp/lock.json" bash "$script" "$@" 2>&1; }

echo "clone and verify"
write_lock "$commit" "$sha"
out="$(run "$tmp/dest")"; rc=$?
check "$rc" "fresh clone succeeds"
case "$out" in *"OK (cloned)"*) check 0 "reports cloned";; *) check 1 "reports cloned";; esac

echo "verify existing checkout"
out="$(run "$tmp/dest")"; rc=$?
check "$rc" "existing checkout verifies"
case "$out" in *"verified existing checkout"*) check 0 "reports verified existing";; *) check 1 "reports verified existing";; esac

echo "modified tracked file is rejected and not touched"
echo extra >> "$tmp/dest/LICENSE"
out="$(run "$tmp/dest")"; rc=$?
[ "$rc" != "0" ] && check 0 "modified checkout fails" || check 1 "modified checkout fails"
[ -f "$tmp/dest/LICENSE" ] && check 0 "file left in place" || check 1 "file left in place"
git -C "$tmp/dest" checkout -q -- LICENSE

echo "wrong commit in the lock is rejected without deleting the checkout"
write_lock "0000000000000000000000000000000000000000" "$sha"
out="$(run "$tmp/dest2")"; rc=$?
[ "$rc" != "0" ] && check 0 "commit mismatch fails" || check 1 "commit mismatch fails"
[ -d "$tmp/dest2" ] && check 0 "checkout kept for inspection" || check 1 "checkout kept for inspection"

echo "wrong license hash is rejected"
write_lock "$commit" "0000000000000000000000000000000000000000000000000000000000000000"
out="$(run "$tmp/dest")"; rc=$?
[ "$rc" != "0" ] && check 0 "license mismatch fails" || check 1 "license mismatch fails"

if [ "$failures" -gt 0 ]; then echo "FAILED: $failures check(s)"; exit 1; fi
echo "PASS: bootstrap-cloud-harness.sh tests"
