import { formatLabelFiltersToString } from './formatter';

describe('formatLabelFiltersToString', () => {
  it('preserves every PromQL matcher operator for search selectors', () => {
    expect(
      formatLabelFiltersToString([
        { label: 'exact', op: '=', value: 'one' },
        { label: 'excluded', op: '!=', value: 'two' },
        { label: 'matches', op: '=~', value: 'three.*' },
        { label: 'not_matches', op: '!~', value: 'four.*' },
      ])
    ).toBe('{exact="one", excluded!="two", matches=~"three.*", not_matches!~"four.*"}');
  });
});
