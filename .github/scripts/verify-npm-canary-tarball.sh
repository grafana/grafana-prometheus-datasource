#!/usr/bin/env bash
# Verifies a canary tarball built by npm-canary-build.yml and prints its version
# on stdout.
#
# Runs from the trusted default-branch checkout in release-npm.yml — once before
# requesting publish approval, and again immediately before publishing, which is
# the run that actually gates npm. Both call it with values that trusted code
# resolved for itself, never with anything the build reported.
#
# Required environment:
#   ARTIFACT_DIR  directory the canary artifact was downloaded into
#   PR_NUMBER     pull request number, resolved from the API by trusted code
#   RUN_ID        ID of the source workflow run that packed the tarball
#   RUN_ATTEMPT   attempt of the source workflow run that packed the tarball
set -euo pipefail

: "${ARTIFACT_DIR:?ARTIFACT_DIR is required}"
: "${PR_NUMBER:?PR_NUMBER is required}"
: "${RUN_ID:?RUN_ID is required}"
: "${RUN_ATTEMPT:?RUN_ATTEMPT is required}"

mapfile -d '' entries < <(find "$ARTIFACT_DIR" -mindepth 1 -maxdepth 1 -print0)
if [[ "${#entries[@]}" -ne 1 || "${entries[0]}" != *.tgz ]]; then
  echo "Error: expected exactly one packed tarball in the canary artifact." >&2
  exit 1
fi
tarball="${entries[0]}"

# `-O` writes the manifest to stdout, so paths inside the archive never decide
# where anything lands on disk.
manifest="${RUNNER_TEMP:-/tmp}/npm-canary-package.json"
tar -xOzf "$tarball" package/package.json > "$manifest"

version=$(node scripts/verify-npm-canary-tarball.js \
  --package-json "$manifest" \
  --pr-number "$PR_NUMBER" \
  --run-id "$RUN_ID" \
  --run-attempt "$RUN_ATTEMPT" | jq -er '.version')

# npm derives the published version from the manifest, not the filename, so a
# mismatch means the artifact is not what it claims to be.
if [[ "$tarball" != "$ARTIFACT_DIR/grafana-prometheus-${version}.tgz" ]]; then
  echo "Error: canary tarball filename does not match the version in its manifest." >&2
  exit 1
fi

printf '%s\n' "$version"
