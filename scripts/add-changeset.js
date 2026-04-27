#!/usr/bin/env node
// Creates a changeset for exactly one workspace package.
//
// The user MUST pick a package — either `grafana-prometheus-datasource` (the
// stub package that mirrors the workspace root — see
// scripts/sync-changelog.js) or `@grafana/prometheus` — via `--datasource` /
// `--library`, or interactively when no flag is passed. There is no default.
//
// Usage:
//   yarn changeset                                     # fully interactive
//   yarn changeset --datasource --patch "Fix panel"
//   yarn changeset --library --minor "Add new util"
//   yarn changeset --library --major "Breaking change"
const path = require('path');
const readline = require('readline');
const write = require('@changesets/write').default;

const DATASOURCE = 'grafana-prometheus-datasource';
const LIBRARY = '@grafana/prometheus';
const BUMP_TYPES = ['patch', 'minor', 'major'];

function parseArgs(argv) {
  const args = { pkg: null, bump: null, summary: '' };
  const rest = [];
  for (const arg of argv) {
    if (arg === '--patch' || arg === '--minor' || arg === '--major') {
      args.bump = arg.slice(2);
    } else if (arg === '--datasource' || arg === '--plugin') {
      if (args.pkg && args.pkg !== DATASOURCE) {
        throw new Error('Only one of --datasource / --library may be used.');
      }
      args.pkg = DATASOURCE;
    } else if (arg === '--library' || arg === '--lib') {
      if (args.pkg && args.pkg !== LIBRARY) {
        throw new Error('Only one of --datasource / --library may be used.');
      }
      args.pkg = LIBRARY;
    } else {
      rest.push(arg);
    }
  }
  args.summary = rest.join(' ').trim();
  return args;
}

function prompt(question, defaultValue) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve((answer || '').trim() || defaultValue || '');
    });
  });
}

async function pickPackageInteractively() {
  console.log('Which package?');
  console.log(`  1) ${DATASOURCE}`);
  console.log(`  2) ${LIBRARY}`);
  const choice = (await prompt('Select [1/2]: ', '')).toLowerCase();
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

async function createChangeset({ pkg, bump, summary, repoRoot }) {
  if (![DATASOURCE, LIBRARY].includes(pkg)) {
    throw new Error(`Invalid package: "${pkg}". Expected "${DATASOURCE}" or "${LIBRARY}".`);
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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const pkg = args.pkg || (await pickPackageInteractively());

  let bump = args.bump;
  if (!bump) {
    bump = (await prompt('Bump type [patch/minor/major] (patch): ', 'patch')).toLowerCase();
  }

  let summary = args.summary;
  if (!summary) {
    summary = await prompt('Summary: ', '');
  }

  const repoRoot = path.join(__dirname, '..');
  const id = await createChangeset({ pkg, bump, summary, repoRoot });

  console.log(`Created .changeset/${id}.md`);
  console.log(`  - ${pkg}: ${bump}`);
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
  BUMP_TYPES,
  parseArgs,
  createChangeset,
};
