/**
 * @jest-environment node
 */
const fs = require('fs');
const path = require('path');

const {
  DATASOURCE,
  LIBRARY,
  parseArgs,
  getChangesetPackages,
  listChangesetFiles,
  moveChangesetsAside,
  restoreHeldChangesets,
  runVersion,
} = require('../version-changeset');
const { syncChangelog } = require('../sync-changelog');
const {
  createFixture,
  destroyFixture,
  readPackageVersion,
  listChangesetMdFiles,
  writeChangeset,
  getRealChangesetBin,
} = require('./fixture');

const STUB_REL = path.join('packages', 'grafana-prometheus-datasource');
const LIB_REL = path.join('packages', 'grafana-prometheus');

// Always run end-to-end runVersion calls against the real `changeset` binary
// installed in this repo, but with `cwd` pointing at our fixture so the test
// is fully isolated.
function realRunner(opts) {
  const { defaultRunChangesetVersion } = require('../version-changeset');
  return defaultRunChangesetVersion({
    repoRoot: opts.repoRoot,
    changesetBin: getRealChangesetBin(),
    stdio: 'pipe',
  });
}

describe('version-changeset / parseArgs', () => {
  it('returns DATASOURCE for --datasource and --plugin', () => {
    expect(parseArgs(['--datasource'])).toBe(DATASOURCE);
    expect(parseArgs(['--plugin'])).toBe(DATASOURCE);
  });

  it('returns LIBRARY for --library and --lib', () => {
    expect(parseArgs(['--library'])).toBe(LIBRARY);
    expect(parseArgs(['--lib'])).toBe(LIBRARY);
  });

  it('returns null when no flag is passed', () => {
    expect(parseArgs([])).toBe(null);
  });

  it('throws on conflicting flags', () => {
    expect(() => parseArgs(['--datasource', '--library'])).toThrow(/Only one of/);
  });

  it('throws on unknown arguments', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
  });
});

describe('version-changeset / getChangesetPackages', () => {
  let root;

  beforeEach(() => {
    root = createFixture();
  });

  afterEach(() => {
    destroyFixture(root);
  });

  it('parses single-quoted package names (the format @changesets/write produces)', () => {
    const file = path.join(root, '.changeset', 'a.md');
    fs.writeFileSync(file, "---\n'@grafana/prometheus': minor\n---\n\nx\n");
    expect([...getChangesetPackages(file)]).toEqual([LIBRARY]);
  });

  it('parses double-quoted package names', () => {
    const file = path.join(root, '.changeset', 'b.md');
    fs.writeFileSync(file, '---\n"grafana-prometheus-datasource": patch\n---\n\nx\n');
    expect([...getChangesetPackages(file)]).toEqual([DATASOURCE]);
  });

  it('parses unquoted package names', () => {
    const file = path.join(root, '.changeset', 'c.md');
    fs.writeFileSync(file, '---\ngrafana-prometheus-datasource: major\n---\n\nx\n');
    expect([...getChangesetPackages(file)]).toEqual([DATASOURCE]);
  });

  it('returns multiple packages when a changeset references both', () => {
    const file = path.join(root, '.changeset', 'd.md');
    fs.writeFileSync(
      file,
      "---\n'grafana-prometheus-datasource': patch\n'@grafana/prometheus': minor\n---\n\nx\n",
    );
    expect(getChangesetPackages(file)).toEqual(new Set([DATASOURCE, LIBRARY]));
  });

  it('returns empty set when there is no frontmatter', () => {
    const file = path.join(root, '.changeset', 'e.md');
    fs.writeFileSync(file, 'no frontmatter here');
    expect([...getChangesetPackages(file)]).toEqual([]);
  });
});

describe('version-changeset / listChangesetFiles', () => {
  let root;

  beforeEach(() => {
    root = createFixture();
  });

  afterEach(() => {
    destroyFixture(root);
  });

  it('returns md files but excludes README.md (case-insensitive)', () => {
    writeChangeset(root, 'one.md', { [LIBRARY]: 'patch' });
    writeChangeset(root, 'two.md', { [DATASOURCE]: 'patch' });

    const files = listChangesetFiles(path.join(root, '.changeset')).map((f) => path.basename(f));
    expect(files.sort()).toEqual(['one.md', 'two.md']);
  });

  it('returns [] when the directory does not exist', () => {
    expect(listChangesetFiles(path.join(root, 'nope'))).toEqual([]);
  });
});

describe('version-changeset / moveChangesetsAside + restoreHeldChangesets', () => {
  let root;
  let changesetDir;
  let holdDir;

  beforeEach(() => {
    root = createFixture();
    changesetDir = path.join(root, '.changeset');
    holdDir = path.join(root, '.changeset-hold');
  });

  afterEach(() => {
    destroyFixture(root);
  });

  it('holds unrelated changesets aside and restores them on cleanup', () => {
    writeChangeset(root, 'lib.md', { [LIBRARY]: 'minor' }, 'lib summary');
    writeChangeset(root, 'ds.md', { [DATASOURCE]: 'patch' }, 'ds summary');

    const held = moveChangesetsAside(DATASOURCE, changesetDir, holdDir);

    expect(held).toHaveLength(1);
    expect(fs.existsSync(path.join(changesetDir, 'lib.md'))).toBe(false);
    expect(fs.existsSync(path.join(holdDir, 'lib.md'))).toBe(true);
    expect(fs.existsSync(path.join(changesetDir, 'ds.md'))).toBe(true);

    restoreHeldChangesets(held, holdDir);

    expect(fs.existsSync(path.join(changesetDir, 'lib.md'))).toBe(true);
    expect(fs.existsSync(holdDir)).toBe(false); // empty hold dir was cleaned up
  });

  it('does nothing when every changeset references the target package', () => {
    writeChangeset(root, 'a.md', { [LIBRARY]: 'patch' });
    writeChangeset(root, 'b.md', { [LIBRARY]: 'minor' });

    const held = moveChangesetsAside(LIBRARY, changesetDir, holdDir);
    expect(held).toEqual([]);
    expect(fs.existsSync(holdDir)).toBe(false);
  });
});

describe('version-changeset / runVersion (end-to-end with real changeset binary)', () => {
  let root;

  beforeEach(() => {
    root = createFixture({
      rootVersion: '13.1.0',
      libraryVersion: '13.1.0',
      datasourceVersion: '13.1.0',
    });
  });

  afterEach(() => {
    destroyFixture(root);
  });

  it('versions the library only, leaving the datasource stub and root untouched', async () => {
    writeChangeset(root, 'lib.md', { [LIBRARY]: 'minor' }, 'Add util');

    const result = await runVersion({
      pkg: LIBRARY,
      repoRoot: root,
      runChangesetVersion: realRunner,
      syncChangelog,
      log: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.versioned).toBe(true);

    expect(readPackageVersion(root, LIB_REL)).toBe('13.2.0');
    expect(readPackageVersion(root, STUB_REL)).toBe('13.1.0');
    expect(readPackageVersion(root, '.')).toBe('13.1.0');

    // Library changeset was consumed; nothing held.
    expect(listChangesetMdFiles(root)).toEqual([]);
  });

  it('versions the datasource stub, mirrors version + CHANGELOG to the root, leaves the library untouched', async () => {
    writeChangeset(root, 'ds.md', { [DATASOURCE]: 'patch' }, 'Fix panel');

    const result = await runVersion({
      pkg: DATASOURCE,
      repoRoot: root,
      runChangesetVersion: realRunner,
      syncChangelog,
      log: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.versioned).toBe(true);

    expect(readPackageVersion(root, STUB_REL)).toBe('13.1.1');
    expect(readPackageVersion(root, '.')).toBe('13.1.1');
    expect(readPackageVersion(root, LIB_REL)).toBe('13.1.0');

    const rootChangelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    expect(rootChangelog).toContain('## 13.1.1');
    expect(rootChangelog).toContain('Fix panel');

    expect(listChangesetMdFiles(root)).toEqual([]);
  });

  it('with both pending changesets, --library only consumes the library one and preserves the datasource one', async () => {
    writeChangeset(root, 'lib.md', { [LIBRARY]: 'minor' }, 'Lib change');
    writeChangeset(root, 'ds.md', { [DATASOURCE]: 'patch' }, 'DS change');

    const result = await runVersion({
      pkg: LIBRARY,
      repoRoot: root,
      runChangesetVersion: realRunner,
      syncChangelog,
      log: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.heldCount).toBe(1);

    expect(readPackageVersion(root, LIB_REL)).toBe('13.2.0');
    expect(readPackageVersion(root, STUB_REL)).toBe('13.1.0');
    expect(readPackageVersion(root, '.')).toBe('13.1.0');

    expect(listChangesetMdFiles(root)).toEqual(['ds.md']);
    expect(fs.existsSync(path.join(root, '.changeset-hold'))).toBe(false);
  });

  it('with both pending changesets, --datasource only consumes the datasource one and preserves the library one', async () => {
    writeChangeset(root, 'lib.md', { [LIBRARY]: 'minor' }, 'Lib change');
    writeChangeset(root, 'ds.md', { [DATASOURCE]: 'patch' }, 'DS change');

    const result = await runVersion({
      pkg: DATASOURCE,
      repoRoot: root,
      runChangesetVersion: realRunner,
      syncChangelog,
      log: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.heldCount).toBe(1);

    expect(readPackageVersion(root, STUB_REL)).toBe('13.1.1');
    expect(readPackageVersion(root, '.')).toBe('13.1.1');
    expect(readPackageVersion(root, LIB_REL)).toBe('13.1.0');

    expect(listChangesetMdFiles(root)).toEqual(['lib.md']);
    expect(fs.existsSync(path.join(root, '.changeset-hold'))).toBe(false);
  });

  it('does nothing and reports "Nothing to version." when no changeset references the chosen package', async () => {
    writeChangeset(root, 'lib.md', { [LIBRARY]: 'minor' }, 'Lib change');

    const logs = [];
    const result = await runVersion({
      pkg: DATASOURCE,
      repoRoot: root,
      runChangesetVersion: realRunner,
      syncChangelog,
      log: (msg) => logs.push(msg),
    });

    expect(result.exitCode).toBe(0);
    expect(result.versioned).toBe(false);
    expect(logs.join('\n')).toMatch(/Nothing to version/);

    expect(readPackageVersion(root, LIB_REL)).toBe('13.1.0');
    expect(listChangesetMdFiles(root)).toEqual(['lib.md']);
  });

  it('restores held changesets even when the changeset binary fails', async () => {
    writeChangeset(root, 'lib.md', { [LIBRARY]: 'minor' }, 'Lib change');
    writeChangeset(root, 'ds.md', { [DATASOURCE]: 'patch' }, 'DS change');

    const failingRunner = () => 7;

    const result = await runVersion({
      pkg: DATASOURCE,
      repoRoot: root,
      runChangesetVersion: failingRunner,
      syncChangelog,
      log: () => {},
    });

    expect(result.exitCode).toBe(7);
    expect(result.versioned).toBe(false);

    // Both changesets must still be present after restore.
    expect(listChangesetMdFiles(root).sort()).toEqual(['ds.md', 'lib.md']);
    expect(fs.existsSync(path.join(root, '.changeset-hold'))).toBe(false);
  });

  it('does not call syncChangelog when versioning the library', async () => {
    writeChangeset(root, 'lib.md', { [LIBRARY]: 'minor' }, 'Lib change');

    const syncSpy = jest.fn();
    await runVersion({
      pkg: LIBRARY,
      repoRoot: root,
      runChangesetVersion: realRunner,
      syncChangelog: syncSpy,
      log: () => {},
    });

    expect(syncSpy).not.toHaveBeenCalled();
  });

  it('rejects an unknown package', async () => {
    await expect(
      runVersion({
        pkg: 'mystery',
        repoRoot: root,
        runChangesetVersion: realRunner,
        syncChangelog,
      }),
    ).rejects.toThrow(/Invalid package/);
  });
});
