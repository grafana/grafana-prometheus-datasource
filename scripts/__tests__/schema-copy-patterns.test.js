/**
 * @jest-environment node
 */
const fs = require('fs');

const { COMBINED_SCHEMA_TO, addQuerySchemas, schemaCopyPatterns } = require('../schema-copy-patterns');

describe('schemaCopyPatterns', () => {
  it('copies only files that exist', () => {
    for (const pattern of schemaCopyPatterns) {
      expect(fs.existsSync(pattern.from)).toBe(true);
    }
  });

  it('ships the query type files next to the settings files', () => {
    const targets = schemaCopyPatterns.map((pattern) => pattern.to);
    expect(targets).toContain('./schema/v0alpha1/query.types.json');
    expect(targets).toContain('./schema/v0alpha1/query.examples.json');
  });

  // Grafana loads only this file, so the query schema must be in it.
  it('puts the query types and examples into the combined schema', () => {
    const combined = schemaCopyPatterns.find((pattern) => pattern.to === COMBINED_SCHEMA_TO);
    expect(combined).toBeDefined();
    expect(combined.transform).toBeDefined();

    const generated = JSON.parse(fs.readFileSync(combined.from, 'utf8'));
    const shipped = JSON.parse(combined.transform(fs.readFileSync(combined.from)));

    expect(shipped.targetApiVersion).toBe('v0alpha1');
    expect(shipped.settings).toEqual(generated.settings);
    expect(shipped.settingsExamples).toEqual(generated.settingsExamples);
    expect(shipped.queryTypes.kind).toBe('QueryTypeDefinitionList');
    expect(shipped.queryTypes.items.length).toBeGreaterThan(0);
    expect(shipped.queryExamples.examples.length).toBeGreaterThan(0);
  });
});

describe('addQuerySchemas', () => {
  it.each(['queryTypes', 'queryExamples'])('fails when the generated schema already contains %s', (key) => {
    const generated = Buffer.from(JSON.stringify({ targetApiVersion: 'v0alpha1', [key]: {} }));
    expect(() => addQuerySchemas(generated)).toThrow(key);
  });
});
