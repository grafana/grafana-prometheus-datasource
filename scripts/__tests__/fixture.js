// Builds an isolated monorepo fixture in a temp directory so tests can run
// the real `@changesets/cli` binary against a clean workspace.
//
// Layout produced:
//   <root>/
//     package.json            (workspaces: ["packages/*"])
//     packages/
//       grafana-prometheus/package.json
//       grafana-prometheus-datasource/package.json
//     .changeset/
//       README.md
//       config.json           (changelog: false, no commit, baseBranch: main)
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATASOURCE = 'grafana-prometheus-datasource';
const LIBRARY = '@grafana/prometheus';
const PROMLIB = 'promlib';

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createFixture({
  rootName = 'fixture-root',
  rootVersion = '13.1.0',
  libraryVersion = '13.1.0',
  datasourceVersion = '13.1.0',
  promlibVersion = '0.0.10',
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'changeset-fixture-'));

  writeJson(path.join(root, 'package.json'), {
    name: rootName,
    version: rootVersion,
    private: true,
    workspaces: ['packages/*'],
  });

  writeJson(path.join(root, 'packages', 'grafana-prometheus', 'package.json'), {
    name: LIBRARY,
    version: libraryVersion,
  });

  writeJson(path.join(root, 'packages', 'grafana-prometheus-datasource', 'package.json'), {
    name: DATASOURCE,
    version: datasourceVersion,
    private: true,
  });

  writeJson(path.join(root, 'packages', 'promlib', 'package.json'), {
    name: PROMLIB,
    version: promlibVersion,
    private: true,
  });

  writeText(path.join(root, '.changeset', 'README.md'), '# Changesets\n');
  // Minimal local changelog generator so `changeset version` emits a
  // CHANGELOG.md (which the datasource sync flow then mirrors to the root).
  writeText(
    path.join(root, '.changeset', 'changelog.js'),
    [
      'module.exports = {',
      '  getReleaseLine: async (changeset) => `- ${changeset.summary}`,',
      '  getDependencyReleaseLine: async () => "",',
      '};',
      '',
    ].join('\n')
  );
  writeJson(path.join(root, '.changeset', 'config.json'), {
    $schema: 'https://unpkg.com/@changesets/config@3.1.4/schema.json',
    changelog: './changelog.js',
    commit: false,
    fixed: [],
    linked: [],
    access: 'restricted',
    baseBranch: 'main',
    updateInternalDependencies: 'patch',
    ignore: [],
  });

  return root;
}

function destroyFixture(root) {
  if (root && fs.existsSync(root)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readPackageVersion(root, relativeDir) {
  return readJson(path.join(root, relativeDir, 'package.json')).version;
}

function listChangesetMdFiles(root) {
  const dir = path.join(root, '.changeset');
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name.toLowerCase() !== 'readme.md')
    .sort();
}

function writeChangeset(root, fileName, frontmatter, summary = 'Test changeset') {
  const lines = ['---'];
  for (const [pkg, bump] of Object.entries(frontmatter)) {
    lines.push(`'${pkg}': ${bump}`);
  }
  lines.push('---', '', summary, '');
  fs.writeFileSync(path.join(root, '.changeset', fileName), lines.join('\n'));
}

// Path to the locally-installed changeset CLI binary (in the real repo).
function getRealChangesetBin() {
  return path.join(__dirname, '..', '..', 'node_modules', '.bin', 'changeset');
}

module.exports = {
  DATASOURCE,
  LIBRARY,
  PROMLIB,
  createFixture,
  destroyFixture,
  readJson,
  readPackageVersion,
  listChangesetMdFiles,
  writeChangeset,
  getRealChangesetBin,
};
