// Max number of items (metrics, labels, values) that we display as suggestions. Prevents from running out of memory.

export const PROMETHEUS_QUERY_BUILDER_MAX_RESULTS = 1000;

export const PROM_CONFIG_LABEL_WIDTH = 30;

export const LIST_ITEM_SIZE = 25;

export const LAST_USED_LABELS_KEY = 'grafana.datasources.prometheus.browser.labels';

export const DURATION_REGEX = /^$|^\d+(ms|[Mwdhmsy])$/;

export const MULTIPLE_DURATION_REGEX = /(\d+)(.+)/;

export const NON_NEGATIVE_INTEGER_REGEX = /^(0|[1-9]\d*)(\.\d+)?(e\+?\d+)?$/; // non-negative integers, including scientific notation

export const EMPTY_SELECTOR = '{}';

export const DEFAULT_SERIES_LIMIT = 40000;

export const DEFAULT_COMPLETION_LIMIT = 1000;

/**
 * Only for /series endpoint. Don't use this anywhere else as it cause an expensive query
 */
export const MATCH_ALL_LABELS = '{__name__!=""}';

export const METRIC_LABEL = '__name__';

export const durationError = 'Value is not valid, you can use number with time unit specifier: y, M, w, d, h, m, s';

export const seriesLimitError =
  'Value is not valid, you can use only numbers or leave it empty to use default limit or set 0 to have no limit.';

export const warningThresholdError = 'Value is not valid, you can use only non-negative numbers.';

export const errorThresholdError = 'Value is not valid, you can use only non-negative numbers.';

export const InstantQueryRefIdIndex = '-Instant';

export const GET_AND_POST_METADATA_ENDPOINTS = [
  'api/v1/query',
  'api/v1/query_range',
  'api/v1/series',
  'api/v1/labels',
  'suggestions',
];

/**
 * Experimental Prometheus/Mimir NDJSON streaming search API endpoints. These are the
 * allowlisted endpoints the backend stream handler is permitted to reach and the values
 * the frontend publishes over the Live channel.
 */
export const SEARCH_ENDPOINTS = {
  metricNames: 'metric_names',
  labelNames: 'label_names',
  labelValues: 'label_values',
} as const;

export type SearchEndpoint = (typeof SEARCH_ENDPOINTS)[keyof typeof SEARCH_ENDPOINTS];

/**
 * Recommended starting defaults for search-API autocomplete (from Mimir testing).
 * `sort_by=score` requires a `search[]` term; callers fall back to `alpha` for the
 * empty-search "list everything" path.
 */
export const SEARCH_API_DEFAULTS = {
  fuzzAlg: 'subsequence',
  fuzzThreshold: 50,
  caseSensitive: false,
  batchSize: 100,
  // Default result cap for the search API. Kept lower than DEFAULT_SERIES_LIMIT (40000)
  // because the search API returns scored/fuzzy autocomplete suggestions, where a tighter
  // ceiling is enough and keeps the streamed payload small. `0` still means unlimited.
  limit: 10000,
} as const;
