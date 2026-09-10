/**
 * @jest-environment node
 */
const { execFileSync, spawnSync } = require('child_process');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const path = require('path');
const { run, verifyCanaryTarball } = require('../verify-npm-canary-tarball');

const EXPECTED = { prNumber: '123', runId: '456789', runAttempt: '2' };
const EXPECTED_VERSION = '13.1.12-canary.123.456789.2';
const REPO_ROOT = path.resolve(__dirname, '../..');
const SHELL_VERIFIER = path.join(REPO_ROOT, '.github/scripts/verify-npm-canary-tarball.sh');

function fixture(packageJson = {}) {
  return {
    expected: EXPECTED,
    packageJson: {
      name: '@grafana/prometheus',
      version: '13.1.12-canary.123.456789.2',
      ...packageJson,
    },
  };
}

function packedArtifact({ filenameVersion = EXPECTED_VERSION, manifestVersion = EXPECTED_VERSION } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'npm-canary-verifier-'));
  const artifactDir = path.join(root, 'artifact');
  const packageDir = path.join(root, 'package');
  mkdirSync(artifactDir);
  mkdirSync(packageDir);
  writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: '@grafana/prometheus', version: manifestVersion })
  );

  execFileSync('tar', [
    '-czf',
    path.join(artifactDir, `grafana-prometheus-${filenameVersion}.tgz`),
    '-C',
    root,
    'package',
  ]);

  return {
    artifactDir,
    root,
    verify: () =>
      spawnSync('bash', [SHELL_VERIFIER], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          ARTIFACT_DIR: artifactDir,
          PR_NUMBER: EXPECTED.prNumber,
          RUN_ID: EXPECTED.runId,
          RUN_ATTEMPT: EXPECTED.runAttempt,
          RUNNER_TEMP: root,
        },
      }),
  };
}

describe('verifyCanaryTarball', () => {
  it('accepts a canary bound to the expected pull request and run', () => {
    expect(verifyCanaryTarball(fixture())).toEqual({
      packageName: '@grafana/prometheus',
      version: '13.1.12-canary.123.456789.2',
    });
  });

  it.each([
    ['a major bump', '14.0.0-canary.123.456789.2'],
    ['a zero-prefixed release', '0.0.0-canary.123.456789.2'],
  ])('does not constrain the release part of the version: %s', (_name, version) => {
    expect(verifyCanaryTarball(fixture({ version }))).toMatchObject({ version });
  });

  it('rejects a substituted package name', () => {
    expect(() => verifyCanaryTarball(fixture({ name: '@grafana/not-prometheus' }))).toThrow(
      'Tarball package name mismatch: expected @grafana/prometheus, received @grafana/not-prometheus'
    );
  });

  it.each([
    ['a plain release that could take a version range', '13.1.12'],
    ['another pull request', '13.1.12-canary.321.456789.2'],
    ['another workflow run', '13.1.12-canary.123.999999.2'],
    ['another run attempt', '13.1.12-canary.123.456789.3'],
    ['a different prerelease channel', '13.1.12-beta.123.456789.2'],
    ['extra trailing prerelease identifiers', '13.1.12-canary.123.456789.2.4'],
    ['build metadata appended to the canary', '13.1.12-canary.123.456789.2+deadbeef'],
    ['the pull request number embedded in the release part', '123.456789.2-canary.123.456789.2.1'],
  ])('rejects %s', (_name, version) => {
    expect(() => verifyCanaryTarball(fixture({ version }))).toThrow(
      `Tarball version is not a canary for pull request 123, run 456789, attempt 2: ${version}`
    );
  });

  it('rejects a missing version', () => {
    expect(() => verifyCanaryTarball(fixture({ version: undefined }))).toThrow(
      'Tarball version is not a canary for pull request 123, run 456789, attempt 2: undefined'
    );
  });

  it('rejects untrusted expectations rather than matching them loosely', () => {
    expect(() =>
      verifyCanaryTarball({ packageJson: fixture().packageJson, expected: { ...EXPECTED, prNumber: '12.' } })
    ).toThrow('prNumber must be a positive integer: 12.');
  });
});

describe('verify-npm-canary-tarball CLI', () => {
  function argv(overrides = {}) {
    const options = {
      '--package-json': 'package.json',
      '--pr-number': EXPECTED.prNumber,
      '--run-id': EXPECTED.runId,
      '--run-attempt': EXPECTED.runAttempt,
      ...overrides,
    };
    return Object.entries(options).flatMap(([flag, value]) => (value === undefined ? [] : [flag, value]));
  }

  it('reads the packed manifest and writes the verified details', () => {
    const writes = [];
    const result = run(argv(), {
      readFile: () => JSON.stringify(fixture().packageJson),
      write: (value) => writes.push(value),
    });

    expect(result).toEqual({ packageName: '@grafana/prometheus', version: '13.1.12-canary.123.456789.2' });
    expect(writes).toEqual([`${JSON.stringify(result)}\n`]);
  });

  it('rejects a missing required argument', () => {
    expect(() => run(argv({ '--run-id': undefined }), { readFile: () => '{}', write: () => {} })).toThrow(
      'Missing required argument: runId'
    );
  });

  it('rejects an empty value for a required argument', () => {
    expect(() => run(argv({ '--pr-number': '' }), { readFile: () => '{}', write: () => {} })).toThrow(
      'Missing required argument: prNumber'
    );
  });

  it('rejects an unknown flag', () => {
    expect(() => run([...argv(), '--version', '13.1.12'], { readFile: () => '{}', write: () => {} })).toThrow(
      'Invalid argument: --version'
    );
  });
});

describe('verify-npm-canary-tarball shell wrapper', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('accepts one tarball whose filename matches its packed manifest', () => {
    const artifact = packedArtifact();
    tempDirs.push(artifact.root);

    expect(artifact.verify()).toMatchObject({
      status: 0,
      stdout: `${EXPECTED_VERSION}\n`,
      stderr: '',
    });
  });

  it('rejects an artifact with an extra top-level entry', () => {
    const artifact = packedArtifact();
    tempDirs.push(artifact.root);
    writeFileSync(path.join(artifact.artifactDir, 'unexpected.txt'), 'not part of the canary');

    expect(artifact.verify()).toMatchObject({
      status: 1,
      stderr: 'Error: expected exactly one packed tarball in the canary artifact.\n',
    });
  });

  it('rejects a tarball filename that does not match the packed manifest version', () => {
    const artifact = packedArtifact({ filenameVersion: '13.1.13-canary.123.456789.2' });
    tempDirs.push(artifact.root);

    expect(artifact.verify()).toMatchObject({
      status: 1,
      stderr: 'Error: canary tarball filename does not match the version in its manifest.\n',
    });
  });
});
