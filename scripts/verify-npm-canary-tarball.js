#!/usr/bin/env node
// Trusted-side check applied to a pull request canary before it is published.
//
// The tarball is packed by the unprivileged build workflow, so everything inside
// it — including its version — is chosen by the pull request. Publishing is safe
// because of what this asserts about the packed manifest:
//
//   * the package is `@grafana/prometheus` and nothing else, so a canary cannot
//     be used to squat or overwrite a different package name; and
//   * the version is a SemVer prerelease whose identifiers are exactly the pull
//     request number, run ID and run attempt that the trusted workflow resolved
//     for itself. That makes it impossible for a canary to be published as a
//     plain release, to satisfy any published version range, or to be attributed
//     to a different pull request or run.
//
// The `x.y.z` part is intentionally not constrained: it only affects how the
// canary reads, and the prerelease suffix already prevents it from colliding
// with, or being resolved in place of, a real release.
//
// This has no dependencies on purpose, so the publish workflow never has to
// install the dependency tree to run it.
//
// Usage:
//   node scripts/verify-npm-canary-tarball.js \
//     --package-json <package/package.json extracted from the tarball> \
//     --pr-number <n> --run-id <n> --run-attempt <n>
const fs = require('fs');

const PACKAGE_NAME = '@grafana/prometheus';
const POSITIVE_INTEGER = /^[1-9]\d*$/;

const OPTIONS = {
  '--package-json': 'packageJson',
  '--pr-number': 'prNumber',
  '--run-id': 'runId',
  '--run-attempt': 'runAttempt',
};

function canaryVersionPattern({ prNumber, runId, runAttempt }) {
  for (const [name, value] of Object.entries({ prNumber, runId, runAttempt })) {
    if (!POSITIVE_INTEGER.test(value)) {
      throw new Error(`${name} must be a positive integer: ${value}`);
    }
  }

  const release = '(?:0|[1-9]\\d*)';
  return new RegExp(`^${release}\\.${release}\\.${release}-canary\\.${prNumber}\\.${runId}\\.${runAttempt}$`);
}

function verifyCanaryTarball({ packageJson, expected }) {
  if (packageJson.name !== PACKAGE_NAME) {
    throw new Error(`Tarball package name mismatch: expected ${PACKAGE_NAME}, received ${packageJson.name}`);
  }

  const { prNumber, runId, runAttempt } = expected;
  if (!canaryVersionPattern(expected).test(packageJson.version)) {
    throw new Error(
      `Tarball version is not a canary for pull request ${prNumber}, run ${runId}, attempt ${runAttempt}: ` +
        `${packageJson.version}`
    );
  }

  return { packageName: PACKAGE_NAME, version: packageJson.version };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const key = OPTIONS[flag];

    if (!key || value === undefined) {
      throw new Error(`Invalid argument: ${flag ?? '<missing>'}`);
    }
    options[key] = value;
  }

  for (const key of Object.values(OPTIONS)) {
    if (!options[key]) {
      throw new Error(`Missing required argument: ${key}`);
    }
  }
  return options;
}

function run(
  argv = process.argv.slice(2),
  io = {
    readFile: (path) => fs.readFileSync(path, 'utf8'),
    write: (value) => process.stdout.write(value),
  }
) {
  const options = parseArgs(argv);
  const result = verifyCanaryTarball({
    packageJson: JSON.parse(io.readFile(options.packageJson)),
    expected: {
      prNumber: options.prNumber,
      runId: options.runId,
      runAttempt: options.runAttempt,
    },
  });

  io.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
}

module.exports = {
  PACKAGE_NAME,
  verifyCanaryTarball,
  run,
};
