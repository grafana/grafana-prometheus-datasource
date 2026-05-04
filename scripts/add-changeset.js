#!/usr/bin/env node
// Creates a changeset for exactly one workspace package.
//
// The user MUST pick a package — either `grafana-prometheus-datasource` (the
// stub package that mirrors the workspace root — see
// scripts/sync-changelog.js), `@grafana/prometheus`, or `promlib` (the stub
// that mirrors `pkg/promlib`'s CHANGELOG) — via `--datasource` /
// `--library` / `--promlib`, or interactively when no flag is passed. There
// is no default.
//
// Usage:
//   yarn changeset                                     # fully interactive
//   yarn changeset --datasource --patch "Fix panel"
//   yarn changeset --library --minor "Add new util"
//   yarn changeset --library --major "Breaking change"
//   yarn changeset --promlib --patch "Fix promlib bug"
const path = require('path');
const readline = require('readline');
const write = require('@changesets/write').default;

const DATASOURCE = 'grafana-prometheus-datasource';
const LIBRARY = '@grafana/prometheus';
const PROMLIB = 'promlib';
const PACKAGES = [DATASOURCE, LIBRARY, PROMLIB];
const BUMP_TYPES = ['patch', 'minor', 'major'];

const CONFLICT_MESSAGE = 'Only one of --datasource / --library / --promlib may be used.';

function setPkg(args, pkg) {
  if (args.pkg && args.pkg !== pkg) {
    throw new Error(CONFLICT_MESSAGE);
  }
  args.pkg = pkg;
}

function parseArgs(argv) {
  const args = { pkg: null, bump: null, summary: '' };
  const rest = [];
  for (const arg of argv) {
    if (arg === '--patch' || arg === '--minor' || arg === '--major') {
      args.bump = arg.slice(2);
    } else if (arg === '--datasource' || arg === '--plugin') {
      setPkg(args, DATASOURCE);
    } else if (arg === '--library' || arg === '--lib') {
      setPkg(args, LIBRARY);
    } else if (arg === '--promlib') {
      setPkg(args, PROMLIB);
    } else {
      rest.push(arg);
    }
  }
  args.summary = rest.join(' ').trim();
  return args;
}

function defaultPrompt(question, defaultValue) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve((answer || '').trim() || defaultValue || '');
    });
  });
}

async function pickPackageInteractively(prompt, log) {
  log('Which package?');
  log(`  1) ${DATASOURCE}`);
  log(`  2) ${LIBRARY}`);
  log(`  3) ${PROMLIB}`);
  const choice = (await prompt('Select [1/2/3]: ', '')).toLowerCase();
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

async function createChangeset({ pkg, bump, summary, repoRoot }) {
  if (!PACKAGES.includes(pkg)) {
    throw new Error(`Invalid package: "${pkg}". Expected one of: ${PACKAGES.map((p) => `"${p}"`).join(', ')}.`);
  }
  if (!BUMP_TYPES.includes(bump)) {
    throw new Error(`Invalid bump type: "${bump}". Expected one of: ${BUMP_TYPES.join(', ')}.`);
  }
  if (!summary) {
    throw new Error('A summary is required.');
  }
  const id = await write({ summary, releases: [{ name: pkg, type: bump }] }, repoRoot);
  return id;
}

// Drives the full CLI flow: parse args, fill in any missing inputs via the
// supplied prompt, and write the changeset. Exposed (and broken out from
// `main`) so tests can simulate both the interactive and flag-driven paths
// without spawning a shell.
async function run({ argv, repoRoot, prompt = defaultPrompt, log = console.log } = {}) {
  const args = parseArgs(argv);

  const pkg = args.pkg || (await pickPackageInteractively(prompt, log));

  let bump = args.bump;
  if (!bump) {
    bump = (await prompt('Bump type [patch/minor/major] (patch): ', 'patch')).toLowerCase();
  }

  let summary = args.summary;
  if (!summary) {
    summary = await prompt('Summary: ', '');
  }

  const id = await createChangeset({ pkg, bump, summary, repoRoot });

  log(`Created .changeset/${id}.md`);
  log(`  - ${pkg}: ${bump}`);
  return { id, pkg, bump, summary };
}

if (require.main === module) {
  run({ argv: process.argv.slice(2), repoRoot: path.join(__dirname, '..') }).catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  DATASOURCE,
  LIBRARY,
  PROMLIB,
  PACKAGES,
  BUMP_TYPES,
  parseArgs,
  createChangeset,
  pickPackageInteractively,
  run,
};
