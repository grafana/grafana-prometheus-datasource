/**
 * @jest-environment node
 */
const fs = require('fs');
const path = require('path');

const { DATASOURCE, LIBRARY, parseArgs, createChangeset, BUMP_TYPES } = require('../add-changeset');
const { createFixture, destroyFixture, listChangesetMdFiles } = require('./fixture');

describe('add-changeset / parseArgs', () => {
  it('parses --datasource --patch with summary words', () => {
    const args = parseArgs(['--datasource', '--patch', 'Fix', 'panel']);
    expect(args).toEqual({ pkg: DATASOURCE, bump: 'patch', summary: 'Fix panel' });
  });

  it('parses --library --minor', () => {
    const args = parseArgs(['--library', '--minor', 'Add util']);
    expect(args).toEqual({ pkg: LIBRARY, bump: 'minor', summary: 'Add util' });
  });

  it('parses --plugin as alias for datasource', () => {
    expect(parseArgs(['--plugin', '--major', 'X']).pkg).toBe(DATASOURCE);
  });

  it('parses --lib as alias for library', () => {
    expect(parseArgs(['--lib', '--patch', 'Y']).pkg).toBe(LIBRARY);
  });

  it('treats missing flags as null / empty', () => {
    expect(parseArgs([])).toEqual({ pkg: null, bump: null, summary: '' });
  });

  it('throws when both --datasource and --library are passed', () => {
    expect(() => parseArgs(['--datasource', '--library'])).toThrow(/Only one of/);
  });

  it('exposes the canonical bump-type list', () => {
    expect(BUMP_TYPES).toEqual(['patch', 'minor', 'major']);
  });
});

describe('add-changeset / createChangeset', () => {
  let root;

  beforeEach(() => {
    root = createFixture();
  });

  afterEach(() => {
    destroyFixture(root);
  });

  // Frontmatter is YAML, where double or single quotes around keys are both
  // valid. Match either form so we don't lock the test to whichever quoting
  // style `@changesets/write` happens to emit today.
  function expectFrontmatterEntry(content, pkg, bump) {
    const matchers = [
      `"${pkg}": ${bump}`,
      `'${pkg}': ${bump}`,
      `${pkg}: ${bump}`,
    ];
    expect(matchers.some((m) => content.includes(m))).toBe(true);
  }

  it('writes a .changeset/<id>.md file for the datasource with the right frontmatter', async () => {
    const id = await createChangeset({
      pkg: DATASOURCE,
      bump: 'patch',
      summary: 'Fix panel',
      repoRoot: root,
    });

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    const mdFiles = listChangesetMdFiles(root);
    expect(mdFiles).toEqual([`${id}.md`]);

    const content = fs.readFileSync(path.join(root, '.changeset', `${id}.md`), 'utf8');
    expectFrontmatterEntry(content, DATASOURCE, 'patch');
    expect(content).toContain('Fix panel');
  });

  it('writes a changeset for the library with the right frontmatter', async () => {
    const id = await createChangeset({
      pkg: LIBRARY,
      bump: 'minor',
      summary: 'Add util',
      repoRoot: root,
    });

    const content = fs.readFileSync(path.join(root, '.changeset', `${id}.md`), 'utf8');
    expectFrontmatterEntry(content, LIBRARY, 'minor');
    expect(content).toContain('Add util');
  });

  it('supports the major bump', async () => {
    const id = await createChangeset({
      pkg: LIBRARY,
      bump: 'major',
      summary: 'Breaking change',
      repoRoot: root,
    });
    const content = fs.readFileSync(path.join(root, '.changeset', `${id}.md`), 'utf8');
    expectFrontmatterEntry(content, LIBRARY, 'major');
  });

  it('produces files whose frontmatter is parseable by version-changeset getChangesetPackages', async () => {
    const { getChangesetPackages } = require('../version-changeset');
    const id = await createChangeset({
      pkg: DATASOURCE,
      bump: 'patch',
      summary: 'Round-trip',
      repoRoot: root,
    });
    const file = path.join(root, '.changeset', `${id}.md`);
    expect(getChangesetPackages(file)).toEqual(new Set([DATASOURCE]));
  });

  it('rejects an invalid package name', async () => {
    await expect(
      createChangeset({ pkg: 'random-pkg', bump: 'patch', summary: 'x', repoRoot: root }),
    ).rejects.toThrow(/Invalid package/);
  });

  it('rejects an invalid bump type', async () => {
    await expect(
      createChangeset({ pkg: LIBRARY, bump: 'huge', summary: 'x', repoRoot: root }),
    ).rejects.toThrow(/Invalid bump type/);
  });

  it('rejects an empty summary', async () => {
    await expect(
      createChangeset({ pkg: LIBRARY, bump: 'patch', summary: '', repoRoot: root }),
    ).rejects.toThrow(/summary is required/);
  });

  it('creates multiple distinct changesets in the same fixture', async () => {
    await createChangeset({ pkg: DATASOURCE, bump: 'patch', summary: 'A', repoRoot: root });
    await createChangeset({ pkg: LIBRARY, bump: 'minor', summary: 'B', repoRoot: root });

    expect(listChangesetMdFiles(root)).toHaveLength(2);
  });
});
