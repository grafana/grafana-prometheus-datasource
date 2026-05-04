#!/usr/bin/env node
// Versions exactly one workspace package via `changeset version`.
//
// `@changesets/cli version` always consumes every pending changeset and bumps
// every referenced package. To scope it to one package, this script:
//   1. Picks a target package (interactive prompt, or
//      --datasource / --library / --promlib).
//   2. Moves changesets that don't reference that package into a hold folder.
//   3. Runs `changeset version`.
//   4. Restores the held changesets so they remain pending for next time.
//   5. For stub packages, mirrors version + CHANGELOG to their real location
//      via sync-changelog.js:
//        - grafana-prometheus-datasource → workspace root
//        - promlib                       → pkg/promlib (CHANGELOG only)
//
// Usage:
//   yarn changeset:version                  # interactive
//   yarn changeset:version --datasource     # version the plugin/datasource only
//   yarn changeset:version --library        # version @grafana/prometheus only
//   yarn changeset:version --promlib        # version promlib (pkg/promlib) only
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const DATASOURCE = 'grafana-prometheus-datasource';
const LIBRARY = '@grafana/prometheus';
const PROMLIB = 'promlib';
const PACKAGES = [DATASOURCE, LIBRARY, PROMLIB];
// Packages whose CHANGELOG/version need to be mirrored to a real location
// after `changeset version` runs.
const STUB_PACKAGES = new Set([DATASOURCE, PROMLIB]);

// Where each package's CHANGELOG.md lives, relative to the repo root. Used to
// post-process the file after `changeset version` runs (see flattenChangelog).
const PACKAGE_DIRS = {
  [DATASOURCE]: path.join('packages', 'grafana-prometheus-datasource'),
  [LIBRARY]: path.join('packages', 'grafana-prometheus'),
  [PROMLIB]: path.join('packages', 'promlib'),
};

const CHANGESET_SUBDIR = '.changeset';
const HOLD_SUBDIR = '.changeset-hold';

const CONFLICT_MESSAGE = 'Only one of --datasource / --library / --promlib may be used.';

function parseArgs(argv) {
  let pkg = null;
  const setPkg = (next) => {
    if (pkg && pkg !== next) {
      throw new Error(CONFLICT_MESSAGE);
    }
    pkg = next;
  };
  for (const arg of argv) {
    if (arg === '--datasource' || arg === '--plugin') {
      setPkg(DATASOURCE);
    } else if (arg === '--library' || arg === '--lib') {
      setPkg(LIBRARY);
    } else if (arg === '--promlib') {
      setPkg(PROMLIB);
    } else {
      throw new Error(`Unknown argument: "${arg}"`);
    }
  }
  return pkg;
}

function defaultPrompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve((answer || '').trim());
    });
  });
}

async function pickPackageInteractively(prompt, log) {
  log('Which package do you want to version?');
  log(`  1) ${DATASOURCE}`);
  log(`  2) ${LIBRARY}`);
  log(`  3) ${PROMLIB}`);
  const choice = (await prompt('Select [1/2/3]: ')).toLowerCase();
  switch (choice) {
    case '1':
    case 'datasource':
    case 'plugin':
      return DATASOURCE;
    case '2':
    case 'library':
    case 'lib':
      return LIBRARY;
    case '3':
    case 'promlib':
      return PROMLIB;
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
  if (!match) {
    return new Set();
  }
  const packages = new Set();
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^\s*(?:"([^"]+)"|'([^']+)'|([^\s'":]+))\s*:\s*(patch|minor|major)\s*$/);
    if (m) {
      packages.add(m[1] || m[2] || m[3]);
    }
  }
  return packages;
}

function listChangesetFiles(changesetDir) {
  if (!fs.existsSync(changesetDir)) {
    return [];
  }
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
    if (pkgs.size === 0 || pkgs.has(targetPkg)) {
      continue;
    }
    if (!fs.existsSync(holdDir)) {
      fs.mkdirSync(holdDir, { recursive: true });
    }
    const dest = path.join(holdDir, path.basename(file));
    fs.renameSync(file, dest);
    held.push({ from: file, to: dest });
  }
  return held;
}

function restoreHeldChangesets(held, holdDir) {
  for (const { from, to } of held) {
    if (fs.existsSync(to)) {
      fs.renameSync(to, from);
    }
  }
  if (fs.existsSync(holdDir) && fs.readdirSync(holdDir).length === 0) {
    fs.rmdirSync(holdDir);
  }
}

// Rewrites a CHANGELOG.md produced by `@changesets/cli` so that, within each
// `## <version>` release section, the `### Major Changes` / `### Minor Changes`
// / `### Patch Changes` sub-headings are removed and the entries underneath
// them are collapsed into a single, blank-line-free block.
//
// The bump type is already encoded in our per-line prefix emoji (🎉 / 🚀 / 🐛
// — see .changeset/changelog.js), so the sub-section headings are redundant.
//
// `applyReleasePlan` inside @changesets/cli hard-codes those sub-headings, so
// they cannot be removed via the changelog-functions API; this is a small
// post-processing pass instead.
//
// Returns true when the file was rewritten, false when it was missing or
// already in the desired shape.
function flattenChangelog(changelogPath) {
  if (!fs.existsSync(changelogPath)) {
    return false;
  }

  const original = fs.readFileSync(changelogPath, 'utf8');
  const lines = original.split('\n');
  const out = [];
  let inVersionSection = false;

  const pushBlankSeparator = () => {
    if (out.length > 0 && out[out.length - 1] !== '') {
      out.push('');
    }
  };

  for (const line of lines) {
    if (/^## /.test(line)) {
      pushBlankSeparator();
      out.push(line);
      out.push('');
      inVersionSection = true;
      continue;
    }

    if (/^# /.test(line)) {
      pushBlankSeparator();
      out.push(line);
      out.push('');
      inVersionSection = false;
      continue;
    }

    if (inVersionSection) {
      if (/^### (?:Major|Minor|Patch) Changes\s*$/.test(line)) {
        continue;
      }
      if (line.trim() === '') {
        continue;
      }
      out.push(line);
      continue;
    }

    out.push(line);
  }

  while (out.length > 0 && out[out.length - 1] === '') {
    out.pop();
  }
  out.push('');

  const result = out
    .reduce((acc, line) => {
      // Collapse runs of blank lines anywhere in the output to at most one.
      if (line === '' && acc.length > 0 && acc[acc.length - 1] === '') {
        return acc;
      }
      acc.push(line);
      return acc;
    }, [])
    .join('\n');

  if (result === original) {
    return false;
  }
  fs.writeFileSync(changelogPath, result);
  return true;
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
  if (!PACKAGES.includes(pkg)) {
    throw new Error(`Invalid package: "${pkg}". Expected one of: ${PACKAGES.map((p) => `"${p}"`).join(', ')}.`);
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

  const pkgDir = PACKAGE_DIRS[pkg];
  if (pkgDir) {
    flattenChangelog(path.join(repoRoot, pkgDir, 'CHANGELOG.md'));
  }

  if (STUB_PACKAGES.has(pkg) && typeof syncChangelog === 'function') {
    syncChangelog(repoRoot, pkg);
  }

  return { exitCode: 0, versioned: true, heldCount: held.length };
}

// Drives the full CLI flow: parse args, prompt if needed, then version.
// Exposed so tests can exercise the entire `yarn changeset:version` pipeline
// (including the interactive picker) without spawning a shell.
async function run({
  argv,
  repoRoot,
  prompt = defaultPrompt,
  log = console.log,
  runChangesetVersion,
  syncChangelog,
} = {}) {
  const argPkg = parseArgs(argv);
  const pkg = argPkg || (await pickPackageInteractively(prompt, log));

  const resolvedSync = syncChangelog || require('./sync-changelog.js').syncChangelog;

  return runVersion({
    pkg,
    repoRoot,
    runChangesetVersion,
    syncChangelog: resolvedSync,
    log,
  });
}

if (require.main === module) {
  run({ argv: process.argv.slice(2), repoRoot: path.join(__dirname, '..') })
    .then(({ exitCode }) => {
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
    })
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}

module.exports = {
  DATASOURCE,
  LIBRARY,
  PROMLIB,
  PACKAGES,
  PACKAGE_DIRS,
  STUB_PACKAGES,
  CHANGESET_SUBDIR,
  HOLD_SUBDIR,
  parseArgs,
  getChangesetPackages,
  listChangesetFiles,
  moveChangesetsAside,
  restoreHeldChangesets,
  flattenChangelog,
  runVersion,
  defaultRunChangesetVersion,
  pickPackageInteractively,
  run,
};
