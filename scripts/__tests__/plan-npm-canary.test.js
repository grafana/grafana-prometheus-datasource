/**
 * @jest-environment node
 */
const { addedChangesetPaths, nextVersion, planCanary, run } = require('../plan-npm-canary');

const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const MERGE_BASE = 'c'.repeat(40);

function changeset(bump, packageName = '@grafana/prometheus') {
  return `---
'${packageName}': ${bump}
---

Test change
`;
}

function ids(overrides = {}) {
  return { prNumber: '123', runId: '456789', runAttempt: '1', ...overrides };
}

// Stands in for `git`, keyed on the subcommand plus enough of the arguments to
// tell the three calls the planner makes apart.
function fakeGit({ addedPaths = [], files = {}, baseVersion = '13.1.11', mergeBaseVersion = baseVersion } = {}) {
  const calls = [];
  const exec = (args) => {
    calls.push(args);
    const [subcommand] = args;

    if (subcommand === 'merge-base') {
      return `${MERGE_BASE}\n`;
    }
    if (subcommand === 'diff') {
      return addedPaths.map((path) => `${path}\0`).join('');
    }
    if (subcommand === 'show') {
      const target = args[1];
      if (target === `${BASE_SHA}:packages/grafana-prometheus/package.json`) {
        return JSON.stringify({ name: '@grafana/prometheus', version: baseVersion });
      }
      if (target === `${MERGE_BASE}:packages/grafana-prometheus/package.json`) {
        return JSON.stringify({ name: '@grafana/prometheus', version: mergeBaseVersion });
      }
      const path = target.slice(`${HEAD_SHA}:`.length);
      if (!(path in files)) {
        throw new Error(`unexpected git show: ${target}`);
      }
      return files[path];
    }
    throw new Error(`unexpected git subcommand: ${subcommand}`);
  };

  return { exec, calls };
}

describe('planCanary', () => {
  it.each([
    ['patch', '13.1.12-canary.123.456789.1'],
    ['minor', '13.2.0-canary.123.456789.1'],
    ['major', '14.0.0-canary.123.456789.1'],
  ])('plans a %s canary from a package changeset', (bump, expected) => {
    expect(planCanary({ baseVersion: '13.1.11', ...ids(), changesetContents: [changeset(bump)] })).toEqual({
      publish: true,
      packageName: '@grafana/prometheus',
      bump,
      version: expected,
    });
  });

  it('uses the highest bump across all package changesets', () => {
    expect(
      planCanary({
        baseVersion: '13.1.11',
        ...ids(),
        changesetContents: [changeset('patch'), changeset('minor'), changeset('major', 'promlib')],
      })
    ).toMatchObject({ bump: 'minor', version: '13.2.0-canary.123.456789.1' });
  });

  it('accepts a quoted bump, as changesets itself does', () => {
    expect(
      planCanary({
        baseVersion: '13.1.11',
        ...ids(),
        changesetContents: ['---\n"@grafana/prometheus": "minor"\n---\n\nQuoted\n'],
      })
    ).toMatchObject({ bump: 'minor' });
  });

  it('skips when no changeset releases the package', () => {
    expect(
      planCanary({ baseVersion: '13.1.11', ...ids(), changesetContents: [changeset('patch', 'promlib')] })
    ).toEqual({
      publish: false,
      packageName: '@grafana/prometheus',
      reason: 'No changeset in this pull request releases @grafana/prometheus.',
    });
  });

  it('skips when the pull request adds no changesets at all', () => {
    expect(planCanary({ baseVersion: '13.1.11', ...ids(), changesetContents: [] })).toMatchObject({
      publish: false,
    });
  });

  it('skips a changeset that explicitly requests no release', () => {
    expect(planCanary({ baseVersion: '13.1.11', ...ids(), changesetContents: [changeset('none')] })).toMatchObject({
      publish: false,
    });
  });

  it('rejects an unsupported bump', () => {
    expect(() => planCanary({ baseVersion: '13.1.11', ...ids(), changesetContents: [changeset('banana')] })).toThrow(
      /invalid version type "banana"/
    );
  });

  it('rejects changeset content without frontmatter', () => {
    expect(() =>
      planCanary({ baseVersion: '13.1.11', ...ids(), changesetContents: ["'@grafana/prometheus': patch"] })
    ).toThrow(/missing or invalid frontmatter/);
  });

  it('rejects a prerelease base version', () => {
    expect(() =>
      planCanary({ baseVersion: '13.2.0-beta.1', ...ids(), changesetContents: [changeset('patch')] })
    ).toThrow('Base version must be stable SemVer: 13.2.0-beta.1');
  });

  it.each([
    ['prNumber', { prNumber: '0' }],
    ['runId', { runId: 'abc' }],
    ['runAttempt', { runAttempt: '' }],
  ])('rejects an invalid %s', (name, override) => {
    expect(() =>
      planCanary({ baseVersion: '13.1.11', ...ids(override), changesetContents: [changeset('patch')] })
    ).toThrow(`${name} must be a positive integer`);
  });
});

describe('nextVersion', () => {
  it('bumps from zero-prefixed versions without losing the leading zero', () => {
    expect(nextVersion('0.1.0', 'patch')).toBe('0.1.1');
    expect(nextVersion('0.1.0', 'minor')).toBe('0.2.0');
    expect(nextVersion('0.1.0', 'major')).toBe('1.0.0');
  });
});

describe('addedChangesetPaths', () => {
  it('diffs the merge base against the head and returns added changesets', () => {
    const { exec, calls } = fakeGit({ addedPaths: ['.changeset/brave-cats-sing.md'] });

    expect(addedChangesetPaths(MERGE_BASE, HEAD_SHA, exec)).toEqual(['.changeset/brave-cats-sing.md']);
    expect(calls[0]).toEqual([
      'diff',
      '--name-only',
      '--diff-filter=A',
      '-z',
      MERGE_BASE,
      HEAD_SHA,
      '--',
      '.changeset/*.md',
      ':(exclude).changeset/README.md',
    ]);
  });

  it('rejects a changeset path git would not have produced', () => {
    const { exec } = fakeGit({ addedPaths: ['.changeset/../../etc/passwd.md'] });

    expect(() => addedChangesetPaths(MERGE_BASE, HEAD_SHA, exec)).toThrow(
      'Unsafe changeset path: .changeset/../../etc/passwd.md'
    );
  });
});

describe('plan-npm-canary CLI', () => {
  function argv(overrides = {}) {
    const options = {
      '--base-sha': BASE_SHA,
      '--head-sha': HEAD_SHA,
      '--pr-number': '123',
      '--run-id': '456789',
      '--run-attempt': '2',
      ...overrides,
    };
    return Object.entries(options).flatMap(([flag, value]) => (value === undefined ? [] : [flag, value]));
  }

  it('reads the base version and changesets from git and writes the plan as JSON', () => {
    const { exec } = fakeGit({
      addedPaths: ['.changeset/brave-cats-sing.md'],
      files: { '.changeset/brave-cats-sing.md': changeset('minor') },
    });
    const output = [];

    const plan = run({ argv: argv(), exec, write: (value) => output.push(value) });

    expect(plan).toEqual({
      publish: true,
      packageName: '@grafana/prometheus',
      bump: 'minor',
      version: '13.2.0-canary.123.456789.2',
    });
    expect(output).toEqual([`${JSON.stringify(plan)}\n`]);
  });

  it('reads the package version from the merge base when the base branch has advanced', () => {
    const { exec } = fakeGit({
      addedPaths: ['.changeset/brave-cats-sing.md'],
      files: { '.changeset/brave-cats-sing.md': changeset('patch') },
      baseVersion: '13.2.0',
      mergeBaseVersion: '13.1.11',
    });

    expect(run({ argv: argv(), exec, write: () => {} })).toMatchObject({
      version: '13.1.12-canary.123.456789.2',
    });
  });

  it('rejects a base SHA that is not a full commit SHA', () => {
    const { exec } = fakeGit();

    expect(() => run({ argv: argv({ '--base-sha': 'main' }), exec })).toThrow(
      '--base-sha must be a full commit SHA: main'
    );
  });

  it('rejects an unknown flag', () => {
    const { exec } = fakeGit();

    expect(() => run({ argv: [...argv(), '--publish', 'true'], exec })).toThrow('Invalid argument: --publish');
  });

  it('rejects a missing required argument', () => {
    const { exec } = fakeGit();

    expect(() => run({ argv: argv({ '--run-attempt': undefined }), exec })).toThrow(
      'Missing required argument: --run-attempt'
    );
  });

  it('rejects an empty value for a required argument', () => {
    const { exec } = fakeGit();

    expect(() => run({ argv: argv({ '--run-attempt': '' }), exec })).toThrow(
      'Missing required argument: --run-attempt'
    );
  });

  it('rejects a flag with no value', () => {
    const { exec } = fakeGit();

    expect(() => run({ argv: [...argv(), '--run-id'], exec })).toThrow('Invalid argument: --run-id');
  });
});
