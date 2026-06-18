import { QueryFixAction } from '@grafana/data';

import { addLabelToQuery } from './add_label_to_query';
import { expandRecordingRules } from './language_utils';
import { PromQuery } from './types';

export function applyModifyQuery(query: PromQuery, action: QueryFixAction): PromQuery {
  let expression = query.expr ?? '';
  switch (action.type) {
    case 'ADD_FILTER': {
      const { key, value } = action.options ?? {};
      if (key && value) {
        expression = addLabelToQuery(expression, key, value);
      }
      break;
    }
    case 'ADD_FILTER_OUT': {
      const { key, value } = action.options ?? {};
      if (key && value) {
        expression = addLabelToQuery(expression, key, value, '!=');
      }
      break;
    }
    case 'ADD_HISTOGRAM_QUANTILE': {
      expression = `histogram_quantile(0.95, sum(rate(${expression}[$__rate_interval])) by (le))`;
      break;
    }
    case 'ADD_HISTOGRAM_AVG': {
      expression = `histogram_avg(rate(${expression}[$__rate_interval]))`;
      break;
    }
    case 'ADD_HISTOGRAM_FRACTION': {
      expression = `histogram_fraction(0,0.2,rate(${expression}[$__rate_interval]))`;
      break;
    }
    case 'ADD_HISTOGRAM_COUNT': {
      expression = `histogram_count(rate(${expression}[$__rate_interval]))`;
      break;
    }
    case 'ADD_HISTOGRAM_SUM': {
      expression = `histogram_sum(rate(${expression}[$__rate_interval]))`;
      break;
    }
    case 'ADD_HISTOGRAM_STDDEV': {
      expression = `histogram_stddev(rate(${expression}[$__rate_interval]))`;
      break;
    }
    case 'ADD_HISTOGRAM_STDVAR': {
      expression = `histogram_stdvar(rate(${expression}[$__rate_interval]))`;
      break;
    }
    case 'ADD_RATE': {
      expression = `rate(${expression}[$__rate_interval])`;
      break;
    }
    case 'ADD_SUM': {
      expression = `sum(${expression.trim()}) by ($1)`;
      break;
    }
    case 'EXPAND_RULES': {
      if (action.options) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expression = expandRecordingRules(expression, action.options as any);
      }
      break;
    }
    default:
      break;
  }
  return { ...query, expr: expression };
}
