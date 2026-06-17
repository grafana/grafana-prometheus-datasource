const path = require('path');
const { spawnSync } = require('child_process');

const pkg = require(path.join(__dirname, '..', 'packages', 'grafana-prometheus', 'package.json'));
const repoUrl = (pkg.repository?.url ?? '').replace(/\.git$/, '');

function getPRLink(changesetId) {
  if (!repoUrl) {
    return '';
  }
  try {
    const result = spawnSync(
      'git',
      ['log', '--all', '--follow', '--pretty=format:%s', '--', `.changeset/${changesetId}.md`],
      { encoding: 'utf8' }
    );
    if (result.status !== 0 || !result.stdout) {
      return '';
    }
    const earliest = result.stdout.trim().split('\n').pop();
    const match = earliest.match(/\(#(\d+)\)\s*$/);
    if (!match) {
      return '';
    }
    return ` ([#${match[1]}](${repoUrl}/pull/${match[1]}))`;
  } catch (_) {
    return '';
  }
}

const changelogFunctions = {
  getReleaseLine: async (changeset, type, options) => {
    let prefix = '🎉';
    if (type === 'major') {
      prefix = '🎉';
    } else if (type === 'minor') {
      prefix = '🚀';
    } else if (type === 'patch') {
      prefix = '🐛';
    }
    if (changeset && changeset.summary) {
      const summary = changeset.summary || '';
      if (summary.indexOf('Docs') > -1) {
        prefix = '📝';
      }
      if (
        summary.indexOf('Chore') > -1 ||
        summary.indexOf('grafana-plugin-sdk-go') > -1 ||
        summary.indexOf('compiled') > -1
      ) {
        prefix = '⚙️';
      }
      return [prefix, summary].join(' ') + getPRLink(changeset.id);
    }
    return [prefix, changeset?.summary].join(' ') + getPRLink(changeset?.id ?? '');
  },
  getDependencyReleaseLine: async (changesets, dependenciesUpdated, options) => {
    return '\n';
  },
};

module.exports = changelogFunctions;
