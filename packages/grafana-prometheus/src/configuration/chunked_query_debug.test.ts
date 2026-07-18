import {
  addChunkedQueryEvent,
  consumeJSONLStream,
  createChunkedQueryResult,
  createChunkedQueryURL,
} from './chunked_query_debug';

describe('chunked query debug consumer', () => {
  it('uses the plugin-specific query endpoint', () => {
    expect(createChunkedQueryURL('/grafana', 'stack/1', 'prometheus/dev')).toBe(
      '/grafana/apis/prometheus.datasource.grafana.app/v0alpha1/namespaces/stack%2F1/datasources/prometheus%2Fdev/query'
    );
  });

  it('decodes JSONL across UTF-8 and line boundaries', async () => {
    const source = new TextEncoder().encode('{"refId":"A","error":"nå"}\n{"refId":"B","frameId":"1"}\n');
    const events: unknown[] = [];
    const chunks = [source.slice(0, 25), source.slice(25, 28), source.slice(28)];
    let index = 0;
    const stream = {
      getReader: () => ({
        read: async () =>
          index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined },
      }),
    } as ReadableStream<Uint8Array>;

    await consumeJSONLStream(stream, (event) => events.push(event));

    expect(events).toEqual([{ refId: 'A', error: 'nå' }, { refId: 'B', frameId: '1' }]);
  });

  it('merges field values from repeated frame IDs and retains errors', () => {
    const result = createChunkedQueryResult();

    addChunkedQueryEvent(
      result,
      {
        refId: 'A',
        frameId: 'range/0',
        frame: { schema: { name: 'up' }, data: { values: [[1], [2]] } },
      },
      12.5
    );
    addChunkedQueryEvent(
      result,
      {
        refId: 'A',
        frameId: 'range/0',
        frame: { schema: { name: 'up' }, data: { values: [[3], [4]] } },
      },
      20
    );
    addChunkedQueryEvent(result, { refId: 'B', error: 'unsupported query' }, 25);

    expect(result.chunkCount).toBe(3);
    expect(result.firstFrameAtMs).toBe(12.5);
    expect(result.frames.get('A/range/0')?.data?.values).toEqual([
      [1, 3],
      [2, 4],
    ]);
    expect(result.errors).toEqual([{ refId: 'B', error: 'unsupported query' }]);
  });
});
