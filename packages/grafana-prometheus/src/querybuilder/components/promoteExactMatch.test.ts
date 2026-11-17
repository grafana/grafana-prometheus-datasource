import { promoteExactMatch } from './promoteExactMatch';

const toOptions = (values: string[]) => values.map((value) => ({ label: value, value }));

describe('promoteExactMatch', () => {
  it.each([
    ['moves the exact match to the front', ['up_time', 'upstream', 'up'], 'up', ['up', 'up_time', 'upstream']],
    ['keeps the order when the exact match is already first', ['up', 'up_time'], 'up', ['up', 'up_time']],
    ['keeps the order when nothing matches exactly', ['up_time', 'upstream'], 'up', ['up_time', 'upstream']],
    ['keeps the order for an empty input', ['b', 'a'], '', ['b', 'a']],
    ['matches case-sensitively', ['UP', 'up_time', 'up'], 'UP', ['UP', 'up_time', 'up']],
    ['does not treat a different case as exact', ['up_time', 'Up'], 'up', ['up_time', 'Up']],
  ])('%s', (_name, values, input, expected) => {
    expect(promoteExactMatch(toOptions(values), input).map((o) => o.value)).toEqual(expected);
  });

  it('returns new option objects when it reorders, so react-select drops the old focus', () => {
    const options = toOptions(['up_time', 'up']);
    const result = promoteExactMatch(options, 'up');
    expect(result).not.toContain(options[0]);
    expect(result).not.toContain(options[1]);
  });

  it('returns the same array when nothing moves', () => {
    const options = toOptions(['up', 'up_time']);
    expect(promoteExactMatch(options, 'up')).toBe(options);
  });

  it('does not mutate the input array', () => {
    const options = toOptions(['up_time', 'up']);
    promoteExactMatch(options, 'up');
    expect(options.map((o) => o.value)).toEqual(['up_time', 'up']);
  });
});
