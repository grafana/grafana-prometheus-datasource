import { regexifyLabelValuesQueryString } from '../parsingUtils';
import { renderLabels, renderLabelsWithoutBrackets } from '../shared/rendering/labels';
import { type QueryBuilderLabelFilter } from '../shared/types';

const formatPrometheusLabelFiltersToString = (
  queryString: string,
  labelsFilters: QueryBuilderLabelFilter[] | undefined
): string => {
  const filterArray = labelsFilters ? formatPrometheusLabelFilters(labelsFilters) : [];

  return `{__name__=~".*${queryString}"${filterArray ? filterArray.join('') : ''}}`;
};

export const formatPrometheusLabelFilters = (labelsFilters: QueryBuilderLabelFilter[]): string[] => {
  return renderLabelsWithoutBrackets(labelsFilters).map((label) => `,${label}`);
};

/**
 * Reformat the query string and label filters to return all valid results for current query editor state
 */
export const formatKeyValueStrings = (query: string, labelsFilters?: QueryBuilderLabelFilter[]): string => {
  const queryString = regexifyLabelValuesQueryString(query);

  return formatPrometheusLabelFiltersToString(queryString, labelsFilters);
};

export const formatLabelFiltersToString = (labelsFilters?: QueryBuilderLabelFilter[]): string => {
  return labelsFilters?.length ? renderLabels(labelsFilters) : '';
};
