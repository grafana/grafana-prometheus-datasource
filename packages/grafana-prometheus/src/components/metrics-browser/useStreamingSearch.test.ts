import { act, renderHook } from '@testing-library/react';
import { Subject } from 'rxjs';

import { useStreamingSearch } from './useStreamingSearch';

describe('useStreamingSearch', () => {
  it('clears old-term results immediately before the next debounce', () => {
    jest.useFakeTimers();
    try {
      const stream = new Subject<string[]>();
      const run = jest.fn().mockReturnValue(stream);
      const { result, rerender } = renderHook(
        ({ term }) => useStreamingSearch(true, term, run),
        { initialProps: { term: 'old' } }
      );

      act(() => {
        jest.advanceTimersByTime(300);
        stream.next(['old-result']);
      });
      expect(result.current.results).toEqual(['old-result']);

      rerender({ term: 'new' });

      expect(result.current.results).toEqual([]);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
