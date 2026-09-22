import { formatKeyValueStrings, formatLabelFiltersToString } from './formatter';

describe('query builder search formatting', () => {
  const filters = [
    { label: 'job', op: '!=', value: 'grafana' },
    { label: 'environment', op: '=~', value: 'prod.*' },
  ];

  it('preserves label operators in metric-name regex selectors', () => {
    expect(formatKeyValueStrings('http', filters)).toBe('{__name__=~".*http.*",job!="grafana",environment=~"prod.*"}');
  });

  it('renders label-only selectors for Search API match parameters', () => {
    expect(formatLabelFiltersToString(filters)).toBe('{job!="grafana", environment=~"prod.*"}');
    expect(formatLabelFiltersToString()).toBe('');
  });
});
