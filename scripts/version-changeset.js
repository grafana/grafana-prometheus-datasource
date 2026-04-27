#!/usr/bin/env node
// Versions exactly one workspace package via `changeset version`.
//
// `@changesets/cli version` always consumes every pending changeset and bumps
// every referenced package. To scope it to one package, this script:
//   1. Picks a target package (interactive prompt, or --datasource / --library).
//   2. Moves changesets that don't reference that package into a hold folder.
//   3. Runs `changeset version`.
//   4. Restores the held changesets so they remain pending for next time.
//   5. For the datasource stub, mirrors version + CHANGELOG to the workspace
//      root via sync-changelog.js.
//
// Usage:
//   yarn changeset:version                  # interactive
//   yarn changeset:version --datasource     # version the plugin/datasource only
//   yarn changeset:version --library        # version @grafana/prometheus only
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const DATASOURCE = 'grafana-prometheus-datasource';
const LIBRARY = '@grafana/prometheus';
const CHANGESET_SUBDIR = '.changeset';
const HOLD_SUBDIR = '.changeset-hold';

function parseArgs(argv) {
  let pkg = null;
  for (const arg of argv) {
    if (arg === '--datasource' || arg === '--plugin') {
      if (pkg && pkg !== DATASOURCE) {
        throw new Error('Only one of --datasource / --library may be used.');
      }
      pkg = DATASOURCE;
    } else if (arg === '--library' || arg === '--lib') {
      if (pkg && pkg !== LIBRARY) {
        throw new Error('Only one of --datasource / --library may be used.');
      }
      pkg = LIBRARY;
    } else {
      throw new Error(`Unknown argument: "${arg}"`);
    }
  }
  return pkg;
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve((answer || '').trim());
    });
  });
}

async function pickPackageInteractively() {
  console.log('Which package do you want to version?');
  console.log(`  1) ${DATASOURCE}`);
  console.log(`  2) ${LIBRARY}`);
  const choice = (await prompt('Select [1/2]: ')).toLowerCase();
  switch (choice) {
    case '1':
    case 'datasource':
    case 'plugin':
      return DATASOURCE;
    case '2':
    case 'library':
    case 'lib':
      return LIBRARY;
    case '':
      throw new Error('A package must be selected.');
    default:
      throw new Error(`Invalid selection: "${choice}"`);
  }
}

// Returns the set of package names referenced in a changeset's YAML frontmatter.
function getChangesetPackages(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return new Set();
  const packages = new Set();
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^\s*(?:"([^"]+)"|'([^']+)'|([^\s'":]+))\s*:\s*(patch|minor|major)\s*$/);
    if (m) packages.add(m[1] || m[2] || m[3]);
  }
  return packages;
}

function listChangesetFiles(changesetDir) {
  if (!fs.existsSync(changesetDir)) return [];
  return fs
    .readdirSync(changesetDir)
    .filter((name) => name.endsWith('.md') && name.toLowerCase() !== 'readme.md')
    .map((name) => path.join(changesetDir, name));
}

function moveChangesetsAside(targetPkg, changesetDir, holdDir) {
  const held = [];
  const files = listChangesetFiles(changesetDir);
  for (const file of files) {
    const pkgs = getChangesetPackages(file);
    if (pkgs.size === 0 || pkgs.has(targetPkg)) continue;
    if (!fs.existsSync(holdDir)) fs.mkdirSync(holdDir, { recursive: true });
    const dest = path.join(holdDir, path.basename(file));
    fs.renameSync(file, dest);
    held.push({ from: file, to: dest });
  }
  return held;
}

function restoreHeldChangesets(held, holdDir) {
  for (const { from, to } of held) {
    if (fs.existsSync(to)) fs.renameSync(to, from);
  }
  if (fs.existsSync(holdDir) && fs.readdirSync(holdDir).length === 0) {
    fs.rmdirSync(holdDir);
  }
}

// Default runner that shells out to the local `@changesets/cli` binary.
function defaultRunChangesetVersion({ repoRoot, changesetBin, stdio = 'inherit' }) {
  const bin = changesetBin || path.join(repoRoot, 'node_modules', '.bin', 'changeset');
  const result = spawnSync(bin, ['version'], { cwd: repoRoot, stdio });
  return result.status ?? 1;
}

async function runVersion({
  pkg,
  repoRoot,
  changesetBin,
  runChangesetVersion = defaultRunChangesetVersion,
  syncChangelog,
  log = console.log,
}) {
  if (![DATASOURCE, LIBRARY].includes(pkg)) {
    throw new Error(`Invalid package: "${pkg}". Expected "${DATASOURCE}" or "${LIBRARY}".`);
  }

  const changesetDir = path.join(repoRoot, CHANGESET_SUBDIR);
  const holdDir = path.join(repoRoot, HOLD_SUBDIR);

  const targeted = listChangesetFiles(changesetDir).filter((f) => getChangesetPackages(f).has(pkg));
  if (targeted.length === 0) {
    log(`No pending changesets reference "${pkg}". Nothing to version.`);
    return { exitCode: 0, versioned: false, heldCount: 0 };
  }

  const held = moveChangesetsAside(pkg, changesetDir, holdDir);
  if (held.length > 0) {
    log(`Holding ${held.length} unrelated changeset(s) aside while versioning "${pkg}".`);
  }

  let exitCode = 0;
  try {
    exitCode = runChangesetVersion({ repoRoot, changesetBin });
  } finally {
    restoreHeldChangesets(held, holdDir);
  }

  if (exitCode !== 0) {
    return { exitCode, versioned: false, heldCount: held.length };
  }

  if (pkg === DATASOURCE && typeof syncChangelog === 'function') {
    syncChangelog(repoRoot);
  }

  return { exitCode: 0, versioned: true, heldCount: held.length };
}

async function main() {
  const argPkg = parseArgs(process.argv.slice(2));
  const pkg = argPkg || (await pickPackageInteractively());
  const repoRoot = path.join(__dirname, '..');
  const { syncChangelog } = require('./sync-changelog.js');
  const { exitCode } = await runVersion({ pkg, repoRoot, syncChangelog });
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  DATASOURCE,
  LIBRARY,
  CHANGESET_SUBDIR,
  HOLD_SUBDIR,
  parseArgs,
  getChangesetPackages,
  listChangesetFiles,
  moveChangesetsAside,
  restoreHeldChangesets,
  runVersion,
  defaultRunChangesetVersion,
};
