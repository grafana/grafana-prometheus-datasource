// Reuse the `library` project defined at the repo root so this package's tests run with
// the same swc + jsdom + module mappers as the rest of the monorepo. We deliberately do NOT
// spread the root config's default export: it exports a `projects` array, and Jest gives
// `projects` precedence over any sibling `testMatch`, which previously caused this package's
// tests to be silently skipped. Selecting a single project (no `projects` key) keeps the
// project's own `testMatch` in effect.
const { projects } = require('../../jest.config.js');

const libraryProject = projects.find((project) => project.displayName === 'library');

if (!libraryProject) {
  throw new Error("Could not find the 'library' Jest project in the root jest.config.js");
}

module.exports = libraryProject;
