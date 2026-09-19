export const rangeModifierFunctions = {
  anchored: ['rate', 'increase', 'delta', 'changes', 'resets'],
  smoothed: ['rate', 'increase', 'delta'],
};

export type RangeModifier = keyof typeof rangeModifierFunctions;

export const rangeModifierDocumentation: Record<RangeModifier, string> = {
  anchored:
    'Uses the sample at or before the start of the range (within the lookback delta), or the first sample in the range, and the last sample in the range. No extrapolation or interpolation is applied. Requires Prometheus with --enable-feature=promql-extended-range-selectors.',
  smoothed:
    'Interpolates sample values at the range boundaries to account for irregular or missed scrapes. Requires samples after the end of the range, so recent results may be underestimated. In recording and alerting rules, use a rule group query_offset to allow those samples to arrive. Requires Prometheus with --enable-feature=promql-extended-range-selectors.',
};

export function getRangeModifierOperationId(functionName: string, modifier: RangeModifier): string {
  return `__${functionName}_${modifier}`;
}
