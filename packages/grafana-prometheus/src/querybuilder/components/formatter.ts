import { regexifyLabelValuesQueryString } from '../parsingUtils';
import { type QueryBuilderLabelFilter } from '../shared/types';

const formatPrometheusLabelFiltersToString = (
  queryString: string,
  labelsFilters: QueryBuilderLabelFilter[] | undefined
): string => {
  const filterArray = labelsFilters ? formatPrometheusLabelFilters(labelsFilters) : [];

  return `{__name__=~".*${queryString}"${filterArray ? filterArray.join('') : ''}}`;
};

export const formatPrometheusLabelFilters = (labelsFilters: QueryBuilderLabelFilter[]): string[] => {
  return labelsFilters.map((label) => {
    return `,${label.label}="${label.value}"`;
  });
};

/**
 * Reformat the query string and label filters to return all valid results for current query editor state
 */
export const formatKeyValueStrings = (query: string, labelsFilters?: QueryBuilderLabelFilter[]): string => {
  const queryString = regexifyLabelValuesQueryString(query);

  return formatPrometheusLabelFiltersToString(queryString, labelsFilters);
};

/**
 * Builds a PromQL selector from ONLY the label filters (no typed-text regex). Used by the
 * search-API path, where the typed text is routed to `search[]` instead of being
 * regexified into `match[]`. Returns '' when there are no label filters.
 */
export const formatLabelFiltersToString = (labelsFilters?: QueryBuilderLabelFilter[]): string => {
  const filterArray = labelsFilters ? formatPrometheusLabelFilters(labelsFilters) : [];
  if (filterArray.length === 0) {
    return '';
  }
  return `{${filterArray.join('').replace(/^,/, '')}}`;
};
