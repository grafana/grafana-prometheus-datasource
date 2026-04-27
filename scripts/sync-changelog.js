#!/usr/bin/env node
// The workspace root (the datasource plugin) cannot be a changesets target,
// so we use `packages/grafana-prometheus-datasource` as a stub package whose
// CHANGELOG and version stand in for the root. After `changeset version` runs,
// this script mirrors the stub's CHANGELOG.md and package version to the
// workspace root so both stay in sync.
const fs = require('fs');
const path = require('path');

function syncChangelog(repoRoot) {
  const stubDir = path.join(repoRoot, 'packages', 'grafana-prometheus-datasource');

  const stubChangelog = path.join(stubDir, 'CHANGELOG.md');
  const rootChangelog = path.join(repoRoot, 'CHANGELOG.md');
  const stubPkgPath = path.join(stubDir, 'package.json');
  const rootPkgPath = path.join(repoRoot, 'package.json');

  if (fs.existsSync(stubChangelog)) {
    fs.copyFileSync(stubChangelog, rootChangelog);
  }

  const stubPkg = JSON.parse(fs.readFileSync(stubPkgPath, 'utf8'));
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));

  if (stubPkg.version && rootPkg.version !== stubPkg.version) {
    rootPkg.version = stubPkg.version;
    fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n');
  }
}

if (require.main === module) {
  syncChangelog(path.join(__dirname, '..'));
}

module.exports = { syncChangelog };
