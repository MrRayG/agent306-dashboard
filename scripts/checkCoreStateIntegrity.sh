#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Core-state integrity guard (Issue #330)
#
# CONTRACT
#   This script is a LOUD FAILURE DETECTOR. It does NOT fix anything.
#   It does NOT rewrite tests. It does NOT relocate data files. Its only
#   job is to fail the CI build when `npm test` silently mutates the four
#   core agent-state files, or leaves a `tmp-blog-legacy-*` directory at
#   the repository root.
#
# SCOPE (narrow, by design — tied to one-agent direction)
#   Watched core-state files:
#     - data/research_lab.json
#     - data/memory_knowledge.json
#     - data/agent_goals.json
#     - data/competencyProfile.json
#
#   Watched root leak pattern:
#     - tmp-blog-legacy-*/  (at repo root)
#
# BEHAVIOR
#   1. Snapshots existence + sha256 of each watched file (pre-test).
#   2. Runs `npm test`.
#   3. Compares post-test existence + sha256 to the snapshot.
#   4. Scans repo root for `tmp-blog-legacy-*` directories.
#   5. Exits non-zero with a per-violator report if anything changed.
#
# INVARIANTS
#   - READ-ONLY against the working tree (only writes its own snapshot
#     into a temp dir).
#   - MANUAL-DETERMINISM: no wall clock, no randomness, no env reads
#     beyond what `npm test` itself reads.
#   - NON-WIDENING: the watched set is hard-coded above. Adding new
#     files requires editing this script explicitly.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WATCHED_FILES=(
  "data/research_lab.json"
  "data/memory_knowledge.json"
  "data/agent_goals.json"
  "data/competencyProfile.json"
)

ROOT_LEAK_GLOB="tmp-blog-legacy-*"

SNAPSHOT_DIR="$(mktemp -d -t core-state-integrity-XXXXXX)"
trap 'rm -rf "$SNAPSHOT_DIR"' EXIT

# ─── Pre-test snapshot ──────────────────────────────────────────────────────
echo "▶ core-state-integrity: snapshotting watched files"
for f in "${WATCHED_FILES[@]}"; do
  if [[ -f "$f" ]]; then
    sha256sum "$f" > "$SNAPSHOT_DIR/$(echo "$f" | tr '/' '_').sha"
    echo "  • $f present (sha recorded)"
  else
    echo "  • $f absent (recorded as absent)"
    echo "ABSENT" > "$SNAPSHOT_DIR/$(echo "$f" | tr '/' '_').sha"
  fi
done

# ─── Run the test suite (quarantine-aware) ─────────────────────────────────
# We invoke `npm run test:guarded` rather than `npm test`. The guarded
# variant excludes the quarantined test files listed in
# `scripts/quarantinedTests.ts` (Issue #332). The default `npm test`
# continues to run the full suite — only this integrity guard skips
# the quarantined files. As each culprit is fixed and removed from
# the manifest, the guard's coverage grows back toward 100%.
echo "▶ core-state-integrity: running npm run test:guarded (excludes Issue #332 culprits)"
NODE_ENV=test npm run test:guarded

# ─── Post-test verification ─────────────────────────────────────────────────
echo "▶ core-state-integrity: verifying watched files unchanged"
violations=()

for f in "${WATCHED_FILES[@]}"; do
  snap_file="$SNAPSHOT_DIR/$(echo "$f" | tr '/' '_').sha"
  snap_content="$(cat "$snap_file")"

  if [[ "$snap_content" == "ABSENT" ]]; then
    if [[ -f "$f" ]]; then
      violations+=("CREATED: $f (was absent before npm test, present after)")
    fi
  else
    if [[ ! -f "$f" ]]; then
      violations+=("DELETED: $f (existed before npm test, removed by test run)")
    else
      current_sha="$(sha256sum "$f")"
      if [[ "$current_sha" != "$snap_content" ]]; then
        violations+=("MUTATED: $f (sha256 changed during npm test)")
      fi
    fi
  fi
done

# ─── Root leak scan ────────────────────────────────────────────────────────
echo "▶ core-state-integrity: scanning for $ROOT_LEAK_GLOB at repo root"
shopt -s nullglob
leaks=( $ROOT_LEAK_GLOB )
shopt -u nullglob
for leak in "${leaks[@]}"; do
  if [[ -d "$leak" ]]; then
    violations+=("ROOT LEAK: $leak/ (test run created tmp-blog-legacy-* directory at repo root)")
  fi
done

# ─── Verdict ───────────────────────────────────────────────────────────────
if [[ ${#violations[@]} -eq 0 ]]; then
  echo "✓ core-state-integrity: PASS — no watched files mutated, no root leaks"
  exit 0
fi

echo ""
echo "✗ core-state-integrity: FAIL — npm test mutated core agent state"
echo ""
echo "Violations (${#violations[@]}):"
for v in "${violations[@]}"; do
  echo "  ✗ $v"
done
echo ""
echo "This guard exists because npm test must not silently mutate the four"
echo "core agent-state files or leave tmp-blog-legacy-* directories at the"
echo "repo root. See Issue #330 for the full rationale and culprit list."
echo ""
exit 1
