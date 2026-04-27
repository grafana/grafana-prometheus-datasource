#!/usr/bin/env node
// Some "stub" workspace packages exist purely as `@changesets/cli` targets
// because changesets cannot bump the workspace root or directories outside
// of `packages/*`. After `changeset version` runs, this script mirrors the
// stub's CHANGELOG.md (and, when applicable, its package.json version) to
// the real location it represents:
//
//   packages/grafana-prometheus-datasource → workspace root (CHANGELOG + version)
//   packages/promlib                       → pkg/promlib   (CHANGELOG only)
//
// The promlib stub's package.json version is bookkeeping only — the real
// `pkg/promlib` Go module is versioned via git tags (`pkg/promlib/vX.Y.Z`).
const fs = require('fs');
const path = require('path');

const DATASOURCE = 'grafana-prometheus-datasource';
const PROMLIB = 'promlib';

const STUBS = {
  [DATASOURCE]: {
    stubDir: path.join('packages', 'grafana-prometheus-datasource'),
    targetDir: '.',
    syncVersion: true,
  },
  [PROMLIB]: {
    stubDir: path.join('packages', 'promlib'),
    targetDir: path.join('pkg', 'promlib'),
    syncVersion: false,
  },
};

function syncChangelog(repoRoot, pkg = DATASOURCE) {
  const cfg = STUBS[pkg];
  if (!cfg) {
    throw new Error(`Unknown stub package: "${pkg}". Expected one of: ${Object.keys(STUBS).join(', ')}.`);
  }

  const stubDir = path.join(repoRoot, cfg.stubDir);
  const targetDir = path.join(repoRoot, cfg.targetDir);

  const stubChangelog = path.join(stubDir, 'CHANGELOG.md');
  const targetChangelog = path.join(targetDir, 'CHANGELOG.md');

  if (fs.existsSync(stubChangelog)) {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(stubChangelog, targetChangelog);
  }

  if (cfg.syncVersion) {
    const stubPkgPath = path.join(stubDir, 'package.json');
    const targetPkgPath = path.join(targetDir, 'package.json');
    if (fs.existsSync(stubPkgPath) && fs.existsSync(targetPkgPath)) {
      const stubPkg = JSON.parse(fs.readFileSync(stubPkgPath, 'utf8'));
      const targetPkg = JSON.parse(fs.readFileSync(targetPkgPath, 'utf8'));
      if (stubPkg.version && targetPkg.version !== stubPkg.version) {
        targetPkg.version = stubPkg.version;
        fs.writeFileSync(targetPkgPath, JSON.stringify(targetPkg, null, 2) + '\n');
      }
    }
  }
}

if (require.main === module) {
  const arg = process.argv[2];
  syncChangelog(path.join(__dirname, '..'), arg);
}

module.exports = { syncChangelog, DATASOURCE, PROMLIB, STUBS };
