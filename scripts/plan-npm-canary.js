#!/usr/bin/env node
// Computes the npm canary version for a pull request build of
// `@grafana/prometheus`, from the changesets that the pull request itself adds:
//
//   <next-version>-canary.<pr-number>.<run-id>.<run-attempt>
//
// `<next-version>` is the release those changesets ask for, relative to the
// version already on the pull request's merge base. The suffix ties the version
// to exactly one workflow run, so two canaries never collide and — because it is
// a SemVer prerelease — no published version range can ever resolve to one.
//
// Pending changesets already merged to the base branch are deliberately ignored,
// so `<next-version>` reflects what this pull request asks for rather than what
// the next real release will be. See scripts/README.md.
//
// This runs in the unprivileged build workflow
// (.github/workflows/npm-canary-build.yml), so nothing it decides is trusted.
// scripts/verify-npm-canary-tarball.js holds the checks that publishing relies
// on.
//
// Usage:
//   node scripts/plan-npm-canary.js \
//     --base-sha <sha> --head-sha <sha> \
//     --pr-number <n> --run-id <n> --run-attempt <n>
const { execFileSync } = require('child_process');
const parseChangeset = require('@changesets/parse').default;

const PACKAGE_NAME = '@grafana/prometheus';
const PACKAGE_JSON = 'packages/grafana-prometheus/package.json';
const CHANGESET_PATH = /^\.changeset\/[A-Za-z0-9-]+\.md$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BUMP_PRIORITY = { patch: 0, minor: 1, major: 2 };

const OPTIONS = ['base-sha', 'head-sha', 'pr-number', 'run-id', 'run-attempt'];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function requireCommitSha(name, value) {
  if (!COMMIT_SHA.test(value)) {
    throw new Error(`${name} must be a full commit SHA: ${value}`);
  }
  return value;
}

function requirePositiveInteger(name, value) {
  if (!POSITIVE_INTEGER.test(value)) {
    throw new Error(`${name} must be a positive integer: ${value}`);
  }
  return value;
}

// Changeset files added between the merge base and the pull request head. Paths
// come from git rather than from a checkout listing, and are constrained to the
// names `@changesets/write` produces, so they can never be read as git options.
function addedChangesetPaths(baseSha, headSha, run) {
  const mergeBase = run(['merge-base', baseSha, headSha]).trim();
  const changed = run([
    'diff',
    '--name-only',
    '--diff-filter=A',
    '-z',
    mergeBase,
    headSha,
    '--',
    '.changeset/*.md',
    ':(exclude).changeset/README.md',
  ]);

  return changed
    .split('\0')
    .filter(Boolean)
    .map((path) => {
      if (!CHANGESET_PATH.test(path)) {
        throw new Error(`Unsafe changeset path: ${path}`);
      }
      return path;
    });
}

function nextVersion(baseVersion, bump) {
  const parsed = baseVersion.match(STABLE_SEMVER);
  if (!parsed) {
    throw new Error(`Base version must be stable SemVer: ${baseVersion}`);
  }

  const [major, minor, patch] = parsed.slice(1).map(Number);
  if (bump === 'major') {
    return `${major + 1}.0.0`;
  }
  if (bump === 'minor') {
    return `${major}.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

function planCanary({ baseVersion, prNumber, runId, runAttempt, changesetContents }) {
  requirePositiveInteger('prNumber', prNumber);
  requirePositiveInteger('runId', runId);
  requirePositiveInteger('runAttempt', runAttempt);

  // `none` is a valid changeset type that explicitly requests no release, so it
  // is not something a canary can be built from.
  const bumps = changesetContents
    .flatMap((contents) => parseChangeset(contents).releases)
    .filter((release) => release.name === PACKAGE_NAME && release.type !== 'none')
    .map((release) => release.type);

  if (bumps.length === 0) {
    return {
      publish: false,
      packageName: PACKAGE_NAME,
      reason: `No changeset in this pull request releases ${PACKAGE_NAME}.`,
    };
  }

  const bump = bumps.reduce((highest, candidate) =>
    BUMP_PRIORITY[candidate] > BUMP_PRIORITY[highest] ? candidate : highest
  );

  return {
    publish: true,
    packageName: PACKAGE_NAME,
    bump,
    version: `${nextVersion(baseVersion, bump)}-canary.${prNumber}.${runId}.${runAttempt}`,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const key = flag?.startsWith('--') ? flag.slice(2) : undefined;

    if (!key || !OPTIONS.includes(key) || value === undefined) {
      throw new Error(`Invalid argument: ${flag ?? '<missing>'}`);
    }
    options[key] = value;
  }

  for (const key of OPTIONS) {
    if (!options[key]) {
      throw new Error(`Missing required argument: --${key}`);
    }
  }
  return options;
}

function run({ argv, exec = git, write = (value) => process.stdout.write(value) } = {}) {
  const options = parseArgs(argv);
  const baseSha = requireCommitSha('--base-sha', options['base-sha']);
  const headSha = requireCommitSha('--head-sha', options['head-sha']);

  const plan = planCanary({
    baseVersion: JSON.parse(exec(['show', `${baseSha}:${PACKAGE_JSON}`])).version,
    prNumber: options['pr-number'],
    runId: options['run-id'],
    runAttempt: options['run-attempt'],
    changesetContents: addedChangesetPaths(baseSha, headSha, exec).map((path) => exec(['show', `${headSha}:${path}`])),
  });

  write(`${JSON.stringify(plan)}\n`);
  return plan;
}

if (require.main === module) {
  try {
    run({ argv: process.argv.slice(2) });
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
}

module.exports = {
  PACKAGE_NAME,
  addedChangesetPaths,
  nextVersion,
  planCanary,
  run,
};
