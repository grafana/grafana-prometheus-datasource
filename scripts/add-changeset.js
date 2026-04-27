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
  BUMP_TYPES,
  parseArgs,
  createChangeset,
  pickPackageInteractively,
  run,
};
