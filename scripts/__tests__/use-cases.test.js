/**
 * @jest-environment node
 */
// End-to-end coverage for the user-facing flows. Each test drives the full CLI
// `run({...})` function with a real fixture monorepo and (where applicable)
// the real `@changesets/cli` binary, so what we exercise here matches what the
// user gets when typing `yarn changeset` / `yarn changeset:version` in a shell.
const fs = require('fs');
const path = require('path');

const addChangeset = require('../add-changeset');
const versionChangeset = require('../version-changeset');
const { syncChangelog } = require('../sync-changelog');
const {
  DATASOURCE,
  LIBRARY,
  PROMLIB,
  createFixture,
  destroyFixture,
  readPackageVersion,
  listChangesetMdFiles,
  getRealChangesetBin,
} = require('./fixture');

const STUB_REL = path.join('packages', 'grafana-prometheus-datasource');
const LIB_REL = path.join('packages', 'grafana-prometheus');
const PROMLIB_STUB_REL = path.join('packages', 'promlib');
const PROMLIB_TARGET_REL = path.join('pkg', 'promlib');

// Build a prompt mock from a list of canned answers, in order.
function makePrompt(answers) {
  const queue = [...answers];
  const calls = [];
  const fn = async (question) => {
    calls.push(question);
    if (queue.length === 0) {
      throw new Error(`Unexpected prompt with no answer queued: "${question}"`);
    }
    return queue.shift();
  };
  fn.calls = calls;
  fn.remaining = () => queue.length;
  return fn;
}

// Real `changeset version` runner, but pinned at the repo's local binary and
// scoped to the fixture's cwd.
function realRunner(opts) {
  return versionChangeset.defaultRunChangesetVersion({
    repoRoot: opts.repoRoot,
    changesetBin: getRealChangesetBin(),
    stdio: 'pipe',
  });
}

function readChangesetFrontmatter(root, fileName) {
  const raw = fs.readFileSync(path.join(root, '.changeset', fileName), 'utf8');
  const { getChangesetPackages } = versionChangeset;
  return {
    raw,
    packages: getChangesetPackages(path.join(root, '.changeset', fileName)),
  };
}

describe('Use case 1.1 — `yarn changeset` interactive', () => {
  let root;

  beforeEach(() => {
    root = createFixture();
  });

  afterEach(() => {
    destroyFixture(root);
  });

  it('user picks 1 (datasource), patch, summary → produces a datasource patch changeset', async () => {
    const prompt = makePrompt(['1', 'patch', 'Fix interactive issue']);

    const result = await addChangeset.run({
      argv: [],
      repoRoot: root,
      prompt,
      log: () => {},
    });

    expect(result.pkg).toBe(DATASOURCE);
    expect(result.bump).toBe('patch');
    expect(result.summary).toBe('Fix interactive issue');

    const files = listChangesetMdFiles(root);
    expect(files).toEqual([`${result.id}.md`]);

    const fm = readChangesetFrontmatter(root, files[0]);
    expect(fm.packages).toEqual(new Set([DATASOURCE]));
    expect(fm.raw).toContain('Fix interactive issue');
    // Confirm the file declares a patch bump, regardless of yaml quoting.
    expect(fm.raw).toMatch(/(['"]?)grafana-prometheus-datasource\1\s*:\s*patch/);
  });

  it('user picks 2 (library), minor, summary → produces a library minor changeset', async () => {
    const prompt = makePrompt(['2', 'minor', 'Add new helper']);

    const result = await addChangeset.run({
      argv: [],
      repoRoot: root,
      prompt,
      log: () => {},
    });

    expect(result.pkg).toBe(LIBRARY);
    expect(result.bump).toBe('minor');

    const fm = readChangesetFrontmatter(root, listChangesetMdFiles(root)[0]);
    expect(fm.packages).toEqual(new Set([LIBRARY]));
    expect(fm.raw).toContain('Add new helper');
    expect(fm.raw).toMatch(/(['"]?)@grafana\/prometheus\1\s*:\s*minor/);
  });

  it('user picks 1 (datasource), major, summary → produces a datasource major changeset', async () => {
    const prompt = makePrompt(['1', 'major', 'Breaking change']);

    const result = await addChangeset.run({
      argv: [],
      repoRoot: root,
      prompt,
      log: () => {},
    });

    expect(result.pkg).toBe(DATASOURCE);
    expect(result.bump).toBe('major');
    const fm = readChangesetFrontmatter(root, listChangesetMdFiles(root)[0]);
    expect(fm.packages).toEqual(new Set([DATASOURCE]));
    expect(fm.raw).toMatch(/(['"]?)grafana-prometheus-datasource\1\s*:\s*major/);
  });

  it('user submits empty package selection → run rejects, no changeset is written', async () => {
    const prompt = makePrompt(['']);

    await expect(addChangeset.run({ argv: [], repoRoot: root, prompt, log: () => {} })).rejects.toThrow(
      /A package must be selected/
    );

    expect(listChangesetMdFiles(root)).toEqual([]);
  });
});

describe('Use case 1.2 — `yarn changeset --library --minor "..."`', () => {
  let root;

  beforeEach(() => {
    root = createFixture();
  });

  afterEach(() => {
    destroyFixture(root);
  });

  it('produces a library minor changeset, no prompts, correct summary', async () => {
    const prompt = makePrompt([]); // must not be called

    const result = await addChangeset.run({
      argv: ['--library', '--minor', 'some', 'test', 'for', 'minor', 'level', 'change'],
      repoRoot: root,
      prompt,
      log: () => {},
    });

    expect(result).toMatchObject({
      pkg: LIBRARY,
      bump: 'minor',
      summary: 'some test for minor level change',
    });
    expect(prompt.calls).toEqual([]);

    const files = listChangesetMdFiles(root);
    expect(files).toHaveLength(1);

    const fm = readChangesetFrontmatter(root, files[0]);
    expect(fm.packages).toEqual(new Set([LIBRARY]));
    expect(fm.raw).toContain('some test for minor level change');
    expect(fm.raw).toMatch(/(['"]?)@grafana\/prometheus\1\s*:\s*minor/);
  });
});

describe('Use case 1.3 — `yarn changeset --datasource --patch "Fix panel"`', () => {
  let root;

  beforeEach(() => {
    root = createFixture();
  });

  afterEach(() => {
    destroyFixture(root);
  });

  it('produces a datasource patch changeset, no prompts, summary "Fix panel"', async () => {
    const prompt = makePrompt([]);

    const result = await addChangeset.run({
      argv: ['--datasource', '--patch', 'Fix', 'panel'],
      repoRoot: root,
      prompt,
      log: () => {},
    });

    expect(result).toMatchObject({
      pkg: DATASOURCE,
      bump: 'patch',
      summary: 'Fix panel',
    });
    expect(prompt.calls).toEqual([]);

    const files = listChangesetMdFiles(root);
    expect(files).toHaveLength(1);

    const fm = readChangesetFrontmatter(root, files[0]);
    expect(fm.packages).toEqual(new Set([DATASOURCE]));
    expect(fm.raw).toContain('Fix panel');
    expect(fm.raw).toMatch(/(['"]?)grafana-prometheus-datasource\1\s*:\s*patch/);
  });
});

describe('Use case 1.4 — `yarn changeset:version --datasource`', () => {
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

  it('consumes ALL datasource changesets, bumps root + stub package.json, leaves library changesets and version untouched', async () => {
    // Three datasource changesets (a major + a minor + a patch → final bump
    // is the highest, which is "major"), plus two unrelated library
    // changesets that must be preserved on disk.
    await addChangeset.run({
      argv: ['--datasource', '--patch', 'Fix A'],
      repoRoot: root,
      prompt: makePrompt([]),
      log: () => {},
    });
    await addChangeset.run({
      argv: ['--datasource', '--minor', 'Add B'],
      repoRoot: root,
      prompt: makePrompt([]),
      log: () => {},
    });
    await addChangeset.run({
      argv: ['--datasource', '--major', 'Break C'],
      repoRoot: root,
      prompt: makePrompt([]),
      log: () => {},
    });
    await addChangeset.run({
      argv: ['--library', '--minor', 'Lib unrelated 1'],
      repoRoot: root,
      prompt: makePrompt([]),
      log: () => {},
    });
    await addChangeset.run({
      argv: ['--library', '--patch', 'Lib unrelated 2'],
      repoRoot: root,
      prompt: makePrompt([]),
      log: () => {},
    });

    expect(listChangesetMdFiles(root)).toHaveLength(5);

    const result = await versionChangeset.run({
      argv: ['--datasource'],
      repoRoot: root,
      runChangesetVersion: realRunner,
      syncChangelog,
      log: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.versioned).toBe(true);
    expect(result.heldCount).toBe(2);

    expect(readPackageVersion(root, STUB_REL)).toBe('14.0.0');
    expect(readPackageVersion(root, '.')).toBe('14.0.0');

    expect(readPackageVersion(root, LIB_REL)).toBe('13.1.0');

    const remaining = listChangesetMdFiles(root);
    expect(remaining).toHaveLength(2);
    for (const file of remaining) {
      const { packages } = readChangesetFrontmatter(root, file);
      expect([...packages]).toEqual([LIBRARY]);
    }

    const rootChangelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    expect(rootChangelog).toContain('14.0.0');

    // The release section must be flat — no Major/Minor/Patch sub-headings,
    // and the three entries (one per bump level) sit on consecutive lines
    // immediately under the version heading.
    expect(rootChangelog).not.toMatch(/### (?:Major|Minor|Patch) Changes/);
    const versionSectionMatch = rootChangelog.match(/## 14\.0\.0\n\n([\s\S]*?)(?=\n## |\n*$)/);
    expect(versionSectionMatch).not.toBeNull();
    const entryLines = versionSectionMatch[1]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(entryLines.sort()).toEqual(['- Add B', '- Break C', '- Fix A'].sort());

    expect(fs.existsSync(path.join(root, '.changeset-hold'))).toBe(false);
  });
});

describe('Use case 1.5 — `yarn changeset:version --library`', () => {
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

  it('consumes ALL library changesets, bumps the library only, leaves datasource changesets and the root/stub versions untouched', async () => {
    await addChangeset.run({
      argv: ['--library', '--patch', 'Lib patch 1'],
      repoRoot: root,
      prompt: makePrompt([]),
      log: () => {},
    });
    await addChangeset.run({
      argv: ['--library', '--minor', 'Lib minor 2'],
      repoRoot: root,
      prompt: makePrompt([]),
      log: () => {},
    });
    await addChangeset.run({
      argv: ['--datasource', '--patch', 'DS unrelated'],
      repoRoot: root,
      prompt: makePrompt([]),
      log: () => {},
    });

    expect(listChangesetMdFiles(root)).toHaveLength(3);

    const result = await versionChangeset.run({
      argv: ['--library'],
      repoRoot: root,
      runChangesetVersion: realRunner,
      syncChangelog,
      log: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.versioned).toBe(true);
    expect(result.heldCount).toBe(1);

    expect(readPackageVersion(root, LIB_REL)).toBe('13.2.0');

    expect(readPackageVersion(root, STUB_REL)).toBe('13.1.0');
    expect(readPackageVersion(root, '.')).toBe('13.1.0');

    const remaining = listChangesetMdFiles(root);
    expect(remaining).toHaveLength(1);
    const { packages } = readChangesetFrontmatter(root, remaining[0]);
    expect([...packages]).toEqual([DATASOURCE]);

    expect(fs.existsSync(path.join(root, '.changeset-hold'))).toBe(false);
  });

  it('also works through the interactive picker (user types "2" for library)', async () => {
    await addChangeset.run({
      argv: ['--library', '--minor', 'Lib via interactive version'],
      repoRoot: root,
      prompt: makePrompt([]),
      log: () => {},
    });

    const versionPrompt = makePrompt(['2']);
    const result = await versionChangeset.run({
      argv: [],
      repoRoot: root,
      prompt: versionPrompt,
      runChangesetVersion: realRunner,
      syncChangelog,
      log: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.versioned).toBe(true);
    expect(readPackageVersion(root, LIB_REL)).toBe('13.2.0');
  });
});

describe('Use case 1.6 — `yarn changeset:version --promlib`', () => {
  let root;

  beforeEach(() => {
    root = createFixture({
      rootVersion: '13.1.0',
      libraryVersion: '13.1.0',
      datasourceVersion: '13.1.0',
      promlibVersion: '0.0.10',
    });
  });

  afterEach(() => {
    destroyFixture(root);
  });

  it('consumes ALL promlib changesets, mirrors the CHANGELOG to pkg/promlib, and leaves the other packages untouched', async () => {
    await addChangeset.run({
      argv: ['--promlib', '--patch', 'Promlib bugfix 1'],
      repoRoot: root,
      prompt: makePrompt([]),
      log: () => {},
    });
    await addChangeset.run({
      argv: ['--promlib', '--minor', 'Promlib feature'],
      repoRoot: root,
      prompt: makePrompt([]),
      log: () => {},
    });
    await addChangeset.run({
      argv: ['--library', '--minor', 'Lib unrelated'],
      repoRoot: root,
      prompt: makePrompt([]),
      log: () => {},
    });
    await addChangeset.run({
      argv: ['--datasource', '--patch', 'DS unrelated'],
      repoRoot: root,
      prompt: makePrompt([]),
      log: () => {},
    });

    expect(listChangesetMdFiles(root)).toHaveLength(4);

    const result = await versionChangeset.run({
      argv: ['--promlib'],
      repoRoot: root,
      runChangesetVersion: realRunner,
      syncChangelog,
      log: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.versioned).toBe(true);
    expect(result.heldCount).toBe(2);

    expect(readPackageVersion(root, PROMLIB_STUB_REL)).toBe('0.1.0');

    expect(readPackageVersion(root, LIB_REL)).toBe('13.1.0');
    expect(readPackageVersion(root, STUB_REL)).toBe('13.1.0');
    expect(readPackageVersion(root, '.')).toBe('13.1.0');

    const promlibChangelog = fs.readFileSync(path.join(root, PROMLIB_TARGET_REL, 'CHANGELOG.md'), 'utf8');
    expect(promlibChangelog).toContain('0.1.0');
    expect(promlibChangelog).toContain('Promlib bugfix 1');
    expect(promlibChangelog).toContain('Promlib feature');

    expect(fs.existsSync(path.join(root, 'CHANGELOG.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, PROMLIB_TARGET_REL, 'package.json'))).toBe(false);

    const remaining = listChangesetMdFiles(root);
    expect(remaining).toHaveLength(2);
    const remainingPackages = new Set();
    for (const file of remaining) {
      for (const pkg of versionChangeset.getChangesetPackages(path.join(root, '.changeset', file))) {
        remainingPackages.add(pkg);
      }
    }
    expect(remainingPackages).toEqual(new Set([LIBRARY, DATASOURCE]));

    expect(fs.existsSync(path.join(root, '.changeset-hold'))).toBe(false);
  });

  it('also works through the interactive picker (user types "3" for promlib)', async () => {
    await addChangeset.run({
      argv: ['--promlib', '--patch', 'Promlib via picker'],
      repoRoot: root,
      prompt: makePrompt([]),
      log: () => {},
    });

    const versionPrompt = makePrompt(['3']);
    const result = await versionChangeset.run({
      argv: [],
      repoRoot: root,
      prompt: versionPrompt,
      runChangesetVersion: realRunner,
      syncChangelog,
      log: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.versioned).toBe(true);
    expect(readPackageVersion(root, PROMLIB_STUB_REL)).toBe('0.0.11');
  });
});
