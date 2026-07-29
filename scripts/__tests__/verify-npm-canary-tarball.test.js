/**
 * @jest-environment node
 */
const { run, verifyCanaryTarball } = require('../verify-npm-canary-tarball');

const EXPECTED = { prNumber: '123', runId: '456789', runAttempt: '2' };

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

  it('rejects an unknown flag', () => {
    expect(() => run([...argv(), '--version', '13.1.12'], { readFile: () => '{}', write: () => {} })).toThrow(
      'Invalid argument: --version'
    );
  });
});
