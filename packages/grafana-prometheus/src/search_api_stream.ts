// Upper bound on a single NDJSON line held in memory before a newline arrives.
// A legitimate batch is capped by batch_size, so this only guards against a
// misbehaving upstream that never terminates a line. Comfortably above the
// largest realistic single-batch line (limit 10k results with metadata).
export const MAX_SEARCH_STREAM_LINE_LENGTH = 32 * 1024 * 1024;

// Every search endpoint in Prometheus rejects a request with this errorType
// when the feature flag is off, and the response carries a 500 status because
// upstream's getDefaultErrorCode does not map errorUnavailable. Real internal
// errors are also 500, so the body is the only reliable discriminator.
const UNAVAILABLE_ERROR_TYPE = 'unavailable';

// A route that was never registered (Prometheus older than 3.13), or a proxy
// that refuses the method or the path outright.
const UNAVAILABLE_STATUS_CODES = [404, 405, 501];

export interface SearchStreamResult<T> {
  results: T[];
  warnings: string[];
  hasMore: boolean;
}

interface SearchBatch<T> {
  results: T[];
  warnings?: string[];
}

interface SearchTrailer {
  status: 'success';
  has_more: boolean;
  warnings?: string[];
}

interface SearchErrorLine {
  status: 'error';
  errorType?: string;
  error?: string;
}

// Mid-stream failures keep the records already delivered to onBatch available
// to callers while still surfacing the upstream error.
export class SearchApiError<T = unknown> extends Error {
  constructor(
    message: string,
    public readonly partialResults: T[] = [],
    public readonly errorType?: string
  ) {
    super(message);
    this.name = 'SearchApiError';
  }
}

// Signals that the target does not implement the Search API at all, as opposed
// to implementing it and failing. Only this subtype is safe to fall back on;
// treating a genuine failure as absence would hide a misconfigured
// Prometheus/Mimir search feature flag.
export class SearchApiUnavailableError<T = unknown> extends SearchApiError<T> {
  constructor(message: string, partialResults: T[] = [], errorType?: string) {
    super(message, partialResults, errorType);
    this.name = 'SearchApiUnavailableError';
  }
}

// Abstracts over the transport that feeds readSearchStream so both a real
// Response.body reader (native fetch) and a getBackendSrv().chunked()
// Observable (bridged into this shape) can drive the same NDJSON parser.
export interface SearchChunkSource {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  json(): Promise<unknown>;
}

export async function readSearchStream<T>(
  source: SearchChunkSource,
  onBatch?: (results: T[]) => void,
  maxLineLength: number = MAX_SEARCH_STREAM_LINE_LENGTH
): Promise<SearchStreamResult<T>> {
  if (!source.ok) {
    let error: SearchErrorLine | undefined;
    try {
      error = (await source.json()) as SearchErrorLine;
    } catch {
      // The status text is the best available error when an upstream proxy returns a non-JSON body.
    }
    const message = error?.error || source.statusText || `Search API request failed (${source.status})`;
    if (error?.errorType === UNAVAILABLE_ERROR_TYPE || UNAVAILABLE_STATUS_CODES.includes(source.status)) {
      throw new SearchApiUnavailableError(message, [], error?.errorType);
    }
    throw new SearchApiError(message, [], error?.errorType);
  }

  const decoder = new TextDecoder();
  const results: T[] = [];
  const warnings: string[] = [];
  let hasMore = false;
  let sawTrailer = false;
  let buffer = '';

  const processLine = (line: string, tolerateIncomplete: boolean) => {
    if (!line.trim()) {
      return;
    }

    let parsed: SearchBatch<T> | SearchTrailer | SearchErrorLine;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (tolerateIncomplete) {
        // Abrupt EOF is valid for this API. Ignore only the unfinished final
        // line; malformed newline-terminated records still fail loudly.
        return;
      }
      throw error;
    }

    if ('status' in parsed) {
      if (parsed.status === 'error') {
        throw new SearchApiError(parsed.error || 'Search API request failed', results.slice(), parsed.errorType);
      }
      sawTrailer = true;
      hasMore = parsed.has_more;
      if (parsed.warnings) {
        warnings.push(...parsed.warnings);
      }
      return;
    }

    if (Array.isArray(parsed.results)) {
      results.push(...parsed.results);
      if (parsed.warnings) {
        warnings.push(...parsed.warnings);
      }
      // Incremental consumers render this batch immediately; conventional
      // callers still receive the accumulated result when the stream ends.
      onBatch?.(parsed.results);
    }
  };

  // HTTP chunk boundaries are unrelated to NDJSON line boundaries, so retain
  // the final fragment and prepend it to the next decoded chunk.
  while (true) {
    const { done, value } = await source.read();
    if (done) {
      buffer += decoder.decode();
      processLine(buffer, true);
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      processLine(line, false);
    }
    // Fail fast on an unterminated line rather than buffering without bound.
    if (buffer.length > maxLineLength) {
      throw new SearchApiError(
        `Search stream line exceeded the maximum length of ${maxLineLength} bytes`,
        results.slice()
      );
    }
  }

  // A stream that never delivered the success trailer was cut short (a dropped
  // connection is indistinguishable from a clean EOF at the byte level), so
  // callers must not treat the partial results as the complete set.
  if (!sawTrailer) {
    hasMore = true;
    warnings.push('Search stream ended before completion; results may be incomplete.');
  }

  return { results, warnings, hasMore };
}
