/**
 * @jest-environment node
 */
const { findMissingMirrors, parseChangeset } = require('../check-changeset-mirrors');

function changeset(filePath, releases, body) {
  const frontmatter = Object.entries(releases)
    .map(([pkg, bump]) => `'${pkg}': ${bump}`)
    .join('\n');
  return { filePath, content: `---\n${frontmatter}\n---\n\n${body}\n` };
}

describe('check-changeset-mirrors', () => {
  it('accepts an npm package changeset with a matching datasource patch changeset', () => {
    expect(
      findMissingMirrors([
        changeset('.changeset/library.md', { '@grafana/prometheus': 'minor' }, 'Add a query helper'),
        changeset('.changeset/datasource.md', { 'grafana-prometheus-datasource': 'patch' }, 'Add a query helper'),
      ])
    ).toEqual([]);
  });

  it('accepts a promlib changeset with a matching datasource patch changeset', () => {
    expect(
      findMissingMirrors([
        changeset('.changeset/promlib.md', { promlib: 'patch' }, 'Fix response parsing'),
        changeset('.changeset/datasource.md', { 'grafana-prometheus-datasource': 'patch' }, 'Fix response parsing'),
      ])
    ).toEqual([]);
  });

  it('ignores direct datasource changesets', () => {
    expect(
      findMissingMirrors([
        changeset('.changeset/datasource.md', { 'grafana-prometheus-datasource': 'minor' }, 'Add plugin feature'),
      ])
    ).toEqual([]);
  });

  it('reports a library changeset without a datasource changeset', () => {
    expect(
      findMissingMirrors([changeset('.changeset/library.md', { '@grafana/prometheus': 'patch' }, 'Fix query behavior')])
    ).toEqual(['.changeset/library.md']);
  });

  it('requires the datasource changeset to have the same body', () => {
    expect(
      findMissingMirrors([
        changeset('.changeset/library.md', { '@grafana/prometheus': 'patch' }, 'Fix query behavior'),
        changeset('.changeset/datasource.md', { 'grafana-prometheus-datasource': 'patch' }, 'Different summary'),
      ])
    ).toEqual(['.changeset/library.md']);
  });

  it('requires a separate datasource-only patch changeset', () => {
    expect(
      findMissingMirrors([
        changeset(
          '.changeset/combined.md',
          { '@grafana/prometheus': 'patch', 'grafana-prometheus-datasource': 'patch' },
          'Fix query behavior'
        ),
      ])
    ).toEqual(['.changeset/combined.md']);
  });

  it('does not accept a non-patch datasource mirror', () => {
    expect(
      findMissingMirrors([
        changeset('.changeset/promlib.md', { promlib: 'patch' }, 'Fix response parsing'),
        changeset('.changeset/datasource.md', { 'grafana-prometheus-datasource': 'minor' }, 'Fix response parsing'),
      ])
    ).toEqual(['.changeset/promlib.md']);
  });

  it('normalizes line endings and surrounding body whitespace', () => {
    const parsed = parseChangeset(
      '.changeset/example.md',
      "---\r\n'@grafana/prometheus': patch\r\n---\r\n\r\nFix query behavior\r\n"
    );

    expect(parsed.releases).toEqual(new Map([['@grafana/prometheus', 'patch']]));
    expect(parsed.body).toBe('Fix query behavior');
  });
});
