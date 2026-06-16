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
    deleteStubChangelog: true,
  },
  [PROMLIB]: {
    stubDir: path.join('packages', 'promlib'),
    targetDir: path.join('pkg', 'promlib'),
    syncVersion: false,
    // pkg/promlib is the canonical location; remove the stub copy so the
    // changelog only exists in one place.
    deleteStubChangelog: true,
  },
};

// Merges a stub changelog (new version only) into an existing target changelog
// (full history). New version sections from the stub are prepended after the
// title header so history is never lost.
function mergeChangelogs(stubContent, existingContent) {
  const stubVersionIdx = stubContent.indexOf('\n## ');
  if (stubVersionIdx < 0) {
    return existingContent;
  }
  const newVersionBlock = stubContent.slice(stubVersionIdx + 1).trimEnd();

  const existingVersionIdx = existingContent.indexOf('\n## ');
  if (existingVersionIdx < 0) {
    return stubContent;
  }
  const header = existingContent.slice(0, existingVersionIdx + 1);
  const existingBlock = existingContent.slice(existingVersionIdx + 1).trimEnd();

  return header + newVersionBlock + '\n\n' + existingBlock + '\n';
}

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
    const stubContent = fs.readFileSync(stubChangelog, 'utf8');
    if (fs.existsSync(targetChangelog)) {
      const existing = fs.readFileSync(targetChangelog, 'utf8');
      fs.writeFileSync(targetChangelog, mergeChangelogs(stubContent, existing));
    } else {
      fs.writeFileSync(targetChangelog, stubContent);
    }
    if (cfg.deleteStubChangelog) {
      fs.rmSync(stubChangelog);
    }
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

module.exports = { syncChangelog, mergeChangelogs, DATASOURCE, PROMLIB, STUBS };
