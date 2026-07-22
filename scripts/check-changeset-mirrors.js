#!/usr/bin/env node
const fs = require('fs');

const DATASOURCE = 'grafana-prometheus-datasource';
const LIBRARIES = new Set(['@grafana/prometheus', 'promlib']);

function parseChangeset(filePath, content) {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/);
  if (!frontmatter) {
    return { filePath, releases: new Map(), body: '' };
  }

  const releases = new Map();
  for (const line of frontmatter[1].split(/\r?\n/)) {
    const release = line.match(/^\s*(?:"([^"]+)"|'([^']+)'|([^\s'":]+))\s*:\s*(patch|minor|major)\s*$/);
    if (release) {
      releases.set(release[1] || release[2] || release[3], release[4]);
    }
  }

  return {
    filePath,
    releases,
    body: content.slice(frontmatter[0].length).replace(/\r\n/g, '\n').trim(),
  };
}

function findMissingMirrors(changesets) {
  const parsed = changesets.map(({ filePath, content }) => parseChangeset(filePath, content));
  const datasourceChangesets = parsed.filter(
    ({ releases }) => releases.size === 1 && releases.get(DATASOURCE) === 'patch'
  );

  return parsed
    .filter(({ releases }) => [...LIBRARIES].some((library) => releases.has(library)))
    .filter(
      (libraryChangeset) =>
        !datasourceChangesets.some(
          (datasourceChangeset) =>
            datasourceChangeset.filePath !== libraryChangeset.filePath &&
            datasourceChangeset.body === libraryChangeset.body
        )
    )
    .map(({ filePath }) => filePath);
}

function main(filePaths) {
  const changesets = filePaths.map((filePath) => ({
    filePath,
    content: fs.readFileSync(filePath, 'utf8'),
  }));
  const missingMirrors = findMissingMirrors(changesets);

  if (missingMirrors.length > 0) {
    for (const filePath of missingMirrors) {
      console.error(
        `::error file=${filePath}::Library changeset '${filePath}' must have a separate ` +
          `${DATASOURCE} patch changeset with the same content. Run 'yarn changeset' to generate both files.`
      );
    }
    return 1;
  }

  console.log('All library changesets have matching datasource patch changesets.');
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { DATASOURCE, LIBRARIES, parseChangeset, findMissingMirrors, main };
