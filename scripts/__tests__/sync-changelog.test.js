/**
 * @jest-environment node
 */
const fs = require('fs');
const path = require('path');

const { syncChangelog } = require('../sync-changelog');
const {
  createFixture,
  destroyFixture,
  readJson,
} = require('./fixture');

const STUB_REL = path.join('packages', 'grafana-prometheus-datasource');

describe('sync-changelog', () => {
  let root;

  beforeEach(() => {
    root = createFixture({ rootVersion: '13.1.0', datasourceVersion: '13.1.0' });
  });

  afterEach(() => {
    destroyFixture(root);
  });

  it('mirrors the stub CHANGELOG.md to the workspace root', () => {
    fs.writeFileSync(
      path.join(root, STUB_REL, 'CHANGELOG.md'),
      '# stub\n\n## 13.1.1\n\nstub entry\n',
    );

    syncChangelog(root);

    const rootChangelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    expect(rootChangelog).toContain('## 13.1.1');
    expect(rootChangelog).toContain('stub entry');
  });

  it('updates the workspace root package.json version to match the stub', () => {
    const stubPkgPath = path.join(root, STUB_REL, 'package.json');
    const stubPkg = readJson(stubPkgPath);
    stubPkg.version = '13.1.1';
    fs.writeFileSync(stubPkgPath, JSON.stringify(stubPkg, null, 2) + '\n');

    syncChangelog(root);

    expect(readJson(path.join(root, 'package.json')).version).toBe('13.1.1');
  });

  it('is a no-op for the root package.json when versions already match', () => {
    const rootPkgPath = path.join(root, 'package.json');
    const before = fs.readFileSync(rootPkgPath, 'utf8');

    syncChangelog(root);

    expect(fs.readFileSync(rootPkgPath, 'utf8')).toBe(before);
  });

  it('does not create a root CHANGELOG when the stub has none', () => {
    syncChangelog(root);
    expect(fs.existsSync(path.join(root, 'CHANGELOG.md'))).toBe(false);
  });
});
