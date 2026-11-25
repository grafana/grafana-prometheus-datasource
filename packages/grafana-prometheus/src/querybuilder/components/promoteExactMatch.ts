import { type SelectableValue } from '@grafana/data';

/**
 * Moves the option whose value equals the typed input to the front of the list.
 *
 * The builder selects highlight the first option, so pressing Enter picks it.
 * Search results come back in alphabetical order, which puts longer names such as
 * `up_time` ahead of an exact `up` match. Promoting the exact match makes Enter
 * select what the user typed. The match is case-sensitive, like Prometheus names.
 *
 * react-select keeps focus on the previously focused option while that same object
 * is still in the list, so a reordered list is returned as shallow copies. That makes
 * react-select move focus to the first option, the exact match.
 */
export function promoteExactMatch<T extends SelectableValue>(options: T[], input: string): T[] {
  if (!input) {
    return options;
  }
  const index = options.findIndex((option) => option.value === input);
  if (index <= 0) {
    return options;
  }
  return [options[index], ...options.slice(0, index), ...options.slice(index + 1)].map((option) => ({ ...option }));
}
