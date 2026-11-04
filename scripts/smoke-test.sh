#!/bin/sh
# End-to-end smoke test for a built git-mirror: the npm bundle or a compiled binary.
# Uses only local repositories (no network, no gh) and POSIX sh, so it also runs in Alpine/BusyBox.
#
#   sh scripts/smoke-test.sh node dist/index.js
#   sh scripts/smoke-test.sh ./dist/bin/git-mirror-linux-x64
set -eu

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <command...>   e.g. $0 ./dist/bin/git-mirror-linux-x64" >&2
  exit 2
fi

# Make relative file arguments (./dist/bin/..., dist/index.js) absolute before we cd elsewhere.
for arg do
  shift
  if [ -f "$arg" ]; then arg=$(cd "$(dirname "$arg")" && pwd)/$(basename "$arg"); fi
  set -- "$@" "$arg"
done

work=$(mktemp -d 2>/dev/null || mktemp -d -t git-mirror-smoke)
trap 'rm -rf "$work"' EXIT INT TERM

# Isolate git from the machine's own config (signing, hooks, credential helpers).
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
export GIT_AUTHOR_NAME=smoke GIT_AUTHOR_EMAIL=smoke@example.com
export GIT_COMMITTER_NAME=smoke GIT_COMMITTER_EMAIL=smoke@example.com

passed=0
pass() { passed=$((passed + 1)); echo "  ok - $1"; }
fail() { echo "  FAIL - $1" >&2; [ -f "$work/out" ] && sed 's/^/    | /' "$work/out" >&2; exit 1; }
gm() { "$@" >"$work/out" 2>&1; }

refs() { git -C "$1" for-each-ref --format='%(refname) %(objectname)' | sort; }

echo "Smoke testing: $*"
cd "$work"

# 1. Version and help.
gm "$@" --version || fail "--version exits 0"
grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+' "$work/out" || fail "--version prints a version"
pass "--version ($(cat "$work/out"))"

gm "$@" --help || fail "--help exits 0"
grep -q 'Usage: git-mirror' "$work/out" || fail "--help prints usage"
pass "--help"

if gm "$@"; then fail "missing arguments exit non-zero"; fi
pass "missing arguments are rejected"

# 2. A source repo with branches, lightweight and annotated tags, and a host-generated PR ref.
git init -q -b main src
git -C src commit -q --allow-empty -m one
git -C src tag v1
git -C src checkout -q -b feature
git -C src commit -q --allow-empty -m two
git -C src tag -a v2 -m "release v2"
git -C src checkout -q main
git -C src update-ref refs/pull/1/head feature
git init -q --bare dest.git

gm "$@" ./src ./dest.git --quiet || fail "mirror into an empty bare repo"
[ "$(refs dest.git)" = "$(refs src | grep -v '^refs/pull/' || true)" ] || fail "destination has every branch and tag"
refs dest.git | grep -q '^refs/pull/' && fail "refs/pull/* is stripped"
[ "$(git -C dest.git cat-file -t v2)" = tag ] || fail "annotated tags stay annotated"
pass "mirrors branches and tags, strips refs/pull/*"

# 3. Overwrite protection, then --force.
if gm "$@" ./src ./dest.git </dev/null; then fail "refuses to overwrite without --force"; fi
grep -q 'already has content' "$work/out" || fail "explains why it refused"
pass "refuses to overwrite a non-empty destination without --force"

git -C src commit -q --allow-empty -m three
gm "$@" ./src ./dest.git --force --quiet || fail "--force updates the mirror"
[ "$(git -C dest.git rev-parse main)" = "$(git -C src rev-parse main)" ] || fail "main moved to the new commit"
pass "--force brings the mirror up to date"

# 4. Clean errors (no stack traces) for bad input.
if gm "$@" "file://$work/missing.git" ./dest.git --force; then fail "unreachable source fails"; fi
grep -q 'Cannot read source' "$work/out" || fail "unreachable source is explained"
grep -q '    at ' "$work/out" && fail "no stack trace for expected errors"
pass "unreachable source fails with a clear message"

echo "All $passed smoke checks passed."
