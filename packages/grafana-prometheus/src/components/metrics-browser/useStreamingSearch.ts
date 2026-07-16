import { useEffect, useState } from 'react';
import { type Observable, type Subscription } from 'rxjs';

/**
 * Drives a debounced, progressive server-side search for a single result list.
 *
 * While `enabled` is true and `term` is non-empty it subscribes to the Observable returned
 * by `run(term)` and exposes the accumulating emissions (so the list renders as NDJSON
 * batches stream in). When disabled or the term is empty it returns `results: null`, which
 * the caller uses as the signal to fall back to its existing client-side filtering.
 */
export function useStreamingSearch(
  enabled: boolean,
  term: string,
  run: (term: string) => Observable<string[]>,
  debounceMs = 300
): { results: string[] | null; isSearching: boolean } {
  const [results, setResults] = useState<string[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    if (!enabled || term === '') {
      setResults(null);
      setIsSearching(false);
      return;
    }

    setResults([]);
    setIsSearching(true);
    let sub: Subscription | undefined;
    const handle = setTimeout(() => {
      sub = run(term).subscribe({
        next: (vals) => setResults(vals),
        error: () => {
          // Never break autocomplete: surface whatever we have (empty) and stop spinning.
          setResults([]);
          setIsSearching(false);
        },
        complete: () => setIsSearching(false),
      });
    }, debounceMs);

    return () => {
      clearTimeout(handle);
      sub?.unsubscribe();
    };
  }, [enabled, term, run, debounceMs]);

  return { results, isSearching };
}
