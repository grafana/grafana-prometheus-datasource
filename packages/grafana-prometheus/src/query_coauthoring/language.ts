import { getDefaultTimeRange } from '@grafana/data';

import { placeHolderScopedVars } from '../components/monaco-query-field/monaco-completion-provider/validation';
import { type PrometheusDatasource } from '../datasource';
import { escapeLabelValueInExactSelector } from '../escaping';
import { type PromQuery } from '../types';

import { describePrometheusQuery, QUERY_COAUTHORING_MAX_CONTEXT_LABELS } from './intelligence';
import { type QueryCoauthoringLanguage } from './queryCoauthoringContracts';
import { buildStagedQueryDiff } from './structure';

/** @internal */
export function createPrometheusCoauthoringLanguage(
  datasource: PrometheusDatasource
): QueryCoauthoringLanguage<PromQuery> {
  return {
    version: 1,
    async describe(query, { signal }) {
      const assertActive = () => {
        if (signal?.aborted) {
          throw signal.reason ?? new DOMException('Description aborted', 'AbortError');
        }
      };
      assertActive();
      const description = describePrometheusQuery(query.expr ?? '', {
        interpolate: (text) => datasource.interpolateString(text, placeHolderScopedVars),
        retrieveMetricsMetadata: () => datasource.languageProvider.retrieveMetricsMetadata(),
        queryMetricsMetadata: () => {
          assertActive();
          return datasource.lookupsDisabled ? Promise.resolve({}) : datasource.languageProvider.queryMetricsMetadata();
        },
        queryMetricLabels: (name) => {
          assertActive();
          return datasource.lookupsDisabled
            ? Promise.resolve([])
            : datasource.languageProvider.queryLabelKeys(
                getDefaultTimeRange(),
                `{__name__="${escapeLabelValueInExactSelector(name)}"}`,
                QUERY_COAUTHORING_MAX_CONTEXT_LABELS
              );
        },
      });
      if (!signal) {
        return description;
      }
      // Language-provider lookups are shared/cache-backed and have no AbortSignal API.
      // Stop waiting promptly without cancelling another consumer's lookup.
      return new Promise((resolve, reject) => {
        const abort = () => {
          signal.removeEventListener('abort', abort);
          reject(signal.reason ?? new DOMException('Description aborted', 'AbortError'));
        };
        signal.addEventListener('abort', abort, { once: true });
        description.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        if (signal.aborted) {
          abort();
        }
      });
    },
    prepare(baseline, text) {
      const original = baseline.expr ?? '';
      const diff = buildStagedQueryDiff(original, text, [], {
        originalInterpolatedQuery: datasource.interpolateString(original, placeHolderScopedVars),
        proposedInterpolatedQuery: datasource.interpolateString(text, placeHolderScopedVars),
      });
      if (!diff.valid) {
        return { status: 'rejected', reason: 'invalid' };
      }
      if (!diff.changes.length) {
        return { status: 'rejected', reason: 'unchanged' };
      }
      return {
        status: 'ready',
        query: { ...baseline, expr: text },
        changes: [
          {
            original,
            proposed: text,
            originalRanges: diff.changes.map((change) => change.originalRange),
            proposedRanges: diff.changes.map((change) => change.proposedRange),
          },
        ],
      };
    },
  };
}
